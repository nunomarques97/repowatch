// Scenario data for the in-memory mock client: repositories in every state
// the dashboard and detail view show.

import type {
  Branch,
  FileChange,
  GitError,
  Head,
  LostCommit,
  RepoKind,
  Settings,
  Stash,
  Upstream,
  Worktree,
} from './types';

export type MockScenario = 'default' | 'empty' | 'noRepos' | 'many' | 'errors';

export const MOCK_SCENARIOS: readonly MockScenario[] = ['default', 'empty', 'noRepos', 'many', 'errors'];

export interface MockFile {
  path: string;
  originalPath: string | null;
  /** `untracked` until staged; `renamed` keeps `originalPath`. */
  kind: 'changed' | 'renamed' | 'conflicted' | 'untracked';
  /** Change letter shown when a side has hunks. */
  indexChange: FileChange;
  worktreeChange: FileChange;
  /** Hunk ids on each side. */
  staged: string[];
  unstaged: string[];
  binary: boolean;
}

export interface MockRepo {
  path: string;
  name: string;
  kind: RepoKind;
  head: Head;
  oid: string | null;
  upstream: Upstream | null;
  remotes: string[];
  files: MockFile[];
  stashes: Stash[];
  branches: Branch[];
  defaultBranch: string | null;
  worktrees: Worktree[];
  lost: LostCommit[];
  /** Lost commits were counted (the count shows on the dashboard). */
  lostCounted: boolean;
  lastCommit: { oid: string; time: number; subject: string } | null;
  /** Reading the repository fails with this error. */
  error: GitError | null;
}

export const DESKTOP = 'C:\\Users\\dev\\Desktop';
export const DOCUMENTS = 'C:\\Users\\dev\\Documents';
const REPOS = `${DESKTOP}\\Repositorios`;
const WORK = `${DOCUMENTS}\\work`;

/** Fixed "now" so screenshots are stable: 2026-10-04 09:00 UTC. */
export const MOCK_NOW_SECONDS = 1_791_190_800;
const HOUR = 3600;
const DAY = 24 * HOUR;

let oidCounter = 0;
/** A deterministic 40-hex object id. */
export function mockOid(seed: string): string {
  let hash = 0x811c9dc5;
  const text = `${seed}:${oidCounter++}`;
  let out = '';
  for (let round = 0; out.length < 40; round++) {
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i) + round;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    out += hash.toString(16).padStart(8, '0');
  }
  return out.slice(0, 40);
}

export function defaultSettings(scenario: MockScenario): Settings {
  return {
    roots: scenario === 'empty' ? [] : [DESKTOP, DOCUMENTS],
    excluded: [],
    theme: 'system',
    density: 'compact',
    backgroundFetch: { enabled: false, intervalMinutes: 30 },
    lostCommitWindowDays: 30,
    closeToTray: true,
  };
}

interface RepoSpec {
  name: string;
  dir?: string;
  branch?: string;
  detached?: boolean;
  unborn?: boolean;
  ahead?: number;
  behind?: number;
  /** Branch has no upstream although the repository has a remote. */
  noUpstream?: boolean;
  upstreamGone?: boolean;
  noRemote?: boolean;
  staged?: string[];
  unstaged?: string[];
  untracked?: string[];
  conflicted?: string[];
  renamed?: [string, string][];
  binary?: string[];
  stashes?: string[];
  /** Extra local branches: name and commits not in the default branch. */
  branches?: [string, number][];
  lost?: string[];
  lostCounted?: boolean;
  error?: string;
  subject?: string;
  age?: number;
  worktreeOf?: string;
  defaultBranch?: string;
}

function file(path: string, init: Partial<MockFile>): MockFile {
  return {
    path,
    originalPath: null,
    kind: 'changed',
    indexChange: 'modified',
    worktreeChange: 'modified',
    staged: [],
    unstaged: [],
    binary: false,
    ...init,
  };
}

