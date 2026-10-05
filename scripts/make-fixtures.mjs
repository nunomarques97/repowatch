#!/usr/bin/env node
// Creates fixture git repositories that cover every state Repowatch shows:
// clean, staged / unstaged / untracked / conflicted changes, ahead, behind,
// diverged, no upstream, upstream gone, no remote, detached HEAD, unmerged
// branches, stashes, linked worktrees, lost commits (deleted branch, hard
// reset, dangling, outside the window), an empty repository, origin/HEAD /
// master / no default branch, odd file names and a broken repository. Remotes are local bare repositories, so
// nothing touches the network.
//
// Usage: node scripts/make-fixtures.mjs [--out <dir>] [--count <n>] [--quiet]
//
//   --out    Target folder. It must be inside the OS temp folder; any other
//            target is refused. An existing folder is replaced only when it
//            is empty or was created by this script (it holds the marker
//            file). Default: a new folder in the OS temp folder.
//   --count  Minimum number of discoverable repositories. Extra "bulk"
//            repositories in simple states are added to reach it.
//   --quiet  Print only the manifest path.
//
// Layout: <out>/repos is the discovery root, <out>/repos/remotes holds the
// bare remotes, <out>/work holds helper clones (outside the root), and
// <out>/fixtures.json describes every repository.
//
// Git runs without a shell and with an isolated configuration: no system or
// global config, a fixture HOME and XDG folder, and GIT_CEILING_DIRECTORIES
// so it can never find a repository above the target.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARKER = '.repowatch-fixtures';
const WINDOWS = process.platform === 'win32';

// Simple states used to pad the set up to --count.
const BULK_STATES = [
  'clean',
  'staged',
  'unstaged',
  'untracked',
  'mixed',
  'ahead',
  'behind',
  'diverged',
  'no-upstream',
  'no-remote',
  'stashes',
  'detached',
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const out = prepareTarget(options.out);
  const ctx = createContext(out);

  const scenarios = [];
  const add = (name, build, info) => scenarios.push({ name, build, ...info });
  for (const [name, info] of Object.entries(SCENARIOS)) {
    add(name, info.build, { states: info.states });
  }

  await runPool(scenarios, 6, (scenario) => scenario.build(ctx, path.join(ctx.root, scenario.name)));
  await buildHiddenRepos(ctx);

  const discoverable = expectedDiscovered(ctx, scenarios);
  const bulk = [];
  for (let i = 0; discoverable.length + bulk.length < options.count; i += 1) {
    const state = BULK_STATES[i % BULK_STATES.length];
    const name = `bulk-${String(i + 1).padStart(3, '0')}-${state}`;
    bulk.push({ name, state, dir: path.join(ctx.root, 'bulk', name) });
  }
  await runPool(bulk, 6, (item) => SCENARIOS[item.state].build(ctx, item.dir, item.name));

  const manifest = {
    version: 1,
    root: ctx.root,
    remotes: ctx.remotes,
    repositories: [
      ...scenarios.map((s) => ({ name: s.name, path: path.join(ctx.root, s.name), states: s.states })),
      ...bulk.map((b) => ({ name: b.name, path: b.dir, states: SCENARIOS[b.state].states })),
    ],
    expectedDiscovered: [...discoverable, ...bulk.map((b) => b.dir)].sort(),
    hidden: ctx.hidden.sort(),
  };
  const manifestPath = path.join(out, 'fixtures.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (!options.quiet) {
    console.log(`Created ${manifest.expectedDiscovered.length} discoverable repositories in ${ctx.root}`);
  }
  console.log(manifestPath);
}

function parseArgs(argv) {
  const options = { out: null, count: 0, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      options.out = argv[++i];
      if (!options.out) throw new Error('--out needs a folder');
    } else if (arg === '--count') {
      options.count = Number(argv[++i]);
      if (!Number.isInteger(options.count) || options.count < 0 || options.count > 1000) {
        throw new Error('--count must be an integer between 0 and 1000');
      }
    } else if (arg === '--quiet') {
      options.quiet = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

// Resolves the target and refuses anything outside the OS temp folder.
function prepareTarget(requested) {
  const temp = fs.realpathSync.native(os.tmpdir());
  if (!requested) return fs.mkdtempSync(path.join(temp, 'repowatch-fixtures-'));

  const target = realTarget(path.resolve(requested));
  if (!isStrictlyInside(target, temp)) {
    throw new Error(`refusing ${target}: fixtures are created only inside the OS temp folder (${temp})`);
  }
  const stat = lstatOrNull(target);
  if (stat) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`refusing ${target}: not a plain folder`);
    const entries = fs.readdirSync(target);
    if (entries.length > 0 && !entries.includes(MARKER)) {
      throw new Error(`refusing ${target}: folder is not empty and was not created by this script`);
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, MARKER), 'Created by scripts/make-fixtures.mjs. Safe to delete.\n');
  return target;
}

