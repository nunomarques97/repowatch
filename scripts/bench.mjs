#!/usr/bin/env node
// Performance measurements (method and results: docs/PERFORMANCE.md).
//
//   npm run bench                 scan time of 50 fixture repositories
//   npm run bench:check           the same, failing when a scan takes over 5 s
//   npm run bench -- --real [<root>...]
//                                 one read-only scan of real folders (default:
//                                 the user's Desktop and Documents, the app's
//                                 default roots)
//   npm run bench -- --app        cold start to first dashboard paint and idle
//                                 memory of the release app on the fixtures
//
// Options: --count <n> fixture repositories (default 50), --runs <n> scans or
// launches (default 5; --real always scans once), --idle <s> seconds before
// the memory reading (default 30), --no-build (use the existing release app).
//
// Scans run target/release/repowatch-bench (crates/core/src/bin), which uses
// only the core read path: discovery plus the dashboard summary, with
// --no-optional-locks, never a fetch or a write. Fixtures are created by
// scripts/make-fixtures.mjs in a new folder in the OS temp folder, read with
// an isolated git configuration and removed afterwards; nothing else is
// touched. --real reads the named folders with the same read-only commands
// and creates nothing.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const WINDOWS = process.platform === 'win32';
const EXE = WINDOWS ? '.exe' : '';
const targetDir = process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : path.join(root, 'target');
const benchExe = path.join(targetDir, 'release', `repowatch-bench${EXE}`);
const appExe = path.join(targetDir, 'release', `repowatch${EXE}`);
const installerDir = path.join(targetDir, 'release', 'bundle', 'nsis');

/** Slowest accepted scan of the fixtures, in milliseconds (bench:check). */
const SCAN_LIMIT_MS = 5000;
const PAINT_MARK = 'repowatch:dashboard-painted';

const log = (message) => console.log(`bench: ${message}`);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

function parseArgs(argv) {
  const options = { mode: 'scan', check: false, count: 50, runs: 5, idle: 30, build: true, roots: [] };
  const number = (name, value, min, max) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') options.check = true;
    else if (arg === '--real') options.mode = 'real';
    else if (arg === '--app') options.mode = 'app';
    else if (arg === '--no-build') options.build = false;
    else if (arg === '--count') options.count = number('--count', argv[++i], 1, 1000);
    else if (arg === '--runs') options.runs = number('--runs', argv[++i], 1, 50);
    else if (arg === '--idle') options.idle = number('--idle', argv[++i], 0, 600);
    else if (arg.startsWith('-')) throw new Error(`unknown argument: ${arg}`);
    else if (options.mode === 'real') options.roots.push(path.resolve(arg));
    else throw new Error(`folders are accepted only with --real: ${arg}`);
  }
  if (options.check && options.mode !== 'scan') throw new Error('--check applies to the fixture scan only');
  return options;
}

// ---------------------------------------------------------------------------
// Builds

function cargoBuildBench() {
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'msvc-env.mjs'), 'cargo', 'build', '--release', '--locked', '-p', 'repowatch-core', '--bin', 'repowatch-bench'],
    { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  if (result.status !== 0) throw new Error('the bench tool did not build');
}

function buildApp(options) {
  if (fs.existsSync(appExe) && !options.build) {
    log(`using the existing release app (--no-build): ${path.relative(root, appExe)}`);
    return;
  }
  log('building the release app (tauri build --no-bundle)');
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'msvc-env.mjs'), 'tauri', 'build', '--no-bundle'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('the release build failed');
}

// ---------------------------------------------------------------------------
// Fixtures

function makeTemp() {
  return fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'repowatch-bench-'));
}

