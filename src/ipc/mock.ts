// In-memory RepowatchClient for UI tests and browser development. It follows
// the backend's rules: commands act only on repositories of the last scan,
// overlapping scans share one follow-up scan, one action at a time per
// repository, typed errors, fast-forward-only pull, no force push, merged
// branches only are deleted, stashes and hunks are checked for staleness.
// Every value handed out is a copy.

import { IpcError, type RepowatchClient, type Unsubscribe } from './client';
import {
  MOCK_NOW_SECONDS,
  mockOid,
  scenarioData,
  type MockFile,
  type MockRepo,
  type MockScenario,
} from './mock-data';
import type {
  AppStatus,
  AttentionLevel,
  AttentionReason,
  CommandError,
  DiffLine,
  DiffSide,
  FileDiff,
  GitError,
  Hunk,
  Reason,
  RepoDetail,
  RepoSummary,
  ScanSnapshot,
  Settings,
  StatusEntry,
} from './types';

export type MockCommand = Exclude<keyof RepowatchClient, 'onSnapshot' | 'onStatus' | 'onSettings'>;

export interface MockCall {
  command: MockCommand;
  args: unknown[];
}

export interface MockOptions {
  scenario?: MockScenario;
  /** Delay of every command, in milliseconds (default 0). */
  latencyMs?: number;
}

export interface MockClient extends RepowatchClient {
  /** Every command call, in order. */
  readonly calls: MockCall[];
  /** The next call of `command` rejects with `error` (queued per command). */
  failNext(command: MockCommand, error: CommandError): void;
  /** Calls of `command` wait until `resume(command)`. */
  pause(command: MockCommand): void;
  resume(command: MockCommand): void;
  setLatency(ms: number): void;
  /** What the next `pickFolder` returns. */
  setPickedFolder(path: string | null): void;
  /** Simulates a change on disk: the repository's file gets an unstaged change and a refresh snapshot is emitted. */
  touch(repo: string, path: string): void;
}

const LEVEL_ORDER: AttentionLevel[] = ['clean', 'branch', 'sync', 'change', 'risk'];

export function reasonLevel(reason: Reason): AttentionLevel {
  switch (reason.kind) {
    case 'scanError':
    case 'conflicts':
    case 'detachedHead':
    case 'lostCommits':
      return 'risk';
    case 'staged':
    case 'unstaged':
    case 'untracked':
      return 'change';
    case 'ahead':
    case 'behind':
    case 'noUpstream':
    case 'upstreamGone':
    case 'noRemote':
      return 'sync';
    case 'unmergedBranches':
    case 'stashes':
      return 'branch';
  }
}

const levelRank = (level: AttentionLevel) => LEVEL_ORDER.indexOf(level);

function describeGit(error: GitError): string {
  return 'stderr' in error ? error.stderr : 'message' in error ? error.message : error.kind;
}

/** Status entries of a mock repository, as `git status` would report them. */
function entries(repo: MockRepo): StatusEntry[] {
  return repo.files
    .map((f): StatusEntry | null => {
      if (f.kind === 'untracked' && f.staged.length === 0) {
        return { kind: 'untracked', path: f.path, originalPath: null, index: 'unmodified', worktree: 'unmodified' };
      }
      if (f.kind === 'conflicted') {
        return { kind: 'conflicted', path: f.path, originalPath: null, index: 'unmerged', worktree: 'unmerged' };
      }
      const index = f.staged.length ? f.indexChange : 'unmodified';
      const worktree = f.unstaged.length ? f.worktreeChange : 'unmodified';
      if (index === 'unmodified' && worktree === 'unmodified') {
        return null;
      }
      return {
        kind: f.kind === 'renamed' && f.staged.length ? 'renamed' : 'changed',
        path: f.path,
        originalPath: f.kind === 'renamed' && f.staged.length ? f.originalPath : null,
        index,
        worktree,
      };
    })
    .filter((entry): entry is StatusEntry => entry !== null);
}