// Real path of the nearest existing ancestor joined with the missing rest,
// so a junction or symlink inside temp cannot lead outside it.
function realTarget(target) {
  const rest = [];
  let current = target;
  while (!lstatOrNull(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    rest.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync.native(current), ...rest);
}

function isStrictlyInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function createContext(out) {
  const gitEnvDir = path.join(out, 'git-env');
  const home = path.join(gitEnvDir, 'home');
  const xdg = path.join(gitEnvDir, 'xdg');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });
  const config = path.join(gitEnvDir, 'gitconfig');
  fs.writeFileSync(
    config,
    [
      '[user]',
      '\tname = Repowatch Fixtures',
      '\temail = fixtures@repowatch.invalid',
      '[init]',
      '\tdefaultBranch = main',
      '[core]',
      '\tautocrlf = false',
      '\tfsmonitor = false',
      '\tlongpaths = true',
      '[commit]',
      '\tgpgSign = false',
      '[tag]',
      '\tgpgSign = false',
      '[gc]',
      '\tauto = 0',
      '[maintenance]',
      '\tauto = false',
      '[advice]',
      '\tdetachedHead = false',
      '[merge]',
      '\tconflictStyle = merge',
      '',
    ].join('\n'),
  );

  // Drop every inherited GIT_* variable (GIT_DIR, GIT_WORK_TREE, ...) so the
  // caller's environment cannot redirect a command to another repository.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: config,
    GIT_CEILING_DIRECTORIES: out,
    GIT_TERMINAL_PROMPT: '0',
    HOME: home,
    XDG_CONFIG_HOME: xdg,
    LC_ALL: 'C',
  });

  const root = path.join(out, 'repos');
  const remotes = path.join(root, 'remotes');
  const work = path.join(out, 'work');
  for (const dir of [root, remotes, work]) fs.mkdirSync(dir, { recursive: true });
  return { out, root, remotes, work, env, hidden: [] };
}

function assertInside(ctx, target) {
  if (!isStrictlyInside(path.resolve(target), ctx.out)) {
    throw new Error(`internal error: ${target} is outside the fixture folder`);
  }
}

function git(ctx, cwd, args, { allowFailure = false, env = {} } = {}) {
  assertInside(ctx, cwd);
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, env: { ...ctx.env, ...env }, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !allowFailure) {
          reject(new Error(`git ${args.join(' ')} failed in ${cwd}: ${stderr.trim() || error.message}`));
        } else {
          resolve({ stdout, stderr, failed: Boolean(error) });
        }
      },
    );
  });
}