function makeFixtures(temp, count) {
  const out = path.join(temp, 'fixtures');
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'make-fixtures.mjs'), '--out', out, '--count', String(count), '--quiet'],
    { cwd: root, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`fixtures were not created: ${result.stderr.trim()}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'fixtures.json'), 'utf8'));
  return { out, manifest, excluded: path.join(manifest.root, 'excluded-area') };
}

/** The isolated git environment of the fixtures (as make-fixtures.mjs sets it). */
function fixtureEnvironment(fixtures) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const gitEnvDir = path.join(fixtures, 'git-env');
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(gitEnvDir, 'gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    HOME: path.join(gitEnvDir, 'home'),
    XDG_CONFIG_HOME: path.join(gitEnvDir, 'xdg'),
  };
}

async function removeTemp(temp) {
  // WebView2 may hold its folder for a moment after the app quits.
  for (let i = 0; i < 20; i++) {
    try {
      fs.rmSync(temp, { recursive: true, force: true });
      return;
    } catch {
      await sleep(500);
    }
  }
  log(`could not remove ${temp}`);
}

// ---------------------------------------------------------------------------
// Scans

function runBench(args, env) {
  const result = spawnSync(benchExe, args, { cwd: root, env, encoding: 'utf8', windowsHide: true, maxBuffer: 16 << 20 });
  if (result.status !== 0) throw new Error(`repowatch-bench failed: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout);
}

const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function printScan(report) {
  report.runs.forEach((run, i) => {
    log(
      `scan ${i + 1}: ${fmt(run.totalMs)} (discovery ${fmt(run.discoveryMs)}, summaries ${fmt(run.summariesMs)}), ` +
        `${run.repos} repositories, ${run.attention} need attention, ${run.errors} unreadable`,
    );
  });
  const totals = report.runs.map((run) => run.totalMs);
  log(`total: first ${fmt(totals[0])}, median ${fmt(median(totals))}, slowest ${fmt(Math.max(...totals))} (${report.threads} threads)`);
  return totals;
}

async function scanFixtures(options) {
  cargoBuildBench();
  const temp = makeTemp();
  let ok = false;
  try {
    const { out, manifest, excluded } = makeFixtures(temp, options.count);
    const expected = manifest.expectedDiscovered.length;
    log(`${expected} fixture repositories in ${manifest.root}`);
    const report = runBench(['--runs', String(options.runs), '--exclude', excluded, manifest.root], fixtureEnvironment(out));
    const totals = printScan(report);
    if (report.repos !== expected) throw new Error(`the scan found ${report.repos} repositories, expected ${expected}`);
    const slowest = Math.max(...totals);
    if (options.check && slowest > SCAN_LIMIT_MS) {
      throw new Error(`the slowest scan took ${fmt(slowest)}, over the ${fmt(SCAN_LIMIT_MS)} limit`);
    }
    if (options.check) log(`check passed: every scan of ${expected} repositories took at most ${fmt(SCAN_LIMIT_MS)}`);
    ok = true;
  } finally {
    if (ok) await removeTemp(temp);
    else log(`kept ${temp}`);
  }
}

function scanReal(options) {
  const roots = options.roots.length
    ? options.roots
    : [path.join(os.homedir(), 'Desktop'), path.join(os.homedir(), 'Documents')].filter((dir) => fs.existsSync(dir));
  if (roots.length === 0) throw new Error('no folder to scan');
  cargoBuildBench();
  log(`read-only scan of ${roots.join(', ')} (no fetch, no optional locks, no writes)`);
  const report = runBench(['--runs', '1', '--slowest', '10', ...roots], process.env);
  printScan(report);
  log('slowest repositories:');
  for (const item of report.slowest) log(`  ${fmt(item.ms).padStart(8)}  ${item.path}`);
}

// ---------------------------------------------------------------------------
// The release app: cold start and idle memory

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