function counts(repo: MockRepo) {
  const result = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  for (const entry of entries(repo)) {
    if (entry.kind === 'untracked') result.untracked++;
    else if (entry.kind === 'conflicted') result.conflicted++;
    else {
      if (entry.index !== 'unmodified') result.staged++;
      if (entry.worktree !== 'unmodified') result.unstaged++;
    }
  }
  return result;
}

/** The backend's reasons, in the same order (RepoSummary::reasons). */
function reasons(repo: MockRepo): Reason[] {
  if (repo.error) {
    return [{ kind: 'scanError', message: describeGit(repo.error) }];
  }
  const c = counts(repo);
  const out: Reason[] = [];
  if (c.conflicted) out.push({ kind: 'conflicts', count: c.conflicted });
  if (repo.head.kind === 'detached') out.push({ kind: 'detachedHead' });
  if (repo.lostCounted && repo.lost.length) out.push({ kind: 'lostCommits', count: repo.lost.length });
  if (c.staged) out.push({ kind: 'staged', count: c.staged });
  if (c.unstaged) out.push({ kind: 'unstaged', count: c.unstaged });
  if (c.untracked) out.push({ kind: 'untracked', count: c.untracked });
  if (repo.upstream?.ahead) out.push({ kind: 'ahead', count: repo.upstream.ahead });
  if (repo.upstream?.behind) out.push({ kind: 'behind', count: repo.upstream.behind });
  const hasRemote = repo.remotes.length > 0;
  if (repo.head.kind === 'branch' && hasRemote && !repo.upstream) out.push({ kind: 'noUpstream' });
  if (repo.upstream?.gone) out.push({ kind: 'upstreamGone' });
  if (repo.oid && !hasRemote) out.push({ kind: 'noRemote' });
  const unmerged = repo.branches.filter((b) => (b.merge?.ahead ?? 0) > 0).length;
  if (unmerged) out.push({ kind: 'unmergedBranches', count: unmerged });
  if (repo.stashes.length) out.push({ kind: 'stashes', count: repo.stashes.length });
  return out;
}

export function summarize(repo: MockRepo): RepoSummary {
  const list: AttentionReason[] = reasons(repo)
    .map((reason) => ({ ...reason, level: reasonLevel(reason) }))
    // Stable sort: same level keeps the reason order.
    .sort((a, b) => levelRank(b.level) - levelRank(a.level));
  const level = list[0]?.level ?? 'clean';
  const broken = repo.error !== null;
  return {
    path: repo.path,
    name: repo.name,
    kind: structuredClone(repo.kind),
    head: broken ? null : structuredClone(repo.head),
    oid: broken ? null : repo.oid,
    upstream: broken ? null : structuredClone(repo.upstream),
    remotes: broken ? [] : [...repo.remotes],
    counts: broken ? { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 } : counts(repo),
    stashCount: broken ? 0 : repo.stashes.length,
    lastCommit: broken ? null : structuredClone(repo.lastCommit),
    defaultBranch:
      broken || !repo.defaultBranch
        ? null
        : { name: repo.defaultBranch, source: 'originHead', local: true, remote: repo.remotes.length ? `origin/${repo.defaultBranch}` : null },
    branchCount: broken ? 0 : repo.branches.length,
    unmergedBranches: broken ? [] : structuredClone(repo.branches.filter((b) => (b.merge?.ahead ?? 0) > 0)),
    worktrees: broken ? [] : structuredClone(repo.worktrees),
    lostCommits: repo.lostCounted ? repo.lost.length : null,
    error: structuredClone(repo.error),
    attention: { level, needsAttention: level !== 'clean', reasons: list },
  };
}

/** Dashboard order: most severe first, then name ignoring case, then path. */
export function attentionOrder(a: RepoSummary, b: RepoSummary): number {
  return (
    levelRank(b.attention.level) - levelRank(a.attention.level) ||
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
    a.path.localeCompare(b.path)
  );
}