function write(ctx, file, content) {
  assertInside(ctx, file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

async function initRepo(ctx, dir, branch = 'main') {
  assertInside(ctx, dir);
  fs.mkdirSync(dir, { recursive: true });
  await git(ctx, dir, ['init', '-q', '-b', branch]);
}

async function commitFiles(ctx, dir, message, files, { date } = {}) {
  for (const [name, content] of Object.entries(files)) write(ctx, path.join(dir, name), content);
  await git(ctx, dir, ['add', '-A']);
  const env = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {};
  await git(ctx, dir, ['commit', '-q', '-m', message], { env });
}

// A repository with two commits on `branch`.
async function seeded(ctx, dir, branch = 'main') {
  await initRepo(ctx, dir, branch);
  await commitFiles(ctx, dir, 'Initial commit', {
    'README.md': '# Fixture\n',
    'src/app.txt': 'app v1\n',
    'notes.txt': 'notes v1\n',
  });
  await commitFiles(ctx, dir, 'Add changelog', { 'CHANGELOG.md': '- first\n' });
}

// Adds a bare remote named after the repository and pushes `branch` with an
// upstream. Returns the bare remote path.
async function addRemote(ctx, dir, name, branch = 'main') {
  const bare = path.join(ctx.remotes, `${name}.git`);
  await git(ctx, ctx.remotes, ['init', '-q', '--bare', '-b', branch, bare]);
  await git(ctx, dir, ['remote', 'add', 'origin', bare]);
  await git(ctx, dir, ['push', '-q', '-u', 'origin', branch]);
  return bare;
}

// Pushes `count` new commits to the remote from a helper clone outside the
// discovery root.
async function pushFromElsewhere(ctx, bare, name, count) {
  const other = path.join(ctx.work, `${name}-other`);
  await git(ctx, ctx.work, ['clone', '-q', bare, other]);
  for (let i = 1; i <= count; i += 1) {
    await commitFiles(ctx, other, `Remote change ${i}`, { [`remote-${i}.txt`]: `remote ${i}\n` });
  }
  await git(ctx, other, ['push', '-q', 'origin', 'HEAD']);
}

async function withRemote(ctx, dir, name) {
  await seeded(ctx, dir);
  return addRemote(ctx, dir, name);
}

const SCENARIOS = {
  clean: {
    states: ['clean', 'upstream'],
    build: (ctx, dir, name = 'clean') => withRemote(ctx, dir, name),
  },
  staged: {
    states: ['staged'],
    build: async (ctx, dir, name = 'staged') => {
      await withRemote(ctx, dir, name);
      write(ctx, path.join(dir, 'README.md'), '# Fixture\n\nStaged edit.\n');
      write(ctx, path.join(dir, 'added.txt'), 'new file\n');
      await git(ctx, dir, ['add', '-A']);
    },
  },
  unstaged: {
    states: ['unstaged'],
    build: async (ctx, dir, name = 'unstaged') => {
      await withRemote(ctx, dir, name);
      write(ctx, path.join(dir, 'README.md'), '# Fixture\n\nUnstaged edit.\n');
      fs.rmSync(path.join(dir, 'src', 'app.txt'));
    },
  },
  untracked: {
    states: ['untracked'],
    build: async (ctx, dir, name = 'untracked') => {
      await withRemote(ctx, dir, name);
      write(ctx, path.join(dir, 'new-1.txt'), 'one\n');
      write(ctx, path.join(dir, 'new-2.txt'), 'two\n');
      write(ctx, path.join(dir, 'new-dir', 'a.txt'), 'a\n');
      write(ctx, path.join(dir, 'new-dir', 'b.txt'), 'b\n');
    },
  },
  mixed: {
    states: ['staged', 'unstaged', 'untracked'],
    build: async (ctx, dir, name = 'mixed') => {
      await withRemote(ctx, dir, name);
      write(ctx, path.join(dir, 'README.md'), '# Fixture\n\nStaged.\n');
      write(ctx, path.join(dir, 'src', 'app.txt'), 'app v2\n');
      await git(ctx, dir, ['add', 'README.md', 'src/app.txt']);
      write(ctx, path.join(dir, 'src', 'app.txt'), 'app v3\n');
      write(ctx, path.join(dir, 'notes.txt'), 'notes v2\n');
      write(ctx, path.join(dir, 'todo.txt'), 'todo\n');
    },
  },
  renamed: {
    states: ['staged', 'renamed'],
    build: async (ctx, dir, name = 'renamed') => {
      await withRemote(ctx, dir, name);
      await git(ctx, dir, ['mv', 'src/app.txt', 'src/main.txt']);
    },
  },
  conflict: {
    states: ['conflict', 'staged'],
    build: async (ctx, dir) => {
      await seeded(ctx, dir);
      await git(ctx, dir, ['checkout', '-q', '-b', 'feature/conflict']);
      await commitFiles(ctx, dir, 'Feature edit', { 'notes.txt': 'feature notes\n', 'feature.txt': 'feature\n' });
      await git(ctx, dir, ['checkout', '-q', 'main']);
      await commitFiles(ctx, dir, 'Main edit', { 'notes.txt': 'main notes\n' });
      const merge = await git(ctx, dir, ['merge', '--no-edit', 'feature/conflict'], { allowFailure: true });
      if (!merge.failed) throw new Error('conflict fixture: merge unexpectedly succeeded');
    },
  },
  ahead: {
    states: ['ahead'],
    build: async (ctx, dir, name = 'ahead') => {
      await withRemote(ctx, dir, name);
      await commitFiles(ctx, dir, 'Local change 1', { 'local-1.txt': '1\n' });
      await commitFiles(ctx, dir, 'Local change 2', { 'local-2.txt': '2\n' });
    },
  },
  behind: {
    states: ['behind'],
    build: async (ctx, dir, name = 'behind') => {
      const bare = await withRemote(ctx, dir, name);
      await pushFromElsewhere(ctx, bare, name, 1);
      await git(ctx, dir, ['fetch', '-q', 'origin']);
    },
  },
  diverged: {
    states: ['ahead', 'behind'],
    build: async (ctx, dir, name = 'diverged') => {
      const bare = await withRemote(ctx, dir, name);
      await commitFiles(ctx, dir, 'Local change', { 'local.txt': 'local\n' });
      await pushFromElsewhere(ctx, bare, name, 2);
      await git(ctx, dir, ['fetch', '-q', 'origin']);
    },
  },
  // The remote has a new commit that was never fetched: a reader that does
  // not fetch must report 0 behind.
  unfetched: {
    states: ['clean', 'remote-has-unfetched-commit'],
    build: async (ctx, dir, name = 'unfetched') => {
      const bare = await withRemote(ctx, dir, name);
      await pushFromElsewhere(ctx, bare, name, 1);
    },
  },
  'no-upstream': {
    states: ['no-upstream'],
    build: async (ctx, dir, name = 'no-upstream') => {
      await withRemote(ctx, dir, name);
      await git(ctx, dir, ['checkout', '-q', '-b', 'feature/no-upstream']);
      await commitFiles(ctx, dir, 'Work without upstream', { 'feature.txt': 'feature\n' });
    },
  },
  'no-remote': {
    states: ['no-remote'],
    build: (ctx, dir) => seeded(ctx, dir),
  },
  'upstream-gone': {
    states: ['upstream-gone'],
    build: async (ctx, dir, name = 'upstream-gone') => {
      await withRemote(ctx, dir, name);
      await git(ctx, dir, ['checkout', '-q', '-b', 'feature/gone']);
      await commitFiles(ctx, dir, 'Gone work', { 'gone.txt': 'gone\n' });
      await git(ctx, dir, ['push', '-q', '-u', 'origin', 'feature/gone']);
      await git(ctx, dir, ['push', '-q', 'origin', '--delete', 'feature/gone']);
    },
  },
  detached: {
    states: ['detached'],
    build: async (ctx, dir, name = 'detached') => {
      await withRemote(ctx, dir, name);
      await git(ctx, dir, ['checkout', '-q', '--detach', 'HEAD~1']);
    },
  },
  'unmerged-branches': {
    states: ['clean', 'unmerged-branches'],
    build: async (ctx, dir, name = 'unmerged-branches') => {
      await seeded(ctx, dir);
      await git(ctx, dir, ['checkout', '-q', '-b', 'feature/a']);
      await commitFiles(ctx, dir, 'Feature A 1', { 'a1.txt': 'a1\n' });
      await commitFiles(ctx, dir, 'Feature A 2', { 'a2.txt': 'a2\n' });
      await git(ctx, dir, ['checkout', '-q', '-b', 'feature/b', 'main']);
      await commitFiles(ctx, dir, 'Feature B 1', { 'b1.txt': 'b1\n' });
      await git(ctx, dir, ['checkout', '-q', '-b', 'merged', 'main']);
      await commitFiles(ctx, dir, 'Merged work', { 'merged.txt': 'merged\n' });
      await git(ctx, dir, ['checkout', '-q', 'main']);
      await git(ctx, dir, ['merge', '-q', '--ff-only', 'merged']);
      await addRemote(ctx, dir, name);
    },
  },
  stashes: {
    states: ['clean', 'stashes'],
    build: async (ctx, dir, name = 'stashes') => {
      await withRemote(ctx, dir, name);
      write(ctx, path.join(dir, 'README.md'), '# Fixture\n\nStash one.\n');
      await git(ctx, dir, ['stash', 'push', '-q', '-m', 'first stash']);
      write(ctx, path.join(dir, 'notes.txt'), 'stash two\n');
      await git(ctx, dir, ['stash', 'push', '-q', '-m', 'second stash']);
    },
  },
  'worktrees-main': {
    states: ['worktrees'],
    build: async (ctx, dir) => {
      await seeded(ctx, dir);
      write(ctx, path.join(dir, '.git', 'info', 'exclude'), '.worktrees/\n');
      const linked = path.join(ctx.root, 'worktrees-linked');
      await git(ctx, dir, ['worktree', 'add', '-q', '-b', 'linked-branch', linked]);
      write(ctx, path.join(linked, 'README.md'), '# Fixture\n\nEdited in the linked worktree.\n');
      await git(ctx, dir, ['worktree', 'add', '-q', '-b', 'inner-branch', path.join(dir, '.worktrees', 'inner')]);
      // A worktree whose folder was deleted: git lists it as prunable and
      // discovery must ignore it.
      const pruned = path.join(ctx.root, 'worktrees-pruned');
      await git(ctx, dir, ['worktree', 'add', '-q', '-b', 'pruned-branch', pruned]);
      fs.rmSync(pruned, { recursive: true, force: true });
    },
  },
  'lost-deleted-branch': {
    states: ['clean', 'lost-commits', 'deleted-unmerged-branch'],
    build: async (ctx, dir) => {
      await seeded(ctx, dir);
      await git(ctx, dir, ['checkout', '-q', '-b', 'doomed']);
      await commitFiles(ctx, dir, 'Lost work on a deleted branch', { 'doomed.txt': 'doomed\n' });
      await git(ctx, dir, ['checkout', '-q', 'main']);
      await git(ctx, dir, ['branch', '-q', '-D', 'doomed']);
    },
  },
  'lost-hard-reset': {
    states: ['clean', 'lost-commits', 'hard-reset'],
    build: async (ctx, dir) => {
      await seeded(ctx, dir);
      await commitFiles(ctx, dir, 'Lost work before a hard reset', { 'reset.txt': 'reset\n' });
      await git(ctx, dir, ['reset', '-q', '--hard', 'HEAD~1']);
    },
  },
  'lost-dangling': {
    states: ['clean', 'lost-commits', 'dangling'],
    build: async (ctx, dir) => {
      await seeded(ctx, dir);
      write(ctx, path.join(dir, 'notes.txt'), 'dropped stash\n');
      await git(ctx, dir, ['stash', 'push', '-q', '-m', 'dropped stash']);
      await git(ctx, dir, ['stash', 'drop', '-q']);
    },
  },
  // Committed 60 days ago, then reset away: outside the default 30-day
  // lost-commit window.
  'lost-old': {
    states: ['clean', 'no-remote', 'lost-commits-outside-window'],
    build: async (ctx, dir) => {
      await seeded(ctx, dir);
      const date = new Date(Date.now() - 60 * 86400 * 1000).toISOString();
      await commitFiles(ctx, dir, 'Old lost work', { 'old.txt': 'old\n' }, { date });
      await git(ctx, dir, ['reset', '-q', '--hard', 'HEAD~1']);
    },
  },
  // A clone whose remote's default branch is `trunk` (origin/HEAD is set by
  // the clone). A local `main` with its own commit is just another unmerged
  // branch; `feature/done` was merged on the remote only.
  'origin-head': {
    states: ['origin-head', 'unmerged-branches', 'behind'],
    build: async (ctx, dir, name = 'origin-head') => {
      const source = path.join(ctx.work, `${name}-source`);
      await seeded(ctx, source, 'trunk');
      const bare = await addRemote(ctx, source, name, 'trunk');
      await git(ctx, ctx.root, ['clone', '-q', bare, dir]);
      await git(ctx, dir, ['checkout', '-q', '-b', 'feature/done']);
      await commitFiles(ctx, dir, 'Done feature', { 'done.txt': 'done\n' });
      await git(ctx, dir, ['push', '-q', 'origin', 'feature/done']);
      await git(ctx, source, ['pull', '-q', '--ff-only', 'origin', 'feature/done']);
      await git(ctx, source, ['push', '-q', 'origin', 'trunk']);
      await git(ctx, dir, ['checkout', '-q', '-b', 'main', 'trunk']);
      await commitFiles(ctx, dir, 'Work on main', { 'main.txt': 'main\n' });
      await git(ctx, dir, ['checkout', '-q', 'trunk']);
      await git(ctx, dir, ['fetch', '-q', 'origin']);
    },
  },
  empty: {
    states: ['empty', 'no-commits', 'no-remote'],
    build: (ctx, dir) => initRepo(ctx, dir),
  },
  'master-default': {
    states: ['clean', 'master'],
    build: async (ctx, dir, name = 'master-default') => {
      await seeded(ctx, dir, 'master');
      await addRemote(ctx, dir, name, 'master');
    },
  },
  'no-default-branch': {
    states: ['no-default-branch', 'no-remote'],
    build: async (ctx, dir) => {
      await seeded(ctx, dir, 'trunk');
      await git(ctx, dir, ['branch', 'develop']);
    },
  },
  'odd-names': {
    states: ['staged', 'unstaged', 'untracked', 'renamed', 'odd-names'],
    build: async (ctx, dir) => {
      await initRepo(ctx, dir);
      await commitFiles(ctx, dir, 'Odd names', {
        'with space.txt': 'space\n',
        'ação ü 日本.txt': 'unicode\n',
        'dir with space/inner file.txt': 'inner\n',
      });
      await git(ctx, dir, ['mv', 'with space.txt', 'renamed space.txt']);
      write(ctx, path.join(dir, 'dash -- name.txt'), 'arrow\n');
      write(ctx, path.join(dir, "quote'and;semi.txt"), 'quote\n');
      await git(ctx, dir, ['add', '--', 'dash -- name.txt', "quote'and;semi.txt"]);
      write(ctx, path.join(dir, 'ação ü 日本.txt'), 'unicode edited\n');
      write(ctx, path.join(dir, '-leading-dash.txt'), 'dash\n');
      write(ctx, path.join(dir, 'emoji 🚀.txt'), 'emoji\n');
      if (!WINDOWS) {
        // Names Windows cannot store.
        write(ctx, path.join(dir, 'tab\tand\nnewline.txt'), 'control\n');
        write(ctx, path.join(dir, 'arrow -> name.txt'), 'arrow\n');
      }
    },
  },
  // A tracked file whose timestamp changed but not its content: a status
  // run that may take optional locks would rewrite the index.
  'stat-dirty': {
    states: ['clean', 'stat-dirty'],
    build: async (ctx, dir) => {
      await seeded(ctx, dir);
      const old = new Date(Date.now() - 3600 * 1000);
      fs.utimesSync(path.join(dir, 'README.md'), old, old);
    },
  },
  // HEAD names a commit that does not exist: every status read fails.
  broken: {
    states: ['broken'],
    build: async (ctx, dir) => {
      await seeded(ctx, dir);
      write(ctx, path.join(dir, '.git', 'refs', 'heads', 'main'), `${'0123456789abcdef'.repeat(2)}01234567\n`);
    },
  },
  // A repository with another repository inside it: discovery must not
  // descend into the outer one.
  'nested-outer': {
    states: ['untracked', 'nested'],
    build: async (ctx, dir) => {
      await seeded(ctx, dir);
      await seeded(ctx, path.join(dir, 'inner-repo'));
      ctx.hidden.push(path.join(dir, 'inner-repo'));
    },
  },
  'deep/level-1/level-2/level-3/deep-repo': {
    states: ['clean', 'deep'],
    build: (ctx, dir) => seeded(ctx, dir),
  },
};

// Repositories discovery must skip, and folders that are not repositories.
async function buildHiddenRepos(ctx) {
  const hidden = [
    'node_modules/some-package',
    '.cache/cached-repo',
    'build/build-repo',
    'target/target-repo',
    'dist/dist-repo',
    'excluded-area/excluded-repo',
  ];
  await runPool(hidden, 6, async (relative) => {
    const dir = path.join(ctx.root, relative);
    await initRepo(ctx, dir);
    await commitFiles(ctx, dir, 'Hidden', { 'file.txt': 'hidden\n' });
    ctx.hidden.push(dir);
  });
  write(ctx, path.join(ctx.root, 'not-a-repo', 'readme.txt'), 'plain folder\n');
  write(ctx, path.join(ctx.root, 'not-a-repo', 'sub', 'data.txt'), 'plain folder\n');
  // A .git file pointing nowhere is not a repository.
  write(ctx, path.join(ctx.root, 'invalid-gitfile', '.git'), 'gitdir: ./missing-admin-dir\n');
  ctx.hidden.push(path.join(ctx.root, 'invalid-gitfile'), path.join(ctx.root, 'worktrees-pruned'));
  for (const entry of fs.readdirSync(ctx.remotes)) ctx.hidden.push(path.join(ctx.remotes, entry));
}

function expectedDiscovered(ctx, scenarios) {
  const paths = scenarios.map((s) => path.join(ctx.root, s.name));
  paths.push(path.join(ctx.root, 'worktrees-linked'), path.join(ctx.root, 'worktrees-main', '.worktrees', 'inner'));
  return paths;
}

async function runPool(items, size, task) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length > 0) await task(queue.shift());
  });
  await Promise.all(workers);
}

main().catch((error) => {
  console.error(`make-fixtures: ${error.message}`);
  process.exit(1);
});