async function until(fn, message, timeout, every = 50) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out: ${message}`);
    await sleep(every);
  }
}

/** Starts the app with its own settings, config and WebView2 folders (a cold profile). */
function startApp({ temp, name, fixtures, env, port }) {
  const dir = path.join(temp, `app-${name}`);
  const configDir = path.join(dir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'webview2'));
  const settings = {
    roots: [fixtures.manifest.root],
    excluded: [fixtures.excluded],
    theme: 'light',
    density: 'compact',
    backgroundFetch: { enabled: false, intervalMinutes: 30 },
    lostCommitWindowDays: 30,
    closeToTray: false,
  };
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(settings, null, 2));
  const appEnv = { ...env, REPOWATCH_CONFIG_DIR: configDir, WEBVIEW2_USER_DATA_FOLDER: path.join(dir, 'webview2') };
  if (port) {
    appEnv.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${port} --remote-allow-origins=http://127.0.0.1:${port}`;
  }
  const startedAt = performance.timeOrigin + performance.now();
  const child = spawn(appExe, [], { cwd: dir, env: appEnv, stdio: 'ignore' });
  const app = { child, startedAt, exited: null };
  child.on('exit', (code) => (app.exited = code ?? 'signal'));
  return app;
}

async function stopApp(app) {
  if (app.exited !== null) return;
  // Without /F, taskkill asks the window to close; the app quits (close-to-tray is off).
  spawnSync('taskkill', ['/PID', String(app.child.pid), '/T'], { stdio: 'ignore' });
  const quit = await until(async () => app.exited !== null, 'the app to quit', 8000).catch(() => false);
  if (!quit) {
    spawnSync('taskkill', ['/PID', String(app.child.pid), '/T', '/F'], { stdio: 'ignore' });
    await until(async () => app.exited !== null, 'the app to stop', 8000);
  }
}

