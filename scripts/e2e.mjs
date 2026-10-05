/* global document, window, innerWidth, innerHeight -- page functions run in the app's webview */
// End-to-end run of the built Repowatch app on fixture repositories.
//
//   1. Builds the release app (`tauri build --no-bundle`) when the binary is
//      missing or older than any of its sources.
//   2. Creates fixture repositories in a new folder in the OS temp folder
//      (scripts/make-fixtures.mjs) and launches the app with a temporary
//      config folder (REPOWATCH_CONFIG_DIR) whose only root is that folder, a
//      temporary WebView2 data folder (WEBVIEW2_USER_DATA_FOLDER) and an
//      isolated git configuration, so it never sees or writes the user's
//      repositories or settings.
//   3. Attaches over WebView2 remote debugging on a free local port
//      (Playwright connectOverCDP, nothing is downloaded), resizes the real
//      window with Win32 calls, and checks:
//        - the scan: every expected repository and no hidden one, each with
//          the state its fixture was built for, as the backend reports it
//          and as the list draws it,
//        - git actions through the UI, verified with git afterwards: stage
//          and commit, push to the bare remote, fetch, fast-forward-only pull
//          (and its refusal on a diverged branch), create, switch and delete
//          a branch, apply and drop a stash, recover a lost commit; push,
//          delete, apply, drop and recover ask first and Cancel changes
//          nothing,
//        - the tray icon is shown by the Windows shell (UI Automation, on the
//          taskbar or in the hidden-icons flyout) with the scan's attention
//          count in its tooltip.
//   4. Captures every screen (dashboard, detail, diff, settings, palette,
//      confirmation, empty) in light and dark at 1440x900 and 1024x700 into
//      docs/screenshots/, then verifies the set is complete and every image
//      has the expected size.
//   5. Closes the app (window close, then a forced stop if needed) and
//      removes the temporary folder (kept when the run fails).
//
// Usage: npm run e2e [-- --no-build] [-- --keep] [-- --no-shots]
//   --no-build  use the existing release binary even when it looks stale
//   --keep      keep the temporary folder
//   --no-shots  skip screenshots (and their completeness check)

import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const WINDOWS = process.platform === 'win32';
const exe = path.join(root, 'target', 'release', WINDOWS ? 'repowatch.exe' : 'repowatch');
const shotsDir = path.join(root, 'docs', 'screenshots');

const SCREENS = ['dashboard', 'detail', 'diff', 'settings', 'palette', 'confirmation', 'empty'];
const THEMES = ['light', 'dark'];
const SIZES = [
  { width: 1440, height: 900 },
  { width: 1024, height: 700 },
];

if (!WINDOWS) {
  console.error('e2e: the end-to-end run drives WebView2 and is Windows-only for now.');
  process.exit(1);
}

let checks = 0;
function check(cond, message) {
  checks++;
  if (!cond) throw new Error(message);
}
const log = (message) => console.log(`e2e: ${message}`);

// ---------------------------------------------------------------------------
// 1. Build when stale

const SOURCES = [
  'src',
  'index.html',
  'package.json',
  'package-lock.json',
  'vite.config.ts',
  'tsconfig.json',
  'tsconfig.app.json',
  'Cargo.toml',
  'Cargo.lock',
  'crates/core/Cargo.toml',
  'crates/core/src',
  'src-tauri/Cargo.toml',
  'src-tauri/build.rs',
  'src-tauri/tauri.conf.json',
  'src-tauri/capabilities',
  'src-tauri/icons',
  'src-tauri/src',
];

function newestSource() {
  let newest = { time: 0, file: null };
  const visit = (file) => {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(file)) visit(path.join(file, entry));
    } else if (stat.mtimeMs > newest.time) {
      newest = { time: stat.mtimeMs, file };
    }
  };
  for (const source of SOURCES) visit(path.join(root, source));
  return newest;
}

function buildIfStale() {
  const built = fs.statSync(exe, { throwIfNoEntry: false });
  const newest = newestSource();
  if (built && built.mtimeMs >= newest.time) {
    log(`release app is up to date (${path.relative(root, exe)})`);
    return;
  }
  if (built && args.includes('--no-build')) {
    log(`release app is older than ${path.relative(root, newest.file)}; using it anyway (--no-build)`);
    return;
  }
  log(built ? `release app is older than ${path.relative(root, newest.file)}; building` : 'release app missing; building');
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'msvc-env.mjs'), 'tauri', 'build', '--no-bundle'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('the release build failed');
  // An unchanged build may leave the binary's time as it was; mark it current.
  const now = new Date();
  if (fs.statSync(exe).mtimeMs < newest.time) fs.utimesSync(exe, now, now);
}

// ---------------------------------------------------------------------------
// 2. Fixtures, git and the app process