function diffLines(path: string, hunkId: string, kind: 'modify' | 'add', start: number): DiffLine[] {
  const seed = `${path}#${hunkId}`;
  if (kind === 'add') {
    return [0, 1, 2].map((i) => ({
      kind: 'added',
      text: i === 0 ? `// ${path}` : `export const line${i} = '${seed.length + i}';`,
      oldLine: null,
      newLine: start + i,
    }));
  }
  return [
    { kind: 'context', text: `function section${start}() {`, oldLine: start, newLine: start },
    { kind: 'removed', text: `  return '${path}';`, oldLine: start + 1, newLine: null },
    { kind: 'added', text: `  return '${path}' + ${JSON.stringify(hunkId)};`, oldLine: null, newLine: start + 1 },
    { kind: 'context', text: '}', oldLine: start + 2, newLine: start + 2 },
  ];
}

function hunkFor(f: MockFile, id: string, position: number, kind: 'modify' | 'add'): Hunk {
  const start = 1 + position * 20;
  const lines = diffLines(f.path, id, kind, start);
  const oldLines = lines.filter((l) => l.kind !== 'added').length;
  const newLines = lines.filter((l) => l.kind !== 'removed').length;
  return {
    id,
    header: kind === 'add' ? `@@ -0,0 +1,${newLines} @@` : `@@ -${start},${oldLines} +${start},${newLines} @@ section${start}`,
    oldStart: kind === 'add' ? 0 : start,
    oldLines: kind === 'add' ? 0 : oldLines,
    newStart: start,
    newLines,
    lines,
  };
}

const hasControl = (text: string) => [...text].some((char) => char < ' ' || char === '');

const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

function sameFolder(a: string, b: string) {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
  return norm(a) === norm(b);
}

function inside(path: string, folder: string) {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
  const f = norm(folder);
  const p = norm(path);
  return p === f || p.startsWith(`${f}\\`);
}

function validateSettings(settings: Settings): Settings {
  const invalid = (field: string, reason: string): never => {
    throw new IpcError({ kind: 'invalidSettings', field, reason });
  };
  const paths = (field: string, list: string[]) => {
    if (list.length > 64) invalid(field, 'at most 64 folders');
    const out: string[] = [];
    for (const raw of list) {
      const path = raw.trim();
      if (!path) invalid(field, 'a folder is empty');
      if (hasControl(path)) invalid(field, 'a folder contains control characters');
      if (!ABSOLUTE.test(path)) invalid(field, `${path} is not an absolute path`);
      if (!out.some((known) => sameFolder(known, path))) out.push(path);
    }
    return out;
  };
  const { intervalMinutes } = settings.backgroundFetch;
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 1440) {
    invalid('backgroundFetch.intervalMinutes', 'must be between 5 and 1440');
  }
  const days = settings.lostCommitWindowDays;
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    invalid('lostCommitWindowDays', 'must be between 1 and 365');
  }
  return {
    ...structuredClone(settings),
    roots: paths('roots', settings.roots),
    excluded: paths('excluded', settings.excluded),
  };
}