/** Milliseconds from process start to the first window paint and to the first dashboard rows. */
async function measureStart(app, port, chromium) {
  const endpoint = `http://127.0.0.1:${port}`;
  await until(async () => {
    if (app.exited !== null) throw new Error(`the app exited at start (${app.exited})`);
    return (await fetch(`${endpoint}/json/version`)).ok;
  }, 'the WebView2 debugging endpoint', 30000);
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const page = await until(
      async () => browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('http://tauri.localhost')),
      'the app page',
      15000,
    );
    // Performance entries are buffered, so attaching late loses nothing.
    const times = await page.evaluate(async (mark) => {
      for (let i = 0; i < 600; i++) {
        const painted = performance.getEntriesByName(mark)[0];
        if (painted) {
          const fcp = performance.getEntriesByName('first-contentful-paint')[0];
          return { origin: performance.timeOrigin, fcp: fcp?.startTime ?? null, dashboard: painted.startTime };
        }
        await new Promise((ok) => setTimeout(ok, 50));
      }
      return null;
    }, PAINT_MARK);
    if (!times) throw new Error('the dashboard did not show repositories within 30 s');
    return {
      firstPaint: times.fcp === null ? null : times.origin + times.fcp - app.startedAt,
      dashboard: times.origin + times.dashboard - app.startedAt,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Memory of the app and every process below it (WebView2): private working
 * set (Task Manager's "Memory" column), working set and private bytes.
 */
function processTreeMemory(pid) {
  const script = [
    'Get-CimInstance Win32_Process | ForEach-Object { "p,$($_.ProcessId),$($_.ParentProcessId),$($_.WorkingSetSize),$($_.PrivatePageCount),$($_.Name)" }',
    'Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object { "w,$($_.IDProcess),$($_.WorkingSetPrivate)" }',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`process list failed: ${result.stderr.trim()}`);
  const all = [];
  const privateSet = new Map();
  for (const line of result.stdout.trim().split(/\r?\n/)) {
    const [kind, id, ...rest] = line.split(',');
    if (kind === 'w') privateSet.set(Number(id), Number(rest[0]));
    else if (kind === 'p') {
      const [parent, ws, priv, ...name] = rest;
      all.push({ id: Number(id), parent: Number(parent), ws: Number(ws), priv: Number(priv), name: name.join(',') });
    }
  }
  const tree = [];
  const queue = [pid];
  while (queue.length) {
    const id = queue.shift();
    const proc = all.find((p) => p.id === id);
    if (!proc || tree.includes(proc)) continue;
    proc.pws = privateSet.get(id) ?? 0;
    tree.push(proc);
    queue.push(...all.filter((p) => p.parent === id && p.id !== id).map((p) => p.id));
  }
  const sum = (key) => tree.reduce((total, p) => total + p[key], 0);
  return { processes: tree, privateWorkingSet: sum('pws'), workingSet: sum('ws'), privateBytes: sum('priv') };
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function measureApp(options) {
  if (!WINDOWS) throw new Error('the app measurement drives WebView2 and is Windows-only for now');
  const { chromium } = await import('playwright-core');
  buildApp(options);
  const temp = makeTemp();
  let ok = false;
  let app = null;
  try {
    const fixtures = makeFixtures(temp, options.count);
    const env = fixtureEnvironment(fixtures.out);
    log(`${fixtures.manifest.expectedDiscovered.length} fixture repositories in ${fixtures.manifest.root}`);

    const starts = [];
    for (let i = 0; i < options.runs; i++) {
      const port = await freePort();
      app = startApp({ temp, name: `start-${i + 1}`, fixtures, env, port });
      const time = await measureStart(app, port, chromium);
      await stopApp(app);
      app = null;
      starts.push(time);
      log(`launch ${i + 1}: first paint ${time.firstPaint === null ? 'n/a' : fmt(time.firstPaint)}, dashboard with repositories ${fmt(time.dashboard)}`);
    }
    const dashboards = starts.map((s) => s.dashboard);
    const paints = starts.map((s) => s.firstPaint).filter((t) => t !== null);
    log(`cold start to dashboard: median ${fmt(median(dashboards))}, range ${fmt(Math.min(...dashboards))} - ${fmt(Math.max(...dashboards))}`);
    if (paints.length) log(`cold start to first paint: median ${fmt(median(paints))}`);

    // Memory: a launch without the debugging port, left idle.
    app = startApp({ temp, name: 'memory', fixtures, env, port: null });
    log(`idle memory: waiting ${options.idle} s after launch`);
    await sleep(options.idle * 1000);
    if (app.exited !== null) throw new Error(`the app exited (${app.exited})`);
    const samples = [];
    for (let i = 0; i < 3; i++) {
      samples.push(processTreeMemory(app.child.pid));
      await sleep(2000);
    }
    const last = samples[samples.length - 1];
    const mid = (key) => mb(median(samples.map((s) => s[key])));
    log(
      `idle memory (${last.processes.length} processes): private working set ${mid('privateWorkingSet')}, ` +
        `private bytes ${mid('privateBytes')}, working set ${mid('workingSet')} (shared pages counted per process)`,
    );
    for (const p of last.processes) {
      log(`  ${p.name.padEnd(22)} private working set ${mb(p.pws).padStart(9)}, private bytes ${mb(p.priv).padStart(9)}`);
    }
    await stopApp(app);
    app = null;

    log(`release app: ${mb(fs.statSync(appExe).size)} (${path.relative(root, appExe)})`);
    const installers = fs.existsSync(installerDir) ? fs.readdirSync(installerDir).filter((f) => f.endsWith('-setup.exe')) : [];
    for (const file of installers) log(`installer: ${mb(fs.statSync(path.join(installerDir, file)).size)} (${file})`);
    if (!installers.length) log('installer: not built (npm run build:installer)');
    ok = true;
  } finally {
    if (app) await stopApp(app).catch((error) => log(error.message));
    if (ok) await removeTemp(temp);
    else log(`kept ${temp}`);
  }
}

// ---------------------------------------------------------------------------

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === 'real') scanReal(options);
  else if (options.mode === 'app') await measureApp(options);
  else await scanFixtures(options);
} catch (error) {
  console.error(`bench: FAILED: ${error.message}`);
  process.exitCode = 1;
}