function makeFixtures(out) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'make-fixtures.mjs'), '--out', out, '--quiet'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`fixtures were not created: ${result.stderr.trim()}`);
  return JSON.parse(fs.readFileSync(path.join(out, 'fixtures.json'), 'utf8'));
}

/** The isolated git environment of the fixtures (as make-fixtures.mjs sets it). */
function gitEnvironment(fixtures) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const gitEnvDir = path.join(fixtures, 'git-env');
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(gitEnvDir, 'gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    HOME: path.join(gitEnvDir, 'home'),
    XDG_CONFIG_HOME: path.join(gitEnvDir, 'xdg'),
    LC_ALL: 'C',
  };
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Read-only git queries on fixture repositories (refused anywhere else). */
function makeGit(temp, env) {
  return (cwd, gitArgs) => {
    if (!isInside(path.resolve(cwd), temp)) throw new Error(`internal error: git outside the e2e folder: ${cwd}`);
    return new Promise((resolve) => {
      execFile('git', ['--no-optional-locks', ...gitArgs], { cwd, env, windowsHide: true }, (error, stdout, stderr) =>
        resolve({ ok: !error, out: stdout.trim(), err: stderr.trim() }),
      );
    });
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function until(fn, message, timeout = 10000, every = 100) {
  const end = Date.now() + timeout;
  let last = null;
  for (;;) {
    const value = await fn().catch((error) => {
      last = error;
      return null;
    });
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out: ${message}${last ? ` (${last.message})` : ''}`);
    await sleep(every);
  }
}

/** Launches the app with its own config and WebView2 folders and attaches to its page. */
async function launch({ name, temp, settings, env }) {
  const dir = path.join(temp, `app-${name}`);
  const configDir = path.join(dir, 'config');
  const webviewDir = path.join(dir, 'webview2');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(webviewDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(settings, null, 2));
  const port = await freePort();
  const child = spawn(exe, [], {
    cwd: dir,
    env: {
      ...env,
      REPOWATCH_CONFIG_DIR: configDir,
      WEBVIEW2_USER_DATA_FOLDER: webviewDir,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-allow-origins=http://127.0.0.1:${port}`,
    },
    stdio: 'ignore',
    windowsHide: false,
  });
  let exited = null;
  child.on('exit', (code) => (exited = code ?? 'signal'));
  const endpoint = `http://127.0.0.1:${port}`;
  await until(async () => {
    if (exited !== null) throw new Error(`the app exited at start (${exited})`);
    const res = await fetch(`${endpoint}/json/version`);
    return res.ok;
  }, 'WebView2 remote debugging endpoint', 30000, 200).catch((error) => {
    if (exited !== null) throw new Error(`the app exited at start (code ${exited})`, { cause: error });
    throw error;
  });
  const browser = await chromium.connectOverCDP(endpoint);
  const page = await until(async () => browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('http://tauri.localhost')), 'the app page', 15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console error: ${m.text()}`));
  await page.waitForLoadState('load');
  await page.evaluate(() => document.fonts.ready);
  log(`${name}: app started (pid ${child.pid}), attached on port ${port}`);
  return { name, child, browser, page, errors, configDir, webviewDir, exited: () => exited };
}

/** Closes the window (the app quits: close-to-tray is off), then forces it if needed. */
async function close(app) {
  if (!app) return;
  await app.browser.close().catch(() => {});
  if (app.exited() === null) windowCall(app, ['close']);
  const quit = await until(async () => app.exited() !== null, 'the app to quit', 8000).catch(() => false);
  if (!quit) {
    spawnSync('taskkill', ['/PID', String(app.child.pid), '/T', '/F'], { stdio: 'ignore' });
    await until(async () => app.exited() !== null, 'the app to stop', 8000);
  }
  log(`${app.name}: app closed${quit ? '' : ' (forced)'}`);
}

// ---------------------------------------------------------------------------
// The real window, through Win32 (PowerShell, no extra tools): resize it to
// a client size, or close it as the user would (WM_CLOSE).

const WINDOW_PS = `
param([int]$ProcessId, [string]$Action, [int]$Width, [int]$Height)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class RwWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public static IntPtr Find(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h) && GetWindow(h, 4) == IntPtr.Zero) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
[void][RwWin]::SetThreadDpiAwarenessContext([IntPtr]-4)
$h = [RwWin]::Find([uint32]$ProcessId)
if ($h -eq [IntPtr]::Zero) { throw "no visible window for process $ProcessId" }
if ($Action -eq 'close') { [void][RwWin]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero); exit 0 }
[void][RwWin]::ShowWindow($h, 9)
$w = New-Object RwWin+RECT; $c = New-Object RwWin+RECT
[void][RwWin]::GetWindowRect($h, [ref]$w); [void][RwWin]::GetClientRect($h, [ref]$c)
$fw = ($w.R - $w.L) - ($c.R - $c.L); $fh = ($w.B - $w.T) - ($c.B - $c.T)
[void][RwWin]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, $Width + $fw, $Height + $fh, 0x0044)
[void][RwWin]::SetForegroundWindow($h)
[void][RwWin]::GetClientRect($h, [ref]$c)
"$($c.R - $c.L)x$($c.B - $c.T)"
`;

function windowCall(app, rest) {
  const script = path.join(path.dirname(app.configDir), 'window.ps1');
  if (!fs.existsSync(script)) fs.writeFileSync(script, WINDOW_PS);
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, String(app.child.pid), ...rest], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

async function resize(app, { width, height }) {
  const scale = await app.page.evaluate(() => window.devicePixelRatio);
  let target = { width, height };
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = windowCall(app, ['resize', String(Math.round(target.width * scale)), String(Math.round(target.height * scale))]);
    if (result.status !== 0) throw new Error(`the window was not resized: ${result.stderr.trim() || result.stdout.trim()}`);
    const viewport = await until(
      async () => {
        await sleep(150);
        const v = await app.page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
        return v.w > 0 ? v : null;
      },
      'viewport after resize',
    );
    if (viewport.w === width && viewport.h === height) return;
    target = { width: target.width + (width - viewport.w), height: target.height + (height - viewport.h) };
  }
  const v = await app.page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  throw new Error(`the window could not be sized to ${width}x${height} (viewport ${v.w}x${v.h})`);
}

// ---------------------------------------------------------------------------
// Page helpers

const invoke = (page, command, payload) =>
  page.evaluate(([c, p]) => window.__TAURI_INTERNALS__.invoke(c, p ?? {}), [command, payload ?? null]);

async function waitIn(page, fn, arg, message, timeout = 15000) {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 100 });
  } catch {
    throw new Error(`timed out: ${message}`);
  }
}

async function setTheme(page, theme) {
  const settings = await invoke(page, 'get_settings');
  if (settings.theme !== theme) await invoke(page, 'update_settings', { settings: { ...settings, theme } });
  await waitIn(page, (t) => document.documentElement.dataset.theme === t, theme, `${theme} theme applied`);
}

/** The latest scan, once one has finished. */
async function scanned(page) {
  return until(async () => {
    const snapshot = await invoke(page, 'get_snapshot');
    const status = await invoke(page, 'get_status');
    return snapshot && !status.scanning ? snapshot : null;
  }, 'a finished scan', 60000, 250);
}

/** Dashboard, filter "All", nothing open. */
async function toDashboard(page) {
  for (let i = 0; i < 4; i++) {
    const open = await page.evaluate(() => (document.querySelector('dialog[open]') ? 'dialog' : document.querySelector('.detail') ? 'detail' : document.querySelector('main.settings') ? 'settings' : null));
    if (!open) break;
    await page.keyboard.press('Escape');
    await sleep(150);
  }
  await page.getByRole('button', { name: /^All/ }).click();
  await waitIn(page, () => document.querySelectorAll('.rows [role="option"]').length > 0, null, 'rows rendered');
}

const row = (page, repo) => page.locator(`.rows [role="option"][data-path="${repo.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"]`);

async function openRepo(page, repo, name) {
  await toDashboard(page);
  await row(page, repo).click();
  await page.keyboard.press('Enter');
  await waitIn(page, (n) => document.querySelector('.detail h1')?.textContent === n, name, `${name} shown in the repository view`);
  await waitIn(page, () => !document.querySelector('.detail .detail-loading'), null, `${name} read`);
}

async function tab(page, label) {
  await page.getByRole('tab', { name: new RegExp(`^${label}`) }).click();
}

/** Waits for the outcome of the running action under the actions; returns its text. */
async function outcome(page, text) {
  await waitIn(
    page,
    (t) => {
      const el = document.querySelector('.detail .activity');
      return el && el.dataset.state !== 'pending' && el.textContent.includes(t);
    },
    text,
    `"${text}" shown under the actions`,
    30000,
  );
  // The view reads the repository again after every action.
  await waitIn(page, () => !document.querySelector('.detail .detail-loading'), null, 'repository read again');
}

async function confirmShown(page, title) {
  await page.locator('dialog.confirm[open]').waitFor({ timeout: 5000 });
  await sleep(200);
  const facts = await page.evaluate(() => {
    const d = document.querySelector('dialog.confirm');
    return {
      title: d.querySelector('h2').textContent,
      focused: document.activeElement?.textContent,
      buttons: [...d.querySelectorAll('button')].map((b) => b.textContent),
    };
  });
  check(facts.title === title, `confirmation title "${facts.title}", expected "${title}"`);
  check(facts.focused === 'Cancel', `confirmation focus starts on "${facts.focused}", not Cancel`);
  check(facts.buttons[0] === 'Cancel' && facts.buttons.length === 2, `confirmation buttons ${facts.buttons}`);
  check(!facts.buttons.some((b) => /force/i.test(b)), `a force option in the confirmation: ${facts.buttons}`);
}

async function answer(page, choice) {
  await page.locator('dialog.confirm').getByRole('button', { name: choice, exact: true }).click();
  await page.locator('dialog.confirm').waitFor({ state: 'detached', timeout: 5000 });
}

// ---------------------------------------------------------------------------
// 3. Checks

const reasonKinds = (repo) => repo.attention.reasons.map((r) => r.kind);
const reason = (repo, kind) => repo.attention.reasons.find((r) => r.kind === kind);

/** What each fixture was built for, as the backend must report it. */
const EXPECTED = {
  clean: (r) => r.attention.level === 'clean' && r.upstream?.ahead === 0 && r.upstream?.behind === 0,
  staged: (r) => r.counts.staged === 2 && reason(r, 'staged')?.count === 2,
  unstaged: (r) => r.counts.unstaged === 2 && reason(r, 'unstaged')?.count === 2,
  untracked: (r) => r.counts.untracked > 0 && reason(r, 'untracked'),
  mixed: (r) => r.counts.staged === 2 && r.counts.unstaged === 2 && r.counts.untracked === 1,
  renamed: (r) => r.counts.staged === 1,
  conflict: (r) => r.attention.level === 'risk' && reason(r, 'conflicts')?.count === 1,
  ahead: (r) => r.upstream?.ahead === 2 && r.upstream?.behind === 0 && reason(r, 'ahead')?.count === 2,
  behind: (r) => r.upstream?.behind === 1 && reason(r, 'behind')?.count === 1,
  diverged: (r) => r.upstream?.ahead === 1 && r.upstream?.behind === 2,
  // Never fetched by the scan: the remote's new commit is not counted.
  unfetched: (r) => r.attention.level === 'clean' && r.upstream?.behind === 0,
  'no-upstream': (r) => r.head?.kind === 'branch' && r.head.name === 'feature/no-upstream' && reasonKinds(r).includes('noUpstream'),
  'no-remote': (r) => r.remotes.length === 0 && reasonKinds(r).includes('noRemote'),
  'upstream-gone': (r) => reasonKinds(r).includes('upstreamGone'),
  detached: (r) => r.head?.kind === 'detached' && reasonKinds(r).includes('detachedHead'),
  'unmerged-branches': (r) => reason(r, 'unmergedBranches')?.count === 2 && r.unmergedBranches.map((b) => b.name).sort().join() === 'feature/a,feature/b',
  stashes: (r) => r.stashCount === 2 && reason(r, 'stashes')?.count === 2,
  'worktrees-main': (r) => r.worktrees.length >= 3,
  'worktrees-linked': (r) => r.kind !== 'repository' || r.worktrees.length >= 3,
  'origin-head': (r) => r.defaultBranch?.name === 'trunk' && r.unmergedBranches.some((b) => b.name === 'main'),
  empty: (r) => r.head?.kind === 'unborn',
  'master-default': (r) => r.defaultBranch?.name === 'master' && r.attention.level === 'clean',
  'no-default-branch': (r) => r.defaultBranch === null,
  broken: (r) => r.error !== null && r.attention.level === 'risk',
  'deep-repo': (r) => r.counts.staged + r.counts.unstaged + r.counts.untracked === 0 && reasonKinds(r).join() === 'noRemote',
};

async function checkScan(page, manifest) {
  const snapshot = await scanned(page);
  const paths = snapshot.repos.map((r) => r.path);
  const norm = (p) => p.toLowerCase();
  const found = new Set(paths.map(norm));
  for (const expected of manifest.expectedDiscovered) check(found.has(norm(expected)), `not found by the scan: ${expected}`);
  for (const hidden of manifest.hidden) check(!found.has(norm(hidden)), `found but must be skipped: ${hidden}`);
  check(paths.length === manifest.expectedDiscovered.length, `${paths.length} repositories found, expected ${manifest.expectedDiscovered.length}`);

  const byName = (name) => snapshot.repos.find((r) => path.basename(r.path) === name);
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const repo = byName(name);
    check(repo, `fixture ${name} missing from the scan`);
    check(expected(repo), `fixture ${name} has the wrong state: ${JSON.stringify({ level: repo.attention.level, reasons: reasonKinds(repo), counts: repo.counts, upstream: repo.upstream, head: repo.head })}`);
  }
  check(snapshot.attentionCount === snapshot.repos.filter((r) => r.attention.needsAttention).length, 'attention count differs from the repositories needing attention');

  // The list draws every repository with the backend's level.
  await toDashboard(page);
  const drawn = await page.evaluate(() => [...document.querySelectorAll('.rows [role="option"]')].map((r) => ({ path: r.dataset.path, level: r.dataset.level })));
  check(drawn.length === snapshot.repos.length, `${drawn.length} rows drawn for ${snapshot.repos.length} repositories`);
  for (const repo of snapshot.repos) {
    const r = drawn.find((d) => d.path === repo.path);
    check(r && r.level === repo.attention.level, `${repo.name}: row level ${r?.level}, expected ${repo.attention.level}`);
  }
  log(`scan: ${snapshot.repos.length} repositories, ${snapshot.attentionCount} need attention, states as built`);
  return snapshot;
}

async function checkActions(page, manifest, git) {
  const repo = (name) => manifest.repositories.find((r) => r.name === name).path;
  const remote = (name) => path.join(manifest.remotes, `${name}.git`);
  const rev = async (dir, ref) => (await git(dir, ['rev-parse', '--verify', '--quiet', ref])).out;

  // Stage and commit.
  {
    const dir = repo('untracked');
    await openRepo(page, dir, 'untracked');
    await page.getByRole('button', { name: 'Stage new-1.txt', exact: true }).click();
    await outcome(page, 'Staged new-1.txt.');
    const message = 'Add new-1 from the e2e run';
    await page.locator('#commit-message').fill(message);
    await page.locator('form.commit button[type="submit"]').click();
    await outcome(page, `Committed 1 file: ${message}`);
    check((await git(dir, ['log', '-1', '--format=%s'])).out === message, 'the commit is not the new HEAD');
    const status = (await git(dir, ['status', '--porcelain=v1'])).out;
    check(!status.includes('new-1.txt') && status.includes('new-2.txt'), `unexpected status after the commit: ${status}`);
    log('stage + commit: ok');
  }

  // Push: Cancel changes nothing, Push updates the bare remote.
  {
    const dir = repo('ahead');
    const before = await rev(remote('ahead'), 'refs/heads/main');
    await openRepo(page, dir, 'ahead');
    await page.locator('.detail .actions').getByRole('button', { name: /^Push/ }).click();
    await confirmShown(page, 'Push main to origin/main?');
    await answer(page, 'Cancel');
    await sleep(300);
    check((await rev(remote('ahead'), 'refs/heads/main')) === before, 'Cancel pushed');
    await page.locator('.detail .actions').getByRole('button', { name: /^Push/ }).click();
    await confirmShown(page, 'Push main to origin/main?');
    await answer(page, 'Push');
    await outcome(page, 'Pushed 2 commits to origin/main.');
    check((await rev(remote('ahead'), 'refs/heads/main')) === (await rev(dir, 'HEAD')), 'the bare remote does not have the pushed commits');
    log('push (with confirmation, cancel first): ok');
  }

  // Fetch, then fast-forward-only pull.
  {
    const dir = repo('unfetched');
    await openRepo(page, dir, 'unfetched');
    await page.locator('.detail .actions').getByRole('button', { name: /^Fetch/ }).click();
    await outcome(page, 'Fetched.');
    check((await rev(dir, 'origin/main')) === (await rev(remote('unfetched'), 'refs/heads/main')), 'fetch did not update origin/main');
    check((await rev(dir, 'HEAD')) !== (await rev(dir, 'origin/main')), 'fetch moved the local branch');
    await waitIn(page, () => /Pull\s*1/.test(document.querySelector('.detail .actions')?.textContent ?? ''), null, 'Pull shows 1 after the fetch');
    await page.locator('.detail .actions').getByRole('button', { name: /^Pull/ }).click();
    await outcome(page, 'Pulled origin/main into main (fast-forward).');
    check((await rev(dir, 'HEAD')) === (await rev(dir, 'origin/main')), 'pull did not fast-forward main');
    log('fetch + ff-only pull: ok');
  }
  {
    // A diverged branch is never merged or rebased by Pull.
    const dir = repo('diverged');
    const head = await rev(dir, 'HEAD');
    await openRepo(page, dir, 'diverged');
    const pull = page.locator('.detail .actions').getByRole('button', { name: /^Pull/ });
    const disabled = await pull.getAttribute('aria-disabled');
    if (disabled !== 'true') {
      await pull.click();
      await outcome(page, 'main was not updated.');
    }
    check((await rev(dir, 'HEAD')) === head, 'pull changed a diverged branch');
    log(`pull on a diverged branch refused (${disabled === 'true' ? 'button disabled' : 'git refused the fast-forward'}): ok`);
  }

  // Create, switch and delete a branch.
  {
    const dir = repo('clean');
    await openRepo(page, dir, 'clean');
    await tab(page, 'Branches');
    await page.locator('#new-branch').fill('e2e/topic');
    await page.getByRole('button', { name: 'Create branch' }).click();
    await outcome(page, 'Created branch e2e/topic.');
    check((await rev(dir, 'refs/heads/e2e/topic')) === (await rev(dir, 'HEAD')), 'the branch was not created at HEAD');
    await page.getByRole('button', { name: 'Switch to e2e/topic' }).click();
    await outcome(page, 'Switched to e2e/topic.');
    check((await git(dir, ['symbolic-ref', '--short', 'HEAD'])).out === 'e2e/topic', 'not switched to e2e/topic');
    await page.getByRole('button', { name: 'Switch to main' }).click();
    await outcome(page, 'Switched to main.');
    check((await git(dir, ['symbolic-ref', '--short', 'HEAD'])).out === 'main', 'not switched back to main');
    await page.getByRole('button', { name: 'Delete branch e2e/topic' }).click();
    await confirmShown(page, 'Delete branch e2e/topic?');
    await answer(page, 'Cancel');
    check(await rev(dir, 'refs/heads/e2e/topic'), 'Cancel deleted the branch');
    await page.getByRole('button', { name: 'Delete branch e2e/topic' }).click();
    await confirmShown(page, 'Delete branch e2e/topic?');
    await answer(page, 'Delete branch');
    await outcome(page, 'Deleted branch e2e/topic.');
    check(!(await rev(dir, 'refs/heads/e2e/topic')), 'the branch still exists');
    log('branch create / switch / delete (with confirmation): ok');
  }
  {
    // Unmerged branches offer no delete.
    await openRepo(page, repo('unmerged-branches'), 'unmerged-branches');
    await tab(page, 'Branches');
    await page.getByRole('button', { name: 'Switch to feature/a' }).waitFor({ timeout: 5000 });
    check((await page.getByRole('button', { name: 'Delete branch feature/a' }).count()) === 0, 'an unmerged branch can be deleted');
    check((await page.getByRole('button', { name: 'Delete branch merged' }).count()) === 1, 'the merged branch cannot be deleted');
  }

  // Apply and drop a stash.
  {
    const dir = repo('stashes');
    await openRepo(page, dir, 'stashes');
    await tab(page, 'Stashes');
    await page.getByRole('button', { name: 'Apply stash@{0}' }).click();
    await confirmShown(page, 'Apply stash@{0}?');
    await answer(page, 'Apply stash');
    await outcome(page, 'Applied stash@{0}; the stash is kept.');
    check(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8') === 'stash two\n', 'the stash was not applied to the working tree');
    check((await git(dir, ['stash', 'list'])).out.split('\n').length === 2, 'apply removed the stash');
    await page.getByRole('button', { name: 'Drop stash@{0}' }).click();
    await confirmShown(page, 'Drop stash@{0}?');
    await answer(page, 'Cancel');
    check((await git(dir, ['stash', 'list'])).out.split('\n').length === 2, 'Cancel dropped the stash');
    await page.getByRole('button', { name: 'Drop stash@{0}' }).click();
    await confirmShown(page, 'Drop stash@{0}?');
    await answer(page, 'Drop stash');
    await outcome(page, 'Dropped stash@{0}.');
    const left = (await git(dir, ['stash', 'list'])).out.split('\n');
    check(left.length === 1 && left[0].includes('first stash'), `stashes left: ${left}`);
    log('stash apply / drop (with confirmation): ok');
  }

  // Recover a lost commit to a new branch.
  {
    const dir = repo('lost-deleted-branch');
    await openRepo(page, dir, 'lost-deleted-branch');
    await tab(page, 'Lost commits');
    await page.getByRole('button', { name: /^(Find lost commits|Search again)$/ }).click();
    const item = page.locator('.detail [aria-label="Lost commits"] li', { hasText: 'Lost work on a deleted branch' });
    await item.waitFor({ timeout: 15000 });
    await item.getByRole('button', { name: /^Recover/ }).click();
    await page.locator('dialog.confirm[open]').waitFor({ timeout: 5000 });
    const title = await page.locator('dialog.confirm h2').textContent();
    const short = title.match(/^Recover ([0-9a-f]+) to a new branch\?$/)?.[1];
    check(short, `recover confirmation title "${title}"`);
    await confirmShown(page, title);
    await page.locator('#recover-branch').fill('recovered/e2e');
    await answer(page, 'Recover to branch');
    await outcome(page, `Recovered ${short} to branch recovered/e2e.`);
    const recovered = await git(dir, ['log', '-1', '--format=%H %s', 'refs/heads/recovered/e2e']);
    check(recovered.ok && recovered.out.startsWith(short) && recovered.out.endsWith('Lost work on a deleted branch'), `recovered branch: ${recovered.out || recovered.err}`);
    log('lost commit recover (with confirmation): ok');
  }

  // The dashboard follows the changes.
  {
    const snapshot = await until(async () => {
      const s = await invoke(page, 'get_snapshot');
      const ahead = s.repos.find((r) => r.path === repo('ahead'));
      return ahead && ahead.upstream?.ahead === 0 ? s : null;
    }, 'the dashboard to show the pushed repository as in sync', 30000, 300);
    check(snapshot.repos.find((r) => r.path === repo('stashes')).stashCount === 1, 'the dashboard still counts the dropped stash');
    log('dashboard refreshed after the actions: ok');
  }
}

// The tray icon as the Windows shell shows it (UI Automation): found on the
// taskbar, or in the hidden-icons flyout, which is opened and closed again.
// Its tooltip must carry the scan's attention count. (The flyout cannot be
// captured as a picture: the shell draws it outside GDI.)
const TRAY_PS = `
param([string]$Prefix)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$Any = [System.Windows.Automation.Condition]::TrueCondition
function Find-Icon($parent) {
  foreach ($e in $parent.FindAll($Scope::Descendants, $Any)) { if ($e.Current.Name -like "$Prefix*") { return $e } }
  return $null
}
$taskbar = $A::RootElement.FindFirst($Scope::Children, (New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty, 'Shell_TrayWnd')))
if (-not $taskbar) { throw 'no taskbar' }
$where = 'taskbar'
$icon = Find-Icon $taskbar
$chevron = $null
if (-not $icon) {
  $where = 'hidden icons'
  foreach ($e in $taskbar.FindAll($Scope::Descendants, $Any)) { if ($e.Current.AutomationId -eq 'SystemTrayIcon' -and $e.Current.Name -eq 'Show Hidden Icons') { $chevron = $e } }
  if (-not $chevron) { throw 'no hidden-icons button' }
  $chevron.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  for ($i = 0; $i -lt 20 -and -not $icon; $i++) {
    Start-Sleep -Milliseconds 150
    foreach ($w in $A::RootElement.FindAll($Scope::Children, $Any)) { if ($w.Current.ClassName -like '*Overflow*') { $icon = Find-Icon $w } }
  }
}
try {
  if (-not $icon) { throw "no notification icon named $Prefix..." }
  @{ where = $where; name = $icon.Current.Name } | ConvertTo-Json -Compress
} finally {
  if ($chevron) { $chevron.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
}
`;

const trayTooltip = (count) =>
  count === 0 ? 'Repowatch: all repositories are clean' : count === 1 ? 'Repowatch: 1 repository needs attention' : `Repowatch: ${count} repositories need attention`;

async function checkTray(app, temp) {
  const snapshot = await invoke(app.page, 'get_snapshot');
  const expected = trayTooltip(snapshot.attentionCount);
  const script = path.join(temp, 'tray.ps1');
  fs.writeFileSync(script, TRAY_PS);
  const found = await until(
    async () => {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, 'Repowatch:'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      if (result.status !== 0) throw new Error(result.stderr.trim().split(/\r?\n/)[0]);
      const tray = JSON.parse(result.stdout.trim());
      return tray.name.includes(expected) ? tray : null;
    },
    `the tray icon with the tooltip "${expected}"`,
    15000,
    1000,
  );
  check(found, 'tray icon');
  log(`tray: icon shown (${found.where}) with the tooltip "${expected}"`);
}

// ---------------------------------------------------------------------------
// 4. Screenshots

const shotName = (screen, theme, size) => `${screen}-${theme}-${size.width}x${size.height}.png`;

function pngSize(file) {
  const head = Buffer.alloc(24);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, head, 0, 24, 0);
  fs.closeSync(fd);
  if (head.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

async function shot(app, screen, theme, size, written) {
  await sleep(250); // let 140 ms openings and theme transitions settle
  const file = path.join(shotsDir, shotName(screen, theme, size));
  await app.page.screenshot({ path: file });
  written.add(path.basename(file));
}

async function captureMain(app, manifest, written) {
  const { page } = app;
  const repo = (name) => manifest.repositories.find((r) => r.name === name).path;
  for (const size of SIZES) {
    await resize(app, size);
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await toDashboard(page);
      // The default view: what needs attention, one repository selected.
      await page.getByRole('button', { name: /^Needs attention/ }).click();
      await row(page, repo('mixed')).click();
      await page.locator('.rows').evaluate((el) => el.scrollTo(0, 0));
      await page.locator('button[aria-label="Search repositories and branches"], input[aria-label="Search repositories and branches"]').first().evaluate((el) => el.blur());
      await shot(app, 'dashboard', theme, size, written);

      await page.keyboard.press('Control+k');
      await page.locator('dialog.palette[open]').waitFor({ timeout: 5000 });
      await shot(app, 'palette', theme, size, written);
      await page.keyboard.press('Escape');
      await page.locator('dialog.palette').waitFor({ state: 'detached', timeout: 5000 });

      // Opened with the mouse: keyboard focus on its heading is checked by test:ui.
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.locator('main.settings').waitFor({ timeout: 5000 });
      await shot(app, 'settings', theme, size, written);
      await page.keyboard.press('Escape');
      await page.locator('main.settings').waitFor({ state: 'detached', timeout: 5000 });

      await openRepo(page, repo('unmerged-branches'), 'unmerged-branches');
      await tab(page, 'Branches');
      await page.getByRole('button', { name: 'Switch to feature/a' }).waitFor({ timeout: 5000 });
      await shot(app, 'detail', theme, size, written);

      await openRepo(page, repo('mixed'), 'mixed');
      await page.locator('.detail [role="option"][aria-label="src/app.txt, modified"]').click();
      await waitIn(page, () => document.querySelectorAll('.diff .dl').length > 0, null, 'diff lines shown');
      await shot(app, 'diff', theme, size, written);

      await openRepo(page, repo('ahead'), 'ahead');
      await page.locator('.detail .actions').getByRole('button', { name: /^Push/ }).click();
      await confirmShown(page, 'Push main to origin/main?');
      await shot(app, 'confirmation', theme, size, written);
      await answer(page, 'Cancel');
      await toDashboard(page);
    }
  }
  log(`screenshots: ${written.size} captured on fixtures`);
}

async function captureEmpty(app, written) {
  const { page } = app;
  await waitIn(page, () => !!document.querySelector('.empty-card'), null, 'the empty state', 30000);
  for (const size of SIZES) {
    await resize(app, size);
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await shot(app, 'empty', theme, size, written);
    }
  }
}

function verifyShots(written) {
  const missing = [];
  for (const screen of SCREENS) {
    for (const theme of THEMES) {
      for (const size of SIZES) {
        const name = shotName(screen, theme, size);
        const file = path.join(shotsDir, name);
        if (!written.has(name) || !fs.existsSync(file)) {
          missing.push(name);
          continue;
        }
        const dims = pngSize(file);
        check(dims && dims.width === size.width && dims.height === size.height, `${name} is ${dims ? `${dims.width}x${dims.height}` : 'not a PNG'}`);
      }
    }
  }
  check(missing.length === 0, `screenshots missing: ${missing.join(', ')}`);
  log(`screenshots: all ${SCREENS.length * THEMES.length * SIZES.length} present in ${path.relative(root, shotsDir)} at their sizes`);
}

// ---------------------------------------------------------------------------
// Run

const BASE_SETTINGS = {
  excluded: [],
  theme: 'light',
  density: 'compact',
  backgroundFetch: { enabled: false, intervalMinutes: 30 },
  lostCommitWindowDays: 30,
  closeToTray: false,
};

async function main() {
  buildIfStale();
  const temp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'repowatch-e2e-'));
  log(`temporary folder ${temp}`);
  let app = null;
  let failed = false;
  const shots = !args.includes('--no-shots');
  try {
    const manifest = makeFixtures(path.join(temp, 'fixtures'));
    const env = gitEnvironment(path.join(temp, 'fixtures'));
    const git = makeGit(temp, env);
    const excluded = path.join(manifest.root, 'excluded-area');
    const written = new Set();
    if (shots) fs.mkdirSync(shotsDir, { recursive: true });

    // No folders yet: the empty state.
    app = await launch({ name: 'empty', temp, env, settings: { ...BASE_SETTINGS, roots: [] } });
    const emptyScan = await scanned(app.page);
    check(emptyScan.repos.length === 0, `the empty configuration found ${emptyScan.repos.length} repositories`);
    if (shots) await captureEmpty(app, written);
    check(app.errors.length === 0, `page errors: ${app.errors.join('; ')}`);
    await close(app);
    app = null;

    // The fixtures.
    app = await launch({ name: 'fixtures', temp, env, settings: { ...BASE_SETTINGS, roots: [manifest.root], excluded: [excluded] } });
    await resize(app, SIZES[0]);
    await checkScan(app.page, manifest);
    await checkTray(app, temp);
    if (shots) {
      await captureMain(app, manifest, written);
      verifyShots(written);
    }
    await resize(app, SIZES[0]);
    await setTheme(app.page, 'light');
    await checkActions(app.page, manifest, git);
    check(app.errors.length === 0, `page errors: ${app.errors.join('; ')}`);
    await close(app);
    app = null;
    log(`passed: ${checks} checks`);
  } catch (error) {
    failed = true;
    if (app?.page && !app.page.isClosed()) {
      const file = path.join(temp, 'failure.png');
      await app.page.screenshot({ path: file }).then(() => console.error(`e2e: screen at failure: ${file}`)).catch(() => {});
    }
    console.error(`e2e: FAILED: ${error.message}`);
    if (process.env.E2E_DEBUG) console.error(error);
  } finally {
    await close(app).catch((error) => console.error(`e2e: ${error.message}`));
    if (failed || args.includes('--keep')) {
      log(`kept ${temp}`);
    } else {
      // WebView2 may hold its folder for a moment after the app quits.
      for (let i = 0; i < 20; i++) {
        try {
          fs.rmSync(temp, { recursive: true, force: true });
          break;
        } catch {
          await sleep(500);
        }
      }
    }
  }
  process.exit(failed ? 1 : 0);
}

await main();