const hunkIds = (path: string, side: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${side}-${path}-${i + 1}`);

function build(spec: RepoSpec, all: Map<string, MockRepo>): MockRepo {
  const dir = spec.dir ?? REPOS;
  const path = `${dir}\\${spec.name}`;
  const defaultBranch = spec.defaultBranch ?? 'main';
  const branchName = spec.branch ?? defaultBranch;
  const now = MOCK_NOW_SECONDS;
  const time = now - (spec.age ?? 2) * HOUR;
  const oid = spec.unborn ? null : mockOid(path);
  const remotes = spec.noRemote ? [] : ['origin'];
  const files: MockFile[] = [];
  for (const p of spec.staged ?? []) files.push(file(p, { staged: hunkIds(p, 's', 1) }));
  for (const p of spec.unstaged ?? []) {
    const existing = files.find((f) => f.path === p);
    if (existing) existing.unstaged = hunkIds(p, 'u', 2);
    else files.push(file(p, { unstaged: hunkIds(p, 'u', 2) }));
  }
  for (const p of spec.untracked ?? []) {
    files.push(file(p, { kind: 'untracked', indexChange: 'added', unstaged: hunkIds(p, 'n', 1) }));
  }
  for (const p of spec.conflicted ?? []) {
    files.push(
      file(p, { kind: 'conflicted', indexChange: 'unmerged', worktreeChange: 'unmerged', unstaged: hunkIds(p, 'c', 1) }),
    );
  }
  for (const [from, to] of spec.renamed ?? []) {
    files.push(file(to, { kind: 'renamed', originalPath: from, indexChange: 'renamed', staged: hunkIds(to, 's', 1) }));
  }
  for (const p of spec.binary ?? []) files.push(file(p, { binary: true, unstaged: [`b-${p}`] }));

  const branch = (name: string, ahead: number, extra: Partial<Branch> = {}): Branch => ({
    name,
    oid: name === branchName && oid ? oid : mockOid(`${path}/${name}`),
    isHead: !spec.detached && name === branchName,
    isDefault: name === defaultBranch,
    upstream: remotes.length && !(name === branchName && spec.noUpstream) ? `origin/${name}` : null,
    upstreamGone: name === branchName && !!spec.upstreamGone,
    commitTime: time - ahead * DAY,
    subject: name === branchName ? (spec.subject ?? 'Update') : `Work on ${name}`,
    merge: name === defaultBranch ? null : { ahead, behind: ahead ? 2 : 0 },
    ...extra,
  });
  const branches: Branch[] = spec.unborn ? [] : [branch(defaultBranch, 0)];
  if (!spec.unborn && branchName !== defaultBranch) branches.push(branch(branchName, spec.ahead ?? 1));
  for (const [name, ahead] of spec.branches ?? []) branches.push(branch(name, ahead));
  branches.sort((a, b) => a.name.localeCompare(b.name));

  let kind: RepoKind = { kind: 'main' };
  let worktrees: Worktree[] = [];
  if (spec.worktreeOf) {
    const main = all.get(spec.worktreeOf);
    const mainPath = main?.path ?? `${dir}\\${spec.worktreeOf}`;
    kind = { kind: 'linkedWorktree', commonDir: `${mainPath}\\.git`, mainPath };
    const tree = (p: string, b: string | null, isMain: boolean): Worktree => ({
      path: p,
      oid: mockOid(p),
      branch: b,
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
      isMain,
    });
    worktrees = [tree(mainPath, main?.head.kind === 'branch' ? main.head.name : 'main', true), tree(path, branchName, false)];
    if (main) main.worktrees = worktrees.map((w) => ({ ...w }));
  }

  return {
    path,
    name: spec.name,
    kind,
    head: spec.detached
      ? { kind: 'detached' }
      : spec.unborn
        ? { kind: 'unborn', name: branchName }
        : { kind: 'branch', name: branchName },
    oid,
    upstream:
      spec.unborn || spec.detached || spec.noRemote || spec.noUpstream
        ? null
        : {
            name: `origin/${branchName}`,
            ahead: spec.upstreamGone ? 0 : (spec.ahead ?? 0),
            behind: spec.upstreamGone ? 0 : (spec.behind ?? 0),
            gone: !!spec.upstreamGone,
          },
    remotes,
    files,
    stashes: (spec.stashes ?? []).map((message, index) => ({
      index,
      oid: mockOid(`${path}/stash/${index}`),
      time: now - (index + 1) * DAY,
      message: `On ${branchName}: ${message}`,
      parents: [oid ?? mockOid(path), mockOid(`${path}/stash-index/${index}`)],
    })),
    branches,
    defaultBranch: spec.unborn ? null : defaultBranch,
    worktrees,
    lost: (spec.lost ?? []).map((subject, i) => ({
      oid: mockOid(`${path}/lost/${i}`),
      parents: [oid ?? mockOid(path)],
      time: now - (i + 1) * 3 * DAY,
      author: 'Dev <dev@example.invalid>',
      subject,
      origin: i % 2 === 0 ? 'reflog' : 'dangling',
    })),
    lostCounted: !!spec.lostCounted,
    lastCommit: oid ? { oid, time, subject: spec.subject ?? 'Update' } : null,
    error: spec.error ? { kind: 'failed', code: 128, stderr: spec.error } : null,
  };
}

const DEFAULT_SPECS: RepoSpec[] = [
  {
    name: 'repowatch',
    staged: ['src/ipc/client.ts', 'src/ipc/types.ts'],
    unstaged: ['src/App.tsx', 'src/styles.css', 'README.md'],
    untracked: ['docs/notes.md'],
    binary: ['src-tauri/icons/icon.png'],
    ahead: 2,
    branches: [['feature/tray', 3]],
    stashes: ['try the lanes layout'],
    subject: 'Add the IPC client',
    age: 1,
  },
  { name: 'repowatch-tray', worktreeOf: 'repowatch', branch: 'feature/tray', unstaged: ['src-tauri/src/tray.rs'], ahead: 3 },
  { name: 'forja', ahead: 4, subject: 'Controller: retry failed checks', age: 5 },
  { name: 'site', behind: 3, subject: 'Publish October post', age: 30 },
  { name: 'notes', noRemote: true, subject: 'Weekly notes', age: 50 },
  { name: 'api', branch: 'feature/auth', noUpstream: true, ahead: 2, subject: 'Token refresh', age: 8 },
  { name: 'legacy-app', detached: true, subject: 'Release 1.4.2', age: 400 },
  { name: 'data-pipeline', conflicted: ['etl/load.py'], staged: ['etl/extract.py'], ahead: 1, behind: 1 },
  { name: 'broken-repo', error: 'fatal: bad config line 1 in file .git/config' },
  {
    name: 'design-system',
    branches: [
      ['feature/tokens', 5],
      ['spike/motion', 2],
      ['old/merged', 0],
    ],
    stashes: ['wip buttons', 'focus ring experiment'],
    subject: 'Tokens: add risk colours',
    age: 26,
  },
  { name: 'docs', subject: 'Fix typo', age: 72 },
  { name: 'tools', subject: 'Add release script', age: 200 },
  { name: 'playground', lost: ['Spike: tray badge', 'WIP on main: experiment'], subject: 'Reset experiments', age: 12 },
  { name: 'new-project', unborn: true, untracked: ['package.json', 'src/', 'README.md', '.gitignore'] },
  { name: 'mobile', dir: WORK, branch: 'release/2.0', upstreamGone: true, subject: 'Bump version', age: 90 },
  { name: 'client-portal', dir: WORK, renamed: [['src/old-name.ts', 'src/new-name.ts']], unstaged: ['package.json'] },
  { name: 'infra', dir: WORK, subject: 'Terraform 1.9', age: 100, defaultBranch: 'master' },
];

const ERROR_SPECS: RepoSpec[] = [
  { name: 'broken-repo', error: 'fatal: bad config line 1 in file .git/config' },
  {
    name: 'shared-drive',
    error:
      "fatal: detected dubious ownership in repository at 'C:/Users/dev/Desktop/Repositorios/shared-drive'",
  },
  { name: 'docs', subject: 'Fix typo', age: 72 },
  { name: 'forja', ahead: 4 },
];

function manySpecs(): RepoSpec[] {
  const states: Partial<RepoSpec>[] = [
    {},
    { ahead: 2 },
    { behind: 1 },
    { unstaged: ['src/index.ts'] },
    { untracked: ['scratch.txt'] },
    { staged: ['lib/a.rs'], ahead: 1 },
    { branches: [['feature/x', 2]] },
    { stashes: ['wip'] },
    { noRemote: true },
    { detached: true },
  ];
  return Array.from({ length: 50 }, (_, i) => ({
    name: `project-${String(i + 1).padStart(2, '0')}-${['alpha', 'beta', 'gamma', 'delta', 'epsilon'][i % 5]}`,
    subject: `Change ${i + 1}`,
    age: (i * 7) % 300,
    ...states[i % states.length],
  }));
}

export interface ScenarioData {
  settings: Settings;
  repos: MockRepo[];
  issues: { path: string; message: string }[];
}

export function scenarioData(scenario: MockScenario): ScenarioData {
  oidCounter = 0;
  const specs =
    scenario === 'default'
      ? DEFAULT_SPECS
      : scenario === 'many'
        ? manySpecs()
        : scenario === 'errors'
          ? ERROR_SPECS
          : [];
  const all = new Map<string, MockRepo>();
  for (const spec of specs) {
    all.set(spec.name, build(spec, all));
  }
  return {
    settings: defaultSettings(scenario),
    repos: [...all.values()],
    issues:
      scenario === 'errors'
        ? [{ path: `${DOCUMENTS}\\Locked`, message: 'cannot read folder: Access is denied. (os error 5)' }]
        : [],
  };
}