function validBranchName(name: string): GitError | null {
  const invalid = (reason: string): GitError => ({ kind: 'invalidInput', field: 'branch name', reason });
  if (!name) return invalid('is empty');
  if (name.startsWith('-')) return invalid('must not start with -');
  if (/[\s~^:?*[\\]/.test(name) || hasControl(name) || name.includes('..') || name.includes('@{')) {
    return invalid('is not a valid git branch name');
  }
  if (name.endsWith('/') || name.endsWith('.lock') || name.startsWith('/') || name === '@') {
    return invalid('is not a valid git branch name');
  }
  return null;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createMockClient(options: MockOptions = {}): MockClient {
  const data = scenarioData(options.scenario ?? 'default');
  let settings = data.settings;
  const allRepos = data.repos;
  let latency = options.latencyMs ?? 0;
  let pickedFolder: string | null = 'C:\\Users\\dev\\Projects';
  let generation = 0;
  let snapshot: ScanSnapshot | null = null;
  let status: AppStatus = { scanning: false, watchedRepos: 0, backgroundFetchRunning: false, lastBackgroundFetchAt: null };
  const calls: MockCall[] = [];
  const failures = new Map<MockCommand, CommandError[]>();
  const paused = new Map<MockCommand, Array<() => void>>();
  const busy = new Set<string>();
  const listeners = {
    snapshot: new Set<(value: ScanSnapshot) => void>(),
    status: new Set<(value: AppStatus) => void>(),
    settings: new Set<(value: Settings) => void>(),
  };

  // Events are delivered asynchronously, like Tauri's, each with its own copy.
  const deliver = <T,>(set: Set<(value: T) => void>, value: T) => {
    for (const handler of [...set]) {
      queueMicrotask(() => {
        if (set.has(handler)) handler(structuredClone(value));
      });
    }
  };

  const setStatus = (change: Partial<AppStatus>) => {
    const next = { ...status, ...change };
    if (JSON.stringify(next) !== JSON.stringify(status)) {
      status = next;
      deliver(listeners.status, status);
    }
  };

  /** Repositories under the roots and outside the exclusions. */
  const visibleRepos = () =>
    allRepos.filter(
      (repo) =>
        settings.roots.some((root) => inside(repo.path, root)) &&
        !settings.excluded.some((folder) => inside(repo.path, folder)),
    );

  const publish = (full: boolean): ScanSnapshot => {
    const previous = snapshot;
    const scanned = full ? visibleRepos() : allRepos.filter((repo) => previous?.repos.some((r) => r.path === repo.path));
    generation += 1;
    snapshot = {
      generation,
      scannedAt: full || !previous ? MOCK_NOW_SECONDS * 1000 + generation : previous.scannedAt,
      durationMs: full || !previous ? 180 + scanned.length * 9 : previous.durationMs,
      roots: [...settings.roots],
      repos: scanned.map(summarize).sort(attentionOrder),
      issues: settings.roots.length ? structuredClone(data.issues) : [],
      attentionCount: 0,
    };
    snapshot.attentionCount = snapshot.repos.filter((r) => r.attention.needsAttention).length;
    if (full) setStatus({ watchedRepos: snapshot.repos.length });
    deliver(listeners.snapshot, snapshot);
    return snapshot;
  };

  /** Mirrors Scanner::resolve: exact paths of the last scan only. */
  const resolve = (path: string): MockRepo => {
    const known = snapshot?.repos.some((r) => r.path === path);
    const repo = known ? allRepos.find((r) => r.path === path) : undefined;
    if (!repo) {
      throw new IpcError({ kind: 'unknownRepo', path: String(path).slice(0, 300) });
    }
    return repo;
  };

  const gitError = (error: GitError): never => {
    throw new IpcError({ kind: 'git', error });
  };

  const readable = (repo: MockRepo) => {
    if (repo.error) gitError(repo.error);
    return repo;
  };

  async function gate(command: MockCommand, args: unknown[]) {
    calls.push({ command, args: structuredClone(args) });
    if (latency > 0) await delay(latency);
    const waiting = paused.get(command);
    if (waiting) await new Promise<void>((resolve) => waiting.push(resolve));
    const failure = failures.get(command)?.shift();
    if (failure) throw new IpcError(failure);
  }

  async function run<T>(command: MockCommand, args: unknown[], work: () => T): Promise<T> {
    await gate(command, args);
    return structuredClone(work());
  }

  /** A write action: one at a time per repository, refreshed afterwards. */
  async function act(command: MockCommand, repoPath: string, args: unknown[], work: (repo: MockRepo) => void) {
    calls.push({ command, args: structuredClone([repoPath, ...args]) });
    const repo = resolve(repoPath);
    if (busy.has(repoPath)) {
      throw new IpcError({ kind: 'busy', path: repoPath });
    }
    busy.add(repoPath);
    try {
      if (latency > 0) await delay(latency);
      const waiting = paused.get(command);
      if (waiting) await new Promise<void>((resolve) => waiting.push(resolve));
      const failure = failures.get(command)?.shift();
      if (failure) throw new IpcError(failure);
      work(readable(repo));
    } finally {
      busy.delete(repoPath);
      // Refreshed after success and failure, like the backend.
      if (snapshot) publish(false);
    }
  }

  let running: Promise<ScanSnapshot> | null = null;
  let queued: Promise<ScanSnapshot> | null = null;

  const runScan = (): Promise<ScanSnapshot> => {
    setStatus({ scanning: true });
    running = delay(latency)
      .then(() => structuredClone(publish(true)))
      .finally(() => {
        running = null;
        setStatus({ scanning: queued !== null });
      });
    return running;
  };

  /** Overlapping requests share one follow-up scan, like the backend. */
  const requestScan = (): Promise<ScanSnapshot> => {
    if (queued) return queued;
    if (!running) return runScan();
    queued = running
      .catch(() => undefined)
      .then(() => {
        queued = null;
        return runScan();
      });
    return queued;
  };

  const head = (repo: MockRepo) => repo.head;
  const currentBranch = (repo: MockRepo): string => {
    const h = head(repo);
    if (h.kind === 'detached') gitError({ kind: 'detachedHead' });
    return (h as { name: string }).name;
  };

  const fileOf = (repo: MockRepo, path: string): MockFile => {
    const found = repo.files.find((f) => f.path === path);
    if (!found) gitError({ kind: 'invalidInput', field: 'path', reason: `${path} has no changes` });
    return found as MockFile;
  };

  const sideOf = (f: MockFile, side: DiffSide): string[] => (side === 'staged' ? f.staged : f.unstaged);

  const client: MockClient = {
    calls,
    failNext(command, error) {
      const queue = failures.get(command) ?? [];
      queue.push(structuredClone(error));
      failures.set(command, queue);
    },
    pause(command) {
      if (!paused.has(command)) paused.set(command, []);
    },
    resume(command) {
      const waiting = paused.get(command) ?? [];
      paused.delete(command);
      for (const release of waiting) release();
    },
    setLatency(ms) {
      latency = ms;
    },
    setPickedFolder(path) {
      pickedFolder = path;
    },
    touch(repoPath, path) {
      const repo = allRepos.find((r) => r.path === repoPath);
      if (!repo) return;
      const existing = repo.files.find((f) => f.path === path);
      if (existing) {
        if (!existing.unstaged.length) existing.unstaged = [`u-${path}-${Date.now()}`];
      } else {
        repo.files.push({
          path,
          originalPath: null,
          kind: 'changed',
          indexChange: 'modified',
          worktreeChange: 'modified',
          staged: [],
          unstaged: [`u-${path}-1`],
          binary: false,
        });
      }
      if (snapshot) publish(false);
    },

    appInfo: () =>
      run('appInfo', [], () => ({
        version: '0.1.0',
        coreVersion: '0.1.0',
        configDir: 'C:\\Users\\dev\\AppData\\Roaming\\io.github.nunomarques97.repowatch',
      })),
    getSettings: () => run('getSettings', [], () => settings),
    async updateSettings(next) {
      await gate('updateSettings', [next]);
      const valid = validateSettings(next);
      const rescan =
        JSON.stringify(valid.roots) !== JSON.stringify(settings.roots) ||
        JSON.stringify(valid.excluded) !== JSON.stringify(settings.excluded);
      settings = valid;
      deliver(listeners.settings, settings);
      if (rescan) void requestScan();
      return structuredClone(settings);
    },
    getStatus: () => run('getStatus', [], () => status),
    getSnapshot: () => run('getSnapshot', [], () => snapshot),
    async scan() {
      await gate('scan', []);
      return requestScan();
    },

    repoDetail: (repoPath) =>
      run('repoDetail', [repoPath], (): RepoDetail => {
        const repo = readable(resolve(repoPath));
        const summary = summarize(repo);
        return {
          path: repo.path,
          name: repo.name,
          kind: repo.kind,
          status: {
            path: repo.path,
            remotes: repo.remotes,
            oid: repo.oid,
            head: repo.head,
            upstream: repo.upstream,
            stashCount: repo.stashes.length,
            counts: summary.counts,
            entries: entries(repo),
          },
          branches: {
            defaultBranch: summary.defaultBranch,
            branches: repo.branches,
          },
          stashes: repo.stashes,
          worktrees: repo.worktrees,
        };
      }),
    fileDiff: (repoPath, path, side) =>
      run('fileDiff', [repoPath, path, side], (): FileDiff => {
        const repo = readable(resolve(repoPath));
        const f = repo.files.find((candidate) => candidate.path === path);
        const untracked = f?.kind === 'untracked' && f.staged.length === 0;
        if (!f || (side === 'untracked') !== untracked) {
          return { path, side, binary: false, hunks: [], truncated: false };
        }
        const ids = side === 'staged' ? f.staged : f.unstaged;
        const kind = f.kind === 'untracked' ? 'add' : 'modify';
        return {
          path,
          side,
          binary: f.binary,
          hunks: f.binary ? [] : ids.map((id, i) => hunkFor(f, id, i, kind)),
          truncated: false,
        };
      }),
    async lostCommits(repoPath) {
      await gate('lostCommits', [repoPath]);
      const repo = readable(resolve(repoPath));
      const window = settings.lostCommitWindowDays;
      const cutoff = MOCK_NOW_SECONDS - window * 86_400;
      const changed = !repo.lostCounted;
      repo.lostCounted = true;
      if (changed) publish(false);
      return structuredClone({
        commits: repo.lost.filter((c) => c.time >= cutoff),
        windowDays: window,
        truncated: false,
      });
    },

    stageFile: (repoPath, path) =>
      act('stageFile', repoPath, [path], (repo) => {
        const f = fileOf(repo, path);
        f.staged = [...f.staged, ...f.unstaged];
        f.unstaged = [];
        if (f.kind === 'conflicted') f.kind = 'changed';
      }),
    unstageFile: (repoPath, path) =>
      act('unstageFile', repoPath, [path], (repo) => {
        const f = fileOf(repo, path);
        f.unstaged = [...f.unstaged, ...f.staged];
        f.staged = [];
      }),
    stageHunk: (repoPath, path, hunkId) =>
      act('stageHunk', repoPath, [path, hunkId], (repo) => {
        const f = fileOf(repo, path);
        if (f.binary || !f.unstaged.includes(hunkId)) gitError({ kind: 'stale', what: 'the diff' });
        f.unstaged = f.unstaged.filter((id) => id !== hunkId);
        f.staged = [...f.staged, hunkId];
      }),
    unstageHunk: (repoPath, path, hunkId) =>
      act('unstageHunk', repoPath, [path, hunkId], (repo) => {
        const f = fileOf(repo, path);
        if (f.binary || !sideOf(f, 'staged').includes(hunkId)) gitError({ kind: 'stale', what: 'the diff' });
        f.staged = f.staged.filter((id) => id !== hunkId);
        f.unstaged = [...f.unstaged, hunkId];
      }),
    commit: (repoPath, message) =>
      act('commit', repoPath, [message], (repo) => {
        if (!message.trim()) gitError({ kind: 'invalidInput', field: 'commit message', reason: 'is empty' });
        if (!repo.files.some((f) => f.staged.length)) gitError({ kind: 'nothingToCommit' });
        const branch = repo.head.kind === 'detached' ? null : repo.head.name;
        repo.files = repo.files
          .map((f) => ({ ...f, staged: [], kind: f.kind === 'untracked' && f.staged.length ? ('changed' as const) : f.kind }))
          .filter((f) => f.unstaged.length > 0);
        repo.oid = mockOid(`${repo.path}/commit`);
        repo.lastCommit = { oid: repo.oid, time: MOCK_NOW_SECONDS, subject: message.split('\n')[0] ?? message };
        if (repo.head.kind === 'unborn') {
          repo.head = { kind: 'branch', name: repo.head.name };
          repo.defaultBranch = repo.head.name;
        }
        if (repo.upstream) repo.upstream.ahead += 1;
        const own = repo.branches.find((b) => b.name === branch);
        if (own && repo.oid) {
          own.oid = repo.oid;
          own.subject = repo.lastCommit.subject;
          if (own.merge) own.merge.ahead += 1;
        } else if (branch && repo.oid) {
          repo.branches.push({
            name: branch,
            oid: repo.oid,
            isHead: true,
            isDefault: branch === repo.defaultBranch,
            upstream: null,
            upstreamGone: false,
            commitTime: MOCK_NOW_SECONDS,
            subject: repo.lastCommit.subject,
            merge: null,
          });
        }
      }),
    fetch: (repoPath) =>
      act('fetch', repoPath, [], (repo) => {
        if (!repo.remotes.length) gitError({ kind: 'noRemote' });
      }),
    pull: (repoPath) =>
      act('pull', repoPath, [], (repo) => {
        const branch = currentBranch(repo);
        if (!repo.upstream) gitError({ kind: 'noUpstream', branch });
        const upstream = repo.upstream!;
        if (upstream.ahead > 0 && upstream.behind > 0) gitError({ kind: 'notFastForward' });
        upstream.behind = 0;
      }),
    push: (repoPath) =>
      act('push', repoPath, [], (repo) => {
        const branch = currentBranch(repo);
        if (!repo.remotes.length) gitError({ kind: 'noRemote' });
        if (repo.upstream?.behind) {
          gitError({ kind: 'pushRejected', stderr: ` ! [rejected]        ${branch} -> ${branch} (fetch first)` });
        }
        repo.upstream = { name: repo.upstream?.name ?? `origin/${branch}`, ahead: 0, behind: 0, gone: false };
        const own = repo.branches.find((b) => b.name === branch);
        if (own) own.upstream = repo.upstream.name;
      }),
    createBranch: (repoPath, name, start) =>
      act('createBranch', repoPath, [name, start], (repo) => {
        const invalid = validBranchName(name);
        if (invalid) gitError(invalid);
        if (start !== undefined && !/^[0-9a-f]{40}$/i.test(start)) {
          gitError({ kind: 'invalidInput', field: 'object id', reason: 'must be a full hexadecimal object id' });
        }
        if (repo.branches.some((b) => b.name === name)) gitError({ kind: 'branchExists', branch: name });
        if (!repo.oid && !start) gitError({ kind: 'failed', code: 128, stderr: "fatal: not a valid object name: 'HEAD'" });
        repo.branches.push({
          name,
          oid: start ?? repo.oid!,
          isHead: false,
          isDefault: false,
          upstream: null,
          upstreamGone: false,
          commitTime: MOCK_NOW_SECONDS,
          subject: repo.lastCommit?.subject ?? '',
          merge: { ahead: 0, behind: 0 },
        });
        repo.branches.sort((a, b) => a.name.localeCompare(b.name));
      }),
    switchBranch: (repoPath, name) =>
      act('switchBranch', repoPath, [name], (repo) => {
        const invalid = validBranchName(name);
        if (invalid) gitError(invalid);
        const target = repo.branches.find((b) => b.name === name);
        if (!target) gitError({ kind: 'failed', code: 128, stderr: `fatal: invalid reference: ${name}` });
        for (const b of repo.branches) b.isHead = b.name === name;
        repo.head = { kind: 'branch', name };
        repo.oid = target!.oid;
        repo.upstream = target!.upstream
          ? { name: target!.upstream, ahead: target!.merge?.ahead ?? 0, behind: 0, gone: target!.upstreamGone }
          : null;
      }),
    deleteBranch: (repoPath, name) =>
      act('deleteBranch', repoPath, [name], (repo) => {
        const invalid = validBranchName(name);
        if (invalid) gitError(invalid);
        const target = repo.branches.find((b) => b.name === name);
        const reason = (text: string): GitError => ({ kind: 'invalidInput', field: 'branch name', reason: text });
        if (!target) gitError(reason('no such local branch'));
        if (target!.isHead) gitError(reason('is the current branch'));
        if (target!.isDefault) gitError(reason('is the default branch'));
        if ((target!.merge?.ahead ?? 0) > 0) gitError({ kind: 'branchNotMerged', branch: name });
        repo.branches = repo.branches.filter((b) => b.name !== name);
      }),
    applyStash: (repoPath, index, oid) =>
      act('applyStash', repoPath, [index, oid], (repo) => {
        const stash = repo.stashes.find((s) => s.index === index);
        if (!stash || stash.oid.toLowerCase() !== oid.toLowerCase()) gitError({ kind: 'stale', what: 'the stash list' });
        const path = `stash-${index}.txt`;
        if (!repo.files.some((f) => f.path === path)) {
          repo.files.push({
            path,
            originalPath: null,
            kind: 'changed',
            indexChange: 'modified',
            worktreeChange: 'modified',
            staged: [],
            unstaged: [`u-${path}-1`],
            binary: false,
          });
        }
      }),
    dropStash: (repoPath, index, oid) =>
      act('dropStash', repoPath, [index, oid], (repo) => {
        const stash = repo.stashes.find((s) => s.index === index);
        if (!stash || stash.oid.toLowerCase() !== oid.toLowerCase()) gitError({ kind: 'stale', what: 'the stash list' });
        repo.stashes = repo.stashes.filter((s) => s.index !== index).map((s, i) => ({ ...s, index: i }));
        repo.lost.unshift({
          oid: stash!.oid,
          parents: stash!.parents,
          time: stash!.time,
          author: 'Dev <dev@example.invalid>',
          subject: stash!.message,
          origin: 'dangling',
        });
      }),
    recoverCommit: (repoPath, oid, branch) =>
      act('recoverCommit', repoPath, [oid, branch], (repo) => {
        if (!/^[0-9a-f]{40}$/i.test(oid)) {
          gitError({ kind: 'invalidInput', field: 'object id', reason: 'must be a full hexadecimal object id' });
        }
        const invalid = validBranchName(branch);
        if (invalid) gitError(invalid);
        if (repo.branches.some((b) => b.name === branch)) gitError({ kind: 'branchExists', branch });
        const lost = repo.lost.find((c) => c.oid === oid);
        repo.lost = repo.lost.filter((c) => c.oid !== oid);
        repo.branches.push({
          name: branch,
          oid,
          isHead: false,
          isDefault: false,
          upstream: null,
          upstreamGone: false,
          commitTime: lost?.time ?? MOCK_NOW_SECONDS,
          subject: lost?.subject ?? '',
          merge: { ahead: 1, behind: 0 },
        });
        repo.branches.sort((a, b) => a.name.localeCompare(b.name));
      }),
    async openRepo(repoPath, target) {
      await gate('openRepo', [repoPath, target]);
      resolve(repoPath);
    },
    async pickFolder() {
      await gate('pickFolder', []);
      return pickedFolder;
    },

    onSnapshot: (handler) => subscribe(listeners.snapshot, handler),
    onStatus: (handler) => subscribe(listeners.status, handler),
    onSettings: (handler) => subscribe(listeners.settings, handler),
  };

  function subscribe<T>(set: Set<(value: T) => void>, handler: (value: T) => void): Unsubscribe {
    // A wrapper so the same handler can subscribe twice independently.
    const own = (value: T) => handler(value);
    set.add(own);
    return () => {
      set.delete(own);
    };
  }

  return client;
}
