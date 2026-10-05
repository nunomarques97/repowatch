/* global document, window, getComputedStyle, innerWidth, innerHeight -- page functions run in the browser */
// Drives the built frontend with the in-memory mock IPC in the installed
// Microsoft Edge (Playwright, no browser download), in light and dark at
// 1440x900 and 1024x700, and checks the dashboard's behaviour:
//   - every repository with its coloured state, words, icon and counts,
//   - filters, search, sort, density and the settings theme override,
//   - loading, empty (no folders, no repositories), per-repository errors,
//     rescan progress, failed rescan with retry,
//   - a stale scan result never replaces a newer one; search text and focus
//     survive refreshes and full rescans,
//   - keyboard only: dashboard -> command palette (Ctrl K) -> repository ->
//     settings, visible focus on every Tab stop, focus restored when a layer
//     closes, the shortcuts sheet (?), scan results announced without moving
//     focus,
//   - settings: folders, exclusions, theme, density, background fetch, the
//     lost-commit window; a failed save keeps the edit and can be retried,
//   - reduced motion: no transitions or movement; without it the palette
//     opens with its 140 ms animation,
//   - the repository view: files and diff (content as text), stage and
//     unstage files and hunks, commit, fetch, ff-only pull, push, branches,
//     worktrees, stashes, lost commits; push, branch deletion, stash apply
//     and drop and recovery confirm naming their target and Cancel does
//     nothing; pending, result and git error text; a double click runs once;
//     a result for a repository left behind never shows in the current one,
//     and the repository is read again after success and failure,
//   - no page errors (production CSP served), no horizontal overflow, text
//     contrast >= 4.5:1.
// Screenshots go to the git-ignored .artifacts/ui/ folder.
//
// Usage: npm run test:ui [-- --no-build] [-- --only=light-1440x900]
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = join(root, 'dist');
const outDir = join(root, '.artifacts', 'ui');
const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith('--only='))?.slice(7);

const THEMES = ['light', 'dark'];
const SIZES = [
  { width: 1440, height: 900 },
  { width: 1024, height: 700 },
];
/** The mock's fixed "now" (src/ipc/mock-data.ts) plus one minute, so relative times are stable. */
const MOCK_NOW_MS = 1_791_190_800_000 + 60_000;
const BG = { light: 'rgb(246, 247, 249)', dark: 'rgb(14, 16, 20)' };

// 1. Build the frontend (the same `dist` Tauri bundles).
if (!args.includes('--no-build')) {
  const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  const built = spawnSync(process.execPath, [vite, 'build', '--logLevel', 'warn'], { cwd: root, stdio: 'inherit' });
  if (built.status !== 0) {
    console.error('test:ui: vite build failed');
    process.exit(1);
  }
}

// 2. Serve `dist` read-only on 127.0.0.1 with the app's production CSP.
const tauriConf = JSON.parse(await readFile(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const CSP = tauriConf.app.security.csp;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/favicon.ico') {
      // The browser asks for it; the app window has no favicon.
      res.writeHead(204);
      res.end();
      return;
    }
    const name = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const path = normalize(join(dist, name));
    if (!path.startsWith(dist + sep)) throw new Error('outside dist');
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream', 'content-security-policy': CSP });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}/`;

// ---------------------------------------------------------------------------
// In-page helpers

/** Overflow and text contrast of everything on screen (as in design-check). */
function inspectPage() {
  function parse(c) {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function over(top, bottom) {
    const a = top.a + bottom.a * (1 - top.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    const mix = (k) => (top[k] * top.a + bottom[k] * bottom.a * (1 - top.a)) / a;
    return { r: mix('r'), g: mix('g'), b: mix('b'), a };
  }
  function lum({ r, g, b }) {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  function background(el) {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) {
        layers.push(c);
        if (c.a >= 1) break;
      }
    }
    let result = parse(getComputedStyle(document.body).backgroundColor) ?? { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) result = over(layers[i], result);
    return result;
  }
  const contrast = [];
  for (const el of document.body.querySelectorAll('*')) {
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasText) continue;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height || box.bottom < 0 || box.top > innerHeight) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || el.closest('.sr-only') || el.closest('option')) continue;
    const bg = background(el);
    const fg = over(parse(style.color), bg);
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    const r = ratio(fg, bg);
    if (r < (large ? 3 : 4.5)) {
      contrast.push(`<${el.tagName.toLowerCase()} class="${el.getAttribute('class') ?? ''}"> "${el.textContent.trim().slice(0, 30)}": ${r.toFixed(2)}`);
    }
  }
  const doc = document.scrollingElement;
  const overflow = [];
  if (doc.scrollWidth > doc.clientWidth) overflow.push(`page scrollWidth ${doc.scrollWidth} > ${doc.clientWidth}`);
  if (doc.scrollHeight > doc.clientHeight) overflow.push(`page scrollHeight ${doc.scrollHeight} > ${doc.clientHeight}`);
  for (const el of document.body.querySelectorAll('*')) {
    const box = el.getBoundingClientRect();
    if (!box.width || box.right <= innerWidth + 0.5) continue;
    let clipped = false;
    for (let p = el.parentElement; p && p !== document.body && !clipped; p = p.parentElement) {
      clipped = getComputedStyle(p).overflowX !== 'visible' && p.getBoundingClientRect().right <= innerWidth + 0.5;
    }
    if (!clipped) overflow.push(`<${el.tagName.toLowerCase()} class="${el.getAttribute('class') ?? ''}"> right edge ${Math.round(box.right)} > ${innerWidth}`);
  }
  // Text cut inside its own box (not ellipsis) is clipped information.
  const cut = [];
  for (const el of document.querySelectorAll('.row .name, .chip, .btn, .group-head, .title-row h1, .seg button')) {
    const style = getComputedStyle(el);
    if (el.getBoundingClientRect().width === 0 || style.textOverflow === 'ellipsis') continue;
    if (el.scrollWidth > el.clientWidth + 1) cut.push(`"${el.textContent.trim().slice(0, 30)}" is cut (${el.scrollWidth} > ${el.clientWidth})`);
  }
  return { contrast: contrast.slice(0, 10), overflow: overflow.slice(0, 10), cut: cut.slice(0, 10) };
}

/** What every visible row shows, and what the mock snapshot says it should. */
async function rowFacts(page) {
  return page.evaluate(async () => {
    const snapshot = await window.__repowatchMock.getSnapshot();
    const levelColor = (level) => getComputedStyle(document.documentElement).getPropertyValue(`--${level}`).trim();
    const hex = (rgb) => {
      const m = rgb.match(/\d+/g);
      return m ? '#' + m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('') : rgb;
    };
    return [...document.querySelectorAll('.rows [role="option"]')].map((row) => {
      const repo = snapshot.repos.find((r) => r.path === row.dataset.path);
      const cells = [...row.querySelectorAll('.c')].map((c) => c.textContent.trim());
      const rail = getComputedStyle(row, '::before').backgroundColor;
      const state = row.querySelector('.state');
      return {
        name: row.querySelector('.name')?.textContent,
        path: row.dataset.path,
        level: row.dataset.level,
        expected: repo && {
          level: repo.attention.level,
          cells: [
            repo.counts.staged,
            repo.counts.unstaged,
            repo.counts.untracked,
            repo.upstream?.ahead ?? 0,
            repo.upstream?.behind ?? 0,
            repo.unmergedBranches.length,
            repo.stashCount,
          ].map((n) => (n ? String(n) : '·')),
          reasons: repo.attention.reasons.length,
          worktree: repo.kind.kind === 'linkedWorktree',
          detached: repo.head?.kind === 'detached',
        },
        cells,
        stateText: state?.querySelector('.tx')?.textContent ?? '',
        stateIcon: !!state?.querySelector('svg'),
        stateClass: state?.className ?? '',
        more: state?.querySelector('.more')?.textContent ?? '',
        rail: hex(rail),
        railExpected: repo && repo.attention.level !== 'clean' ? levelColor(repo.attention.level) : null,
        worktreeBadge: !!row.querySelector('.wt'),
        branch: row.querySelector('.branch')?.textContent ?? '',
        label: row.getAttribute('aria-label'),
        height: row.getBoundingClientRect().height,
      };
    });
  });
}

// ---------------------------------------------------------------------------

const failures = [];
const shots = [];
let checks = 0;

function check(cond, message) {
  checks++;
  if (!cond) throw new Error(message);
}

/** Presses Tab up to `max` times; each stop and whether it shows a focus indicator. */
async function tabWalk(page, max) {
  const stops = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const visible = (s) => (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2) || s.boxShadow.includes('inset');
      // Text fields show focus on their container (title bar search, palette field).
      const container = el.closest('.search, .palette-field');
      const ok = visible(getComputedStyle(el)) || (container !== null && visible(getComputedStyle(container)));
      const name = el.getAttribute('aria-label') || el.labels?.[0]?.textContent || el.getAttribute('aria-labelledby')?.split(' ').map((id) => document.getElementById(id)?.textContent).join(' ') || el.textContent;
      return { ok, what: `<${el.tagName.toLowerCase()}> ${name.trim().slice(0, 40)}`, key: el.id || el.dataset.path || name.trim().slice(0, 40) };
    });
    if (!stop) continue;
    if (stops.some((s) => s.key === stop.key && s.what === stop.what)) break;
    stops.push(stop);
  }
  return stops;
}

async function waitFor(page, fn, arg, message, timeout = 4000) {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 50 });
  } catch {
    throw new Error(`timed out: ${message}`);
  }
}

let browser;
try {
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
  } catch (error) {
    throw new Error(`Microsoft Edge could not be started (it must be installed; nothing is downloaded): ${error.message.split('\n')[0]}`, {
      cause: error,
    });
  }
  await mkdir(outDir, { recursive: true });

  for (const theme of THEMES) {
    for (const size of SIZES) {
      const tag = `${theme}-${size.width}x${size.height}`;
      if (only && only !== tag) continue;
      const context = await browser.newContext({ viewport: size, colorScheme: theme, reducedMotion: 'reduce', deviceScaleFactor: 1 });

      async function open(query = '') {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
        page.on('console', (m) => m.type() === 'error' && errors.push(`console error: ${m.text()}`));
        page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()}`));
        await page.clock.setFixedTime(MOCK_NOW_MS);
        await page.goto(`${base}${query}`, { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);
        page.errors = errors;
        return page;
      }

      async function shot(page, name) {
        const file = `${name}-${tag}.png`;
        await page.screenshot({ path: join(outDir, file) });
        shots.push(file);
      }

      async function inspect(page, label) {
        const r = await page.evaluate(inspectPage);
        for (const e of r.overflow) failures.push(`${tag} ${label}: overflow: ${e}`);
        for (const e of r.contrast) failures.push(`${tag} ${label}: text contrast below 4.5:1: ${e}`);
        for (const e of r.cut) failures.push(`${tag} ${label}: ${e}`);
        checks += 3;
      }

      async function step(label, page, fn) {
        try {
          await fn();
        } catch (error) {
          if (process.env.UI_DEBUG) console.error(error);
          failures.push(`${tag} ${label}: ${error.message.split('\n')[0]}`);
        }
        for (const e of page.errors.splice(0)) failures.push(`${tag} ${label}: ${e}`);
      }

      const rowsReady = () => document.querySelectorAll('.rows [role="option"]').length > 0;
      const generation = (page) => page.evaluate(async () => (await window.__repowatchMock.getSnapshot())?.generation ?? 0);

      // --- Default scenario: the dashboard -------------------------------
      const page = await open();
      await step('dashboard', page, async () => {
        await waitFor(page, rowsReady, null, 'rows rendered');
        const html = await page.evaluate(() => ({
          theme: document.documentElement.dataset.theme,
          bg: getComputedStyle(document.body).backgroundColor,
        }));
        check(html.theme === theme, `data-theme is ${html.theme}, expected ${theme} (OS)`);
        check(html.bg === BG[theme], `body background ${html.bg}, expected ${BG[theme]}`);

        // "Needs attention" is the default filter: every repo needing attention, no clean ones.
        const pressed = await page.locator('.chips [aria-pressed="true"]').innerText();
        check(pressed.startsWith('Needs attention'), `default filter is "${pressed}"`);
        const snapshot = await page.evaluate(() => window.__repowatchMock.getSnapshot());
        let rows = await rowFacts(page);
        check(rows.length === snapshot.attentionCount, `${rows.length} rows, expected ${snapshot.attentionCount} needing attention`);
        check(rows.every((r) => r.level !== 'clean'), 'a clean repository is listed under Needs attention');
        const chipCount = await page.locator('.chips button', { hasText: 'Needs attention' }).locator('.n').innerText();
        check(Number(chipCount) === snapshot.attentionCount, `chip count ${chipCount}`);

        // All: every repository, every one with state words, icon, rail colour and counts.
        await page.getByRole('button', { name: /^All/ }).click();
        rows = await rowFacts(page);
        check(rows.length === snapshot.repos.length, `All shows ${rows.length} of ${snapshot.repos.length}`);
        for (const r of rows) {
          check(r.expected, `${r.name}: not in the snapshot`);
          check(r.level === r.expected.level, `${r.name}: level ${r.level}, expected ${r.expected.level}`);
          check(r.stateText.trim().length > 0 && r.stateIcon, `${r.name}: state has no words or icon`);
          check(r.stateClass.includes(`t-${r.level}`), `${r.name}: state text not in its category colour`);
          check(JSON.stringify(r.cells) === JSON.stringify(r.expected.cells), `${r.name}: counts ${r.cells} expected ${r.expected.cells}`);
          check(r.expected.reasons <= 1 ? r.more === '' : r.more === `+${r.expected.reasons - 1}`, `${r.name}: "+N" is "${r.more}"`);
          if (r.railExpected) check(r.rail === r.railExpected, `${r.name}: rail ${r.rail}, expected ${r.railExpected}`);
          else check(r.rail === '#000000' || r.rail === 'rgba(0, 0, 0, 0)' || r.level === 'clean', `${r.name}: clean row has a rail`);
          check(r.worktreeBadge === r.expected.worktree, `${r.name}: worktree badge ${r.worktreeBadge}`);
          if (r.expected.detached) check(/^HEAD [0-9a-f]{7}$/.test(r.branch), `${r.name}: detached branch text "${r.branch}"`);
          check(r.label && r.label.startsWith(r.name), `${r.name}: row has no accessible name`);
          check(Math.round(r.height) === 34, `${r.name}: compact row height ${r.height}`);
        }
        const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
        const expectState = (name, text) =>
          check(byName[name]?.label.includes(text), `${name}: state should mention "${text}" (label: ${byName[name]?.label})`);
        expectState('broken-repo', 'bad config line 1');
        expectState('data-pipeline', '1 conflicted');
        expectState('legacy-app', 'Detached HEAD');
        expectState('api', 'No upstream');
        expectState('notes', 'No remote');
        expectState('mobile', 'Upstream deleted');
        expectState('site', '3 to pull');
        expectState('forja', '4 to push');
        expectState('design-system', '2 unmerged branches');
        expectState('design-system', '2 stashes');
        expectState('docs', 'clean');
        check(byName.docs.stateText === 'Clean', 'clean row reads "Clean"');

        // Groups in severity order with their counts.
        const groups = await page.locator('.group-head').allInnerTexts();
        const order = groups.map((g) => g.replace(/\s*\d+$/, '').trim().toLowerCase());
        check(JSON.stringify(order) === JSON.stringify(['at risk', 'uncommitted', 'out of sync', 'loose ends', 'clean']), `group order ${order}`);
        await inspect(page, 'dashboard all');
        await page.getByRole('button', { name: /^Needs attention/ }).click();
        await page.locator('.rows [role="option"][aria-label^="repowatch,"]').click();
        await shot(page, 'dashboard');
        await inspect(page, 'dashboard');
      });

      await step('filters', page, async () => {
        const snapshot = await page.evaluate(() => window.__repowatchMock.getSnapshot());
        for (const [chip, level] of [
          ['At risk', 'risk'],
          ['Uncommitted', 'change'],
          ['Out of sync', 'sync'],
          ['Loose ends', 'branch'],
        ]) {
          const button = page.getByRole('button', { name: new RegExp(`^${chip}`) });
          if (!(await button.isVisible())) {
            check(size.width < 1200 && level === 'branch', `${chip} chip hidden at ${size.width}`);
            continue;
          }
          await button.click();
          const paths = (await rowFacts(page)).map((r) => r.path).sort();
          const expected = snapshot.repos
            .filter((r) => r.attention.reasons.some((x) => x.level === level))
            .map((r) => r.path)
            .sort();
          check(JSON.stringify(paths) === JSON.stringify(expected), `${chip}: ${paths.length} rows, expected ${expected.length}`);
          check((await button.getAttribute('aria-pressed')) === 'true', `${chip} not pressed`);
        }
        await page.getByRole('button', { name: /^Needs attention/ }).click();
      });

      await step('sort', page, async () => {
        await page.getByLabel('Sort').selectOption('name');
        check((await page.locator('.group-head').count()) === 0, 'sorted by name still grouped');
        const names = (await rowFacts(page)).map((r) => r.name.toLowerCase());
        check(JSON.stringify(names) === JSON.stringify([...names].sort((a, b) => a.localeCompare(b))), `not sorted by name: ${names}`);
        await page.getByLabel('Sort').selectOption('attention');
        check((await page.locator('.group-head').count()) > 0, 'attention sort not grouped');
      });

      await step('search', page, async () => {
        const search = page.getByRole('searchbox', { name: 'Search repositories and branches' });
        await page.locator('body').press('/');
        check(await search.evaluate((el) => el === document.activeElement), '"/" does not focus search');
        await search.fill('tray');
        const names = (await rowFacts(page)).map((r) => r.name).sort();
        check(JSON.stringify(names) === JSON.stringify(['repowatch', 'repowatch-tray']), `search "tray" shows ${names}`);
        await search.fill('zz-no-such-repo');
        await page.getByText('No repository matches').waitFor({ timeout: 2000 });
        await shot(page, 'search-no-match');
        await inspect(page, 'search no match');
        await page.getByRole('button', { name: 'Clear search' }).click();
        check((await search.inputValue()) === '', 'Clear search did not clear');
        check((await rowFacts(page)).length > 0, 'rows did not come back');
      });

      await step('keyboard and pane', page, async () => {
        const first = page.locator('.rows [role="option"]').first();
        await first.click();
        await first.focus();
        const order = (await rowFacts(page)).map((r) => r.path);
        const focusedIs = (path, message) => waitFor(page, (p) => document.activeElement?.dataset.path === p, path, message);
        await page.keyboard.press('ArrowDown');
        await focusedIs(order[1], 'ArrowDown focuses the next row');
        await page.keyboard.press('j');
        await focusedIs(order[2], 'j focuses the next row');
        await page.keyboard.press('k');
        await focusedIs(order[1], 'k focuses the previous row');
        await page.keyboard.press('End');
        await focusedIs(order.at(-1), 'End focuses the last row');
        const tabStops = await page.locator('.rows [tabindex="0"]').count();
        check(tabStops === 1, `${tabStops} tab stops in the list`);
        await page.keyboard.press('Home');
        await focusedIs(order[0], 'Home focuses the first row');
        const selectedName = await page.locator('.rows [aria-selected="true"] .name').innerText();
        const title = await page.locator('.pane h1').innerText();
        check(title === selectedName, `pane shows ${title}, selected ${selectedName}`);
      });

      await step('pane facts and lost commits', page, async () => {
        await page.getByRole('button', { name: /^All/ }).click();
        await page.locator('.rows [role="option"]', { hasText: 'design-system' }).click();
        const pane = page.locator('.pane');
        await pane.getByText('feature/tokens').waitFor({ timeout: 2000 });
        check(await pane.getByText('5 commits').isVisible(), 'unmerged branch commit count missing');
        await page.locator('.rows [role="option"]', { hasText: /^repowatch\b/ }).first().click();
        check((await pane.getByText('Worktrees').count()) === 1, 'worktrees section missing for repowatch');
        await page.locator('.rows [role="option"]', { hasText: 'playground' }).click();
        await pane.getByRole('button', { name: 'Check for lost commits' }).click();
        await waitFor(
          page,
          () => document.querySelector('.rows [aria-label^="playground"]')?.getAttribute('aria-label')?.includes('2 lost commits'),
          null,
          'lost commit count reaches the row',
        );
        check(await pane.getByText('2 lost commits found').isVisible(), 'pane does not show the lost commit count');
        await page.getByRole('button', { name: /^Needs attention/ }).click();
      });

      await step('density', page, async () => {
        await page.getByRole('button', { name: 'Comfortable' }).click();
        await waitFor(page, () => document.querySelector('.rows [role="option"]')?.getBoundingClientRect().height === 46, null, 'comfortable rows 46 px');
        const saved = await page.evaluate(async () => (await window.__repowatchMock.getSettings()).density);
        check(saved === 'comfortable', `density saved as ${saved}`);
        await shot(page, 'dashboard-comfortable');
        await inspect(page, 'comfortable');
        await page.getByRole('button', { name: 'Compact' }).click();
        await waitFor(page, () => document.querySelector('.rows [role="option"]')?.getBoundingClientRect().height === 34, null, 'compact rows 34 px');
      });

      await step('refresh keeps search and focus', page, async () => {
        await page.getByRole('button', { name: /^All/ }).click();
        const search = page.getByRole('searchbox');
        await search.fill('o');
        await search.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(50);
        const focused = await page.evaluate(() => document.activeElement?.dataset.path);
        check(focused, 'no row focused');
        // A change on disk in another repository: a refresh snapshot.
        const before = await generation(page);
        await page.evaluate(() => {
          const m = window.__repowatchMock;
          return m.getSnapshot().then((s) => m.touch(s.repos.find((r) => r.name === 'tools').path, 'release.sh'));
        });
        await waitFor(page, (g) => window.__repowatchMock.getSnapshot().then((s) => s.generation > g), before, 'refresh snapshot');
        await page.waitForTimeout(100);
        check((await search.inputValue()) === 'o', 'search text lost on refresh');
        let now = await page.evaluate(() => document.activeElement?.dataset.path);
        check(now === focused, `focus moved from ${focused} to ${now} on refresh`);

        // The focused repository itself changes group (Clean -> Uncommitted): its row is re-created.
        await search.fill('docs');
        await search.press('ArrowDown');
        const docs = await page.evaluate(() => document.activeElement?.dataset.path);
        check(docs && docs.endsWith('docs'), 'docs row not focused');
        await page.evaluate((p) => window.__repowatchMock.touch(p, 'guide.md'), docs);
        await waitFor(page, () => document.querySelector('.rows [aria-selected="true"]')?.dataset.level === 'change', null, 'docs moved to Uncommitted');
        await page.waitForTimeout(50);
        now = await page.evaluate(() => document.activeElement?.dataset.path);
        check(now === docs, `focus lost when the row changed group (active: ${now})`);
        const live = await page.locator('[role="status"][aria-live="polite"]').innerText();
        check(live.includes('docs: 1 modified'), `live region says "${live}"`);

        // A full rescan (Ctrl R) while a row has focus.
        const g = await generation(page);
        await page.keyboard.press('Control+r');
        await waitFor(page, (x) => window.__repowatchMock.getSnapshot().then((s) => s.generation > x), g, 'rescan finished');
        await waitFor(page, () => document.querySelector('[role="status"][aria-live="polite"]')?.textContent.startsWith('Scan finished'), null, 'scan announced');
        now = await page.evaluate(() => document.activeElement?.dataset.path);
        check(now === docs, `focus lost on full rescan (active: ${now})`);
        check((await search.inputValue()) === 'docs', 'search text lost on rescan');
        // Focus elsewhere is never taken back by a refresh.
        await search.focus();
        await page.evaluate((p) => window.__repowatchMock.touch(p, 'more.md'), docs);
        await page.waitForTimeout(100);
        check(await search.evaluate((el) => el === document.activeElement), 'a refresh stole focus from search');
        await search.fill('');
      });

      await step('stale result never replaces a newer one', page, async () => {
        const old = await page.evaluate(() => window.__repowatchMock.getSnapshot());
        // A newer snapshot arrives (a repository changed) while a slow scan returns the older one.
        await page.evaluate((o) => {
          const m = window.__repowatchMock;
          const realScan = m.scan;
          m.scan = () =>
            new Promise((resolve) =>
              setTimeout(() => {
                m.scan = realScan;
                resolve(o);
              }, 400),
            );
          m.touch(o.repos.find((r) => r.name === 'infra').path, 'main.tf');
        }, old);
        await waitFor(page, () => document.querySelector('.rows [aria-label^="infra"]')?.dataset.level === 'change', null, 'newer snapshot shown');
        await page.getByRole('button', { name: 'Rescan' }).click();
        await page.waitForTimeout(700);
        const level = await page.locator('.rows [aria-label^="infra"]').getAttribute('data-level');
        check(level === 'change', `the stale scan result replaced the newer list (infra is ${level})`);
        check((await page.getByRole('button', { name: 'Rescan' }).getAttribute('aria-disabled')) === 'false', 'still scanning after the stale result');
      });

      await step('rescan progress', page, async () => {
        await page.evaluate(() => window.__repowatchMock.pause('scan'));
        await page.getByRole('button', { name: 'Rescan' }).click();
        await waitFor(page, () => document.querySelector('.rows')?.getAttribute('aria-busy') === 'true', null, 'list busy while scanning');
        check((await page.locator('.scan').innerText()) === 'Scanning…', 'title bar does not say Scanning…');
        check((await page.getByRole('button', { name: 'Rescan' }).getAttribute('aria-disabled')) === 'true', 'Rescan not disabled while scanning');
        const calls = await page.evaluate(() => window.__repowatchMock.calls.filter((c) => c.command === 'scan').length);
        // aria-disabled keeps the button focusable; a click while scanning does nothing.
        await page.getByRole('button', { name: 'Rescan' }).dispatchEvent('click');
        await page.keyboard.press('Control+r');
        const after = await page.evaluate(() => window.__repowatchMock.calls.filter((c) => c.command === 'scan').length);
        check(after === calls, 'a second click or Ctrl R started another scan');
        check((await rowFacts(page)).length > 0, 'the list disappeared during a rescan');
        await shot(page, 'rescan');
        await page.evaluate(() => window.__repowatchMock.resume('scan'));
        await waitFor(page, () => document.querySelector('.rows')?.getAttribute('aria-busy') === 'false', null, 'scan finished');
      });

      await step('failed rescan and retry', page, async () => {
        await page.evaluate(() => window.__repowatchMock.failNext('scan', { kind: 'io', message: 'cannot read C:\\Users\\dev\\Desktop: device not ready' }));
        await page.getByRole('button', { name: 'Rescan' }).click();
        const alert = page.getByRole('alert');
        await alert.waitFor({ timeout: 2000 });
        check((await alert.innerText()).includes('device not ready'), 'error text missing');
        check((await rowFacts(page)).length > 0, 'the last good list is gone after a failed rescan');
        await shot(page, 'rescan-failed');
        await inspect(page, 'rescan failed');
        await alert.getByRole('button', { name: 'Retry' }).click();
        await alert.waitFor({ state: 'detached', timeout: 2000 });
        check((await rowFacts(page)).length > 0, 'no rows after retry');
      });

      await step('theme override from settings', page, async () => {
        const other = theme === 'light' ? 'dark' : 'light';
        await page.getByRole('button', { name: 'Settings' }).click();
        await page.getByRole('heading', { name: 'Settings' }).waitFor();
        await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: other === 'dark' ? 'Dark' : 'Light' }).click();
        await waitFor(page, (t) => document.documentElement.dataset.theme === t, other, `theme switched to ${other}`);
        // Colours change after a 0.01 ms (reduced motion) transition: wait for the frame.
        await waitFor(page, (c) => getComputedStyle(document.body).backgroundColor === c, BG[other], `forced ${other} background`);
        const saved = await page.evaluate(async () => (await window.__repowatchMock.getSettings()).theme);
        check(saved === other, `theme saved as ${saved}`);
        await shot(page, `settings-forced-${other}`);
        await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'System' }).click();
        await waitFor(page, (t) => document.documentElement.dataset.theme === t, theme, 'back to the OS theme');
        await shot(page, 'settings');
        await inspect(page, 'settings');
        await page.keyboard.press('Escape');
        await waitFor(page, () => document.activeElement?.getAttribute('aria-label') === 'Settings', null, 'focus back on the Settings button');
        check((await rowFacts(page)).length > 0, 'dashboard not back after Settings');
      });

      // --- Keyboard only: dashboard -> palette -> repository -> settings -------
      await step('keyboard-only flow', page, async () => {
        const active = () => page.evaluate(() => ({ path: document.activeElement?.dataset.path ?? null, id: document.activeElement?.id ?? '', label: document.activeElement?.getAttribute('aria-label') ?? '' }));
        const snapshot = await page.evaluate(() => window.__repowatchMock.getSnapshot());
        const forja = snapshot.repos.find((r) => r.name === 'forja');
        // A repository the "At risk" filter hides.
        const docs = snapshot.repos.find((r) => r.name !== 'forja' && !r.attention.reasons.some((x) => x.level === 'risk'));

        await page.getByRole('button', { name: /^Needs attention/ }).click();
        // Tab from the window start: every stop shows a focus indicator.
        await page.locator('body').focus();
        await page.evaluate(() => document.activeElement?.blur());
        const dashboardStops = await tabWalk(page, 24);
        for (const stop of dashboardStops.filter((s) => !s.ok)) failures.push(`${tag} keyboard-only flow: no visible focus on ${stop.what}`);
        check(dashboardStops.some((s) => s.what.includes('Commands')), 'the Commands button is not a tab stop');

        // Ctrl K opens the palette with focus in its field; the window behind is inert.
        await page.locator('.rows [role="option"]').first().focus();
        const opener = (await active()).path;
        await page.keyboard.press('Control+k');
        const dialog = page.getByRole('dialog', { name: 'Command palette' });
        await dialog.waitFor({ timeout: 2000 });
        const state = await page.evaluate(() => {
          const d = document.querySelector('dialog.palette');
          const input = d.querySelector('input');
          return {
            modal: d.matches(':modal'),
            focused: document.activeElement === input,
            role: input.getAttribute('role'),
            options: d.querySelectorAll('[role="option"]').length,
            activedescendant: input.getAttribute('aria-activedescendant'),
            animation: getComputedStyle(d).animationDuration,
          };
        });
        check(state.modal && state.focused && state.role === 'combobox', `palette not modal with focus in its combobox (${JSON.stringify(state)})`);
        check(state.activedescendant, 'no highlighted option');
        check(state.animation === '1e-05s', `palette animates with reduced motion (${state.animation})`);
        // Every repository, every screen and the actions are listed.
        const optionText = await dialog.locator('[role="option"]').allInnerTexts();
        for (const repo of snapshot.repos) check(optionText.some((t) => t.startsWith(repo.name)), `palette misses ${repo.name}`);
        for (const label of ['Settings', 'Keyboard shortcuts', 'Rescan all folders', 'Add a folder to watch…', 'Show all repositories', 'Comfortable rows', 'Turn background fetch on'])
          check(optionText.some((t) => t.startsWith(label)), `palette misses "${label}"`);
        check(!optionText.some((t) => /^(Delete|Drop|Push|Pull|Commit|Discard)\b/.test(t)), 'palette offers a destructive action');
        await shot(page, 'palette');
        await inspect(page, 'palette');

        // Arrows move the highlight, Enter opens the repository: selected, focused, in the pane.
        const highlighted = () => page.evaluate(() => document.getElementById(document.querySelector('dialog.palette input').getAttribute('aria-activedescendant'))?.innerText.split('\n')[0]);
        const firstLine = (text) => text.split('\n')[0];
        const first = await highlighted();
        await page.keyboard.press('ArrowDown');
        const second = await highlighted();
        await page.keyboard.press('ArrowUp');
        check(first === firstLine(optionText[0]) && second === firstLine(optionText[1]) && (await highlighted()) === first, `arrows do not move the highlight (${first}, ${second})`);
        await page.keyboard.press('ArrowUp');
        check((await highlighted()) === firstLine(optionText.at(-1)), 'ArrowUp on the first option does not wrap to the last');
        await page.keyboard.type('forja');
        check((await highlighted()) === 'forja', `"forja" highlights ${await highlighted()}`);
        check(
          await page.evaluate(() => document.querySelector('dialog.palette [role="status"]')?.textContent.includes('result')),
          'palette result count not announced',
        );
        await shot(page, 'palette-search');
        await inspect(page, 'palette search');
        await page.keyboard.press('Enter');
        await dialog.waitFor({ state: 'detached', timeout: 2000 });
        await waitFor(page, (p) => document.activeElement?.dataset.path === p, forja.path, 'forja row focused after the palette');
        check((await page.locator('.rows [aria-selected="true"]').getAttribute('data-path')) === forja.path, 'forja not selected');
        check((await page.locator('.pane h1').innerText()) === 'forja', 'pane does not show forja');
        check(opener !== forja.path, 'test needs a different opener');

        // A repository hidden by the filter is still reachable: the filter widens.
        await page.keyboard.press('Control+k');
        await page.keyboard.type('show at risk');
        await page.keyboard.press('Enter');
        await waitFor(page, () => document.querySelector('.chips [aria-pressed="true"]')?.textContent.startsWith('At risk'), null, 'palette sets the At risk filter');
        await page.keyboard.press('Control+k');
        await page.keyboard.type(docs.name);
        await page.keyboard.press('Enter');
        await waitFor(page, (p) => document.activeElement?.dataset.path === p, docs.path, 'docs row focused (filter widened)');
        check((await page.locator('.chips [aria-pressed="true"]').innerText()).startsWith('All'), 'filter not widened to All for a hidden repository');

        // Esc closes and focus goes back where it was.
        await page.keyboard.press('Control+k');
        await dialog.waitFor({ timeout: 2000 });
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached', timeout: 2000 });
        await waitFor(page, (p) => document.activeElement?.dataset.path === p, docs.path, 'focus restored to the row after Esc');

        // A palette action with the list focused: rescan; the result is announced, focus stays.
        const g = await generation(page);
        await page.keyboard.press('Control+k');
        await page.keyboard.type('rescan');
        await page.keyboard.press('Enter');
        await waitFor(page, (x) => window.__repowatchMock.getSnapshot().then((s) => s.generation > x), g, 'rescan from the palette');
        await waitFor(page, () => document.querySelector('[role="status"][aria-atomic="true"]')?.textContent.startsWith('Scan finished'), null, 'scan announced');
        check((await active()).path === docs.path, 'the announcement moved focus');

        // To settings through the palette: the heading takes focus.
        await page.keyboard.press('Control+k');
        await page.keyboard.type('settings');
        await page.keyboard.press('Enter');
        await waitFor(page, () => document.activeElement?.id === 'settings-title', null, 'settings heading focused');
        const settingsStops = await tabWalk(page, 40);
        for (const stop of settingsStops.filter((s) => !s.ok)) failures.push(`${tag} settings: no visible focus on ${stop.what}`);
        for (const name of ['Stop watching', 'Add folder', 'Skip a folder', 'Background fetch', 'Look back', 'Show shortcuts'])
          check(settingsStops.some((s) => s.what.includes(name)), `"${name}" is not reachable with Tab (stops: ${settingsStops.map((s) => s.what).join(' | ')})`);
        await page.keyboard.press('Escape');
        await waitFor(page, () => document.activeElement?.getAttribute('aria-label') === 'Settings', null, 'Esc from settings focuses the Settings button');

        // ? shows every shortcut; Esc returns focus.
        await page.keyboard.press('Shift+?');
        const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
        await sheet.waitFor({ timeout: 2000 });
        const sheetText = await sheet.innerText();
        for (const text of ['Open the command palette', 'Rescan all watched folders', 'Search repositories and branches', 'Close and return'])
          check(sheetText.includes(text), `shortcuts do not mention "${text}"`);
        await shot(page, 'shortcuts');
        await inspect(page, 'shortcuts');
        await page.keyboard.press('Escape');
        await sheet.waitFor({ state: 'detached', timeout: 2000 });
        await waitFor(page, () => document.activeElement?.getAttribute('aria-label') === 'Settings', null, 'focus restored after the shortcuts');
        // Ctrl , opens settings from anywhere.
        await page.keyboard.press('Control+,');
        await waitFor(page, () => document.activeElement?.id === 'settings-title', null, 'Ctrl , opens settings');
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: /^Needs attention/ }).click();
      });

      await step('settings editing', page, async () => {
        const saved = () => page.evaluate(() => window.__repowatchMock.getSettings());
        await page.keyboard.press('Control+,');
        await page.getByRole('heading', { name: 'Settings' }).waitFor();
        const settingsPage = page.locator('main.settings');

        // Watched folders: add, refuse a duplicate, remove (focus stays in the list).
        await page.evaluate(() => window.__repowatchMock.setPickedFolder('C:\\Users\\dev\\Projects'));
        await settingsPage.getByRole('button', { name: 'Add folder' }).click();
        await waitFor(page, () => window.__repowatchMock.getSettings().then((s) => s.roots.includes('C:\\Users\\dev\\Projects')), null, 'root saved');
        check(await settingsPage.getByText('C:\\Users\\dev\\Projects').isVisible(), 'added folder not listed');
        await page.evaluate(() => window.__repowatchMock.setPickedFolder('C:\\Users\\dev\\desktop\\'));
        await settingsPage.getByRole('button', { name: 'Add folder' }).click();
        await settingsPage.getByText('is already in the list').waitFor({ timeout: 2000 });
        check((await saved()).roots.length === 3, 'a duplicate root was added');
        await settingsPage.getByRole('button', { name: 'Stop watching C:\\Users\\dev\\Projects' }).focus();
        await page.keyboard.press('Enter');
        await waitFor(page, () => window.__repowatchMock.getSettings().then((s) => s.roots.length === 2), null, 'root removed');
        await waitFor(page, () => document.activeElement?.getAttribute('aria-label') === 'Stop watching C:\\Users\\dev\\Documents', null, 'focus on the next Remove button after removing a folder');

        // Skipped folders.
        await page.evaluate(() => window.__repowatchMock.setPickedFolder('C:\\Users\\dev\\Desktop\\archive'));
        await settingsPage.getByRole('button', { name: 'Skip a folder' }).click();
        await waitFor(page, () => window.__repowatchMock.getSettings().then((s) => s.excluded.includes('C:\\Users\\dev\\Desktop\\archive')), null, 'exclusion saved');
        await settingsPage.getByRole('button', { name: 'Stop skipping C:\\Users\\dev\\Desktop\\archive' }).click();
        await waitFor(page, () => window.__repowatchMock.getSettings().then((s) => s.excluded.length === 0), null, 'exclusion removed');

        // Background fetch, its interval, the tray switch.
        const fetchSwitch = settingsPage.getByRole('switch', { name: 'Background fetch' });
        await fetchSwitch.click();
        await waitFor(page, () => window.__repowatchMock.getSettings().then((s) => s.backgroundFetch.enabled), null, 'background fetch on');
        check((await fetchSwitch.getAttribute('aria-checked')) === 'true', 'switch not checked');
        check((await page.locator('.statusbar').innerText()).includes('Background fetch on'), 'status bar does not say Background fetch on');
        await settingsPage.getByLabel('Fetch every').selectOption('60');
        await waitFor(page, () => window.__repowatchMock.getSettings().then((s) => s.backgroundFetch.intervalMinutes === 60), null, 'interval saved');
        await settingsPage.getByRole('switch', { name: 'Keep running in the tray' }).click();
        await waitFor(page, () => window.__repowatchMock.getSettings().then((s) => !s.closeToTray), null, 'close to tray off');

        // Lost-commit window: invalid values are explained and not saved.
        const days = settingsPage.getByLabel('Look back');
        await days.fill('400');
        await days.press('Tab');
        await settingsPage.getByText('Enter a whole number of days from 1 to 365.').waitFor({ timeout: 2000 });
        check((await days.getAttribute('aria-invalid')) === 'true', 'invalid days not marked');
        check((await saved()).lostCommitWindowDays === 30, 'an invalid window was saved');
        await days.fill('90');
        await days.press('Enter');
        await waitFor(page, () => window.__repowatchMock.getSettings().then((s) => s.lostCommitWindowDays === 90), null, 'window saved');
        check((await page.evaluate(() => document.activeElement?.id)) === 'lost-days', 'Enter in Look back moved focus away from the field');
        check((await days.inputValue()) === '90', 'Look back field does not show the saved window');
        await shot(page, 'settings-edited');
        await inspect(page, 'settings edited');
        await page.locator('main.settings').evaluate((el) => el.scrollTo(0, el.scrollHeight));
        await shot(page, 'settings-bottom');
        await inspect(page, 'settings bottom');
        await page.locator('main.settings').evaluate((el) => el.scrollTo(0, 0));

        // A failed save keeps the edit on screen; Retry saves it, focus does not drop to the page.
        await page.evaluate(() => window.__repowatchMock.failNext('updateSettings', { kind: 'io', message: 'access denied: settings.json' }));
        const density = settingsPage.getByRole('group', { name: 'Density' });
        await density.getByRole('button', { name: 'Comfortable' }).click();
        const alert = settingsPage.getByRole('alert');
        await alert.waitFor({ timeout: 2000 });
        check((await alert.innerText()).includes('access denied'), 'save error text missing');
        check((await density.getByRole('button', { name: 'Comfortable' }).getAttribute('aria-pressed')) === 'true', 'the failed edit was lost');
        check((await saved()).density === 'compact', 'failed save changed the settings');
        check((await settingsPage.locator('.save-state').innerText()) === 'Not saved', 'save state does not say Not saved');
        await shot(page, 'settings-save-failed');
        await inspect(page, 'settings save failed');
        // Leaving and coming back keeps the edit.
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+,');
        await alert.waitFor({ timeout: 2000 });
        check((await density.getByRole('button', { name: 'Comfortable' }).getAttribute('aria-pressed')) === 'true', 'the failed edit was lost after leaving settings');
        await alert.getByRole('button', { name: 'Retry' }).focus();
        await page.keyboard.press('Enter');
        await alert.waitFor({ state: 'detached', timeout: 2000 });
        check((await saved()).density === 'comfortable', 'Retry did not save the edit');
        check(await page.evaluate(() => document.activeElement?.id === 'settings-title'), 'focus dropped after Retry');
        // Discard returns to the saved values.
        await page.evaluate(() => window.__repowatchMock.failNext('updateSettings', { kind: 'io', message: 'disk full' }));
        await density.getByRole('button', { name: 'Compact' }).click();
        await alert.waitFor({ timeout: 2000 });
        await alert.getByRole('button', { name: 'Discard change' }).click();
        await alert.waitFor({ state: 'detached', timeout: 2000 });
        check((await density.getByRole('button', { name: 'Comfortable' }).getAttribute('aria-pressed')) === 'true', 'Discard did not show the saved value');
        // A failed folder picker is explained where it happened.
        await page.evaluate(() => window.__repowatchMock.failNext('pickFolder', { kind: 'io', message: 'dialog unavailable' }));
        await settingsPage.getByRole('button', { name: 'Add folder' }).click();
        await settingsPage.getByText('The folder was not added: dialog unavailable').waitFor({ timeout: 2000 });

        // Back to the starting settings for later steps.
        await density.getByRole('button', { name: 'Compact' }).click();
        await fetchSwitch.click();
        await settingsPage.getByRole('switch', { name: 'Keep running in the tray' }).click();
        await waitFor(page, () => window.__repowatchMock.getSettings().then((s) => !s.backgroundFetch.enabled && s.closeToTray && s.density === 'compact'), null, 'settings restored');
        await page.keyboard.press('Escape');
        await page.locator('main.settings').waitFor({ state: 'detached', timeout: 2000 });
        // A discarded failure is not reported again on the dashboard.
        check((await page.locator('.banner').count()) === 0, 'a discarded settings failure still shows on the dashboard');
      });
      await page.close();

      // --- Repository view: git actions with confirmations ----------------------
      // Every flow runs on the mock IPC; writes only change the mock's memory.
      const det = await open();
      const wide = size.width >= 1200;
      const callsOf = (command) =>
        det.evaluate((c) => window.__repowatchMock.calls.filter((x) => x.command === c).map((x) => x.args), command);
      const count = async (command) => (await callsOf(command)).length;
      const mockDo = (fn, arg) => det.evaluate(fn, arg);
      const liveText = () => det.evaluate(() => document.querySelector('[role="status"][aria-atomic="true"]')?.textContent ?? '');
      const activityText = () => det.evaluate(() => document.querySelector('.detail .activity')?.textContent ?? '');
      const confirmDialog = det.locator('dialog.confirm');
      const repoPath = (name) =>
        det.evaluate(async (n) => (await window.__repowatchMock.getSnapshot()).repos.find((r) => r.name === n).path, name);
      const outcome = (text, message = `"${text}" shown under the actions`) =>
        waitFor(det, (t) => document.querySelector('.detail .activity')?.textContent.includes(t), text, message);
      const readsAfter = (n, message) =>
        waitFor(det, (x) => window.__repowatchMock.calls.filter((c) => c.command === 'repoDetail').length > x, n, message);
      const readDone = () => waitFor(det, () => !document.querySelector('.detail .detail-loading'), null, 'repository read');

      /** From the dashboard (All), the row of `name`, then Enter: the view opens with its heading focused. */
      async function openDetail(name) {
        if (await det.locator('.detail').count()) {
          await det.getByRole('button', { name: 'Back to all repositories' }).click();
          await det.locator('.detail').waitFor({ state: 'detached', timeout: 2000 });
        }
        await det.getByRole('button', { name: /^All/ }).click();
        await det.locator(`.rows [role="option"][aria-label^="${name},"]`).click();
        await det.keyboard.press('Enter');
        await waitFor(det, (n) => document.activeElement?.id === 'detail-title' && document.activeElement.textContent === n, name, `${name}: heading focused after Enter`);
        await readDone();
      }

      /** Another repository while the view is open: the rail at 1440, the palette at 1024. */
      async function switchTo(name) {
        if (wide) {
          await det.locator(`.rows [role="option"][aria-label^="${name},"]`).click();
        } else {
          await det.keyboard.press('Control+k');
          await det.keyboard.type(name);
          await det.keyboard.press('Enter');
        }
        await waitFor(det, (n) => document.querySelector('.detail h1')?.textContent === n, name, `${name} shown in the repository view`);
      }

      async function confirmShown(title) {
        await det.locator('dialog.confirm[open]').waitFor({ timeout: 2000 });
        await det.waitForTimeout(50);
        const facts = await det.evaluate(() => {
          const d = document.querySelector('dialog.confirm');
          return {
            title: d.querySelector('h2').textContent,
            modal: d.matches(':modal'),
            focused: document.activeElement?.textContent,
            buttons: [...d.querySelectorAll('button')].map((b) => b.textContent),
            text: d.textContent,
          };
        });
        check(facts.title === title, `confirmation title "${facts.title}", expected "${title}"`);
        check(facts.modal, 'the confirmation is not modal');
        check(facts.focused === 'Cancel', `focus starts on "${facts.focused}", not Cancel`);
        check(facts.buttons[0] === 'Cancel' && facts.buttons.length === 2, `confirmation buttons ${facts.buttons}`);
        check(!facts.buttons.some((b) => /force/i.test(b)), `a force option in the confirmation: ${facts.buttons}`);
        return facts;
      }

      /** Answers the open confirmation: Cancel, Escape or the action's verb. */
      async function answer(choice) {
        if (choice === 'Escape') await det.keyboard.press('Escape');
        else await confirmDialog.getByRole('button', { name: choice, exact: true }).click();
        await confirmDialog.waitFor({ state: 'detached', timeout: 2000 });
      }

      await step('detail: open, files and diff', det, async () => {
        await waitFor(det, rowsReady, null, 'rows rendered');
        await openDetail('repowatch');
        const layout = await det.evaluate(() => {
          const ledger = document.querySelector('.ledger');
          const filters = document.querySelector('.filters');
          return {
            ledger: ledger ? getComputedStyle(ledger).display : 'none',
            ledgerWidth: ledger?.getBoundingClientRect().width ?? 0,
            filters: !!filters && getComputedStyle(filters).display !== 'none',
            back: (document.querySelector('.detail .back')?.getBoundingClientRect().width ?? 0) > 0,
            tabs: [...document.querySelectorAll('.detail [role="tab"]')].map((t) => t.textContent),
            side: document.querySelector('.work .side')?.getBoundingClientRect().width ?? 0,
          };
        });
        if (wide) check(layout.ledger !== 'none' && Math.round(layout.ledgerWidth) === 264, `the list is not a 264 px rail (${layout.ledger}, ${layout.ledgerWidth})`);
        else check(layout.ledger === 'none' && !layout.filters, 'the list or its filters still show beside the repository view below 1200 px');
        check(layout.back, 'no back button');
        check(Math.round(layout.side) === (wide ? 300 : 260), `files column ${layout.side} px`);
        check(JSON.stringify(layout.tabs) === JSON.stringify(['Changes7', 'Branches2', 'Stashes1', 'Lost commits·']), `tabs ${layout.tabs}`);

        // Every changed file, staged first, as the backend reports them.
        const labels = await det.locator('.detail [role="option"]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
        check(labels.length === 7, `${labels.length} file rows, expected 7`);
        check(labels[0] === 'src/ipc/client.ts, modified, staged' && labels[1] === 'src/ipc/types.ts, modified, staged', `staged rows ${labels.slice(0, 2)}`);
        check(labels.includes('docs/notes.md, untracked'), 'untracked file missing');

        // The diff of the selected file, line by line as the backend sent it.
        await det.locator('.detail [role="option"][aria-label^="src/App.tsx"]').click();
        await waitFor(det, () => document.querySelectorAll('.diff .dl').length > 0, null, 'diff lines shown');
        const path = await repoPath('repowatch');
        const diff = await det.evaluate((p) => window.__repowatchMock.fileDiff(p, 'src/App.tsx', 'unstaged'), path);
        const shown = await det.locator('.diff .dl .tx').allTextContents();
        check(JSON.stringify(shown) === JSON.stringify(diff.hunks.flatMap((h) => h.lines.map((l) => l.text))), 'diff lines differ from the backend');
        check((await det.locator('.diff .hunk').count()) === diff.hunks.length, 'hunk headers missing');
        check((await det.getByRole('button', { name: /^Stage hunk/ }).count()) === diff.hunks.length, 'Stage hunk missing');
        const signs = await det.locator('.diff .dl .sg').allTextContents();
        check(signs.includes('+') && signs.includes('−'), 'diff lines have no +/− signs');
        check(await det.locator('.diff .dl .tx').first().evaluate((el) => getComputedStyle(el).whiteSpace === 'pre'), 'diff lines wrap');
        await shot(det, 'detail-changes');
        await inspect(det, 'detail changes');

        // A binary file has no text diff.
        await det.locator('.detail [role="option"][aria-label^="src-tauri/icons/icon.png"]').click();
        await det.getByText('Binary file: there is no text diff to show.').waitFor({ timeout: 2000 });

        // File content is untrusted: markup is shown as text, never as elements.
        await det.evaluate((p) => window.__repowatchMock.touch(p, 'web/<img src=x onerror=alert(1)>.html'), path);
        const hostile = det.locator('.detail [role="option"][aria-label^="web/<img"]');
        await hostile.waitFor({ timeout: 3000 });
        await hostile.click();
        await waitFor(det, () => [...document.querySelectorAll('.diff .dl .tx')].some((t) => t.textContent.includes('<img src=x')), null, 'markup shown as text in the diff');
        check((await det.locator('.detail img, .detail [onerror]').count()) === 0, 'file content became elements');
      });

      await step('detail: stage, unstage and commit', det, async () => {
        // Space stages the focused file; the next file of the list takes its place and keeps focus.
        const readme = det.locator('.detail [role="option"][aria-label^="README.md"]');
        await readme.click();
        await readme.focus();
        const stages = await count('stageFile');
        await det.keyboard.press('Space');
        await outcome('Staged README.md.');
        await waitFor(det, () => !!document.querySelector('.detail [role="option"][aria-label="README.md, modified, staged"]'), null, 'README.md listed as staged');
        check((await count('stageFile')) === stages + 1, 'Space did not stage exactly once');
        await waitFor(
          det,
          () => document.activeElement?.getAttribute('role') === 'option' && !document.activeElement.getAttribute('aria-label').endsWith('staged'),
          null,
          'focus stays in the changes list after staging',
        );

        // One hunk from the diff.
        await det.locator('.detail [role="option"][aria-label="src/App.tsx, modified"]').click();
        await waitFor(det, () => document.querySelectorAll('.diff .hunk').length === 2, null, 'two hunks of src/App.tsx');
        await det.getByRole('button', { name: /^Stage hunk/ }).first().click();
        await outcome('Staged a hunk of src/App.tsx.');
        await waitFor(det, () => document.querySelectorAll('.diff .hunk').length === 1, null, 'one hunk left to stage');
        check((await det.locator('.detail [role="option"][aria-label="src/App.tsx, modified, staged"]').count()) === 1, 'src/App.tsx not listed as staged');
        check((await callsOf('stageHunk')).at(-1)?.[1] === 'src/App.tsx', 'stageHunk not called for src/App.tsx');

        // Unstage with the row's button.
        await det.getByRole('button', { name: 'Unstage src/ipc/types.ts' }).click();
        await outcome('Unstaged src/ipc/types.ts.');

        // Commit: disabled with a reason until there is a message.
        const commitButton = det.locator('.commit button[type="submit"]');
        check((await commitButton.getAttribute('aria-disabled')) === 'true', 'Commit enabled without a message');
        check((await det.locator('#commit-state').innerText()).includes('Write a message'), 'no reason for the disabled Commit');
        const commits = await count('commit');
        // Playwright waits for aria-disabled controls; the click is sent to the element directly.
        await commitButton.dispatchEvent('click');
        check((await count('commit')) === commits, 'Commit ran without a message');
        const field = det.getByLabel('Commit message');
        await field.fill('Add the repository view');
        await field.press('Control+Enter');
        await outcome('Committed 3 files: Add the repository view');
        check((await callsOf('commit')).at(-1)?.[1] === 'Add the repository view', 'commit message not sent');
        check((await field.inputValue()) === '', 'the message stays after a commit');
        check((await det.locator('.detail [role="option"][aria-label$=", staged"]').count()) === 0, 'staged files left after the commit');
        await waitFor(det, () => document.querySelector('[role="status"][aria-atomic="true"]')?.textContent.includes('Committed 3 files'), null, 'commit announced');
        await waitFor(det, () => document.querySelector('.detail .ref.t-sync')?.textContent.includes('3 to push'), null, 'header shows 3 to push');
      });

      await step('detail: fetch, push and pull', det, async () => {
        // A double click runs one fetch; while it runs, the other actions wait.
        await mockDo(() => window.__repowatchMock.pause('fetch'));
        const fetches = await count('fetch');
        await det.getByRole('button', { name: 'Fetch', exact: true }).dblclick();
        await waitFor(det, () => document.querySelector('.detail .activity')?.dataset.state === 'pending', null, 'fetch pending shown');
        check((await activityText()).includes('Fetching from every remote…'), 'fetch pending words missing');
        check((await det.getByRole('button', { name: /^Push/ }).getAttribute('aria-disabled')) === 'true', 'Push enabled while fetching');
        await det.getByRole('button', { name: /^Push/ }).dispatchEvent('click');
        check((await det.locator('dialog.confirm').count()) === 0, 'a confirmation opened while fetching');
        await mockDo(() => window.__repowatchMock.resume('fetch'));
        await outcome('Fetched. Local branches did not change.');
        check((await count('fetch')) === fetches + 1, `a double click ran ${(await count('fetch')) - fetches} fetches`);

        // Push asks first, naming the branch and its target; Cancel and Esc push nothing.
        const pushes = await count('push');
        const pushButton = det.getByRole('button', { name: /^Push/ });
        await pushButton.click();
        const asked = await confirmShown('Push main to origin/main?');
        check(asked.text.includes('Sends 3 commits on main to origin/main'), 'the confirmation does not say what is pushed');
        await answer('Cancel');
        await waitFor(det, () => document.activeElement?.textContent?.startsWith('Push'), null, 'focus back on Push after Cancel');
        await pushButton.click();
        await confirmShown('Push main to origin/main?');
        await answer('Escape');
        check((await count('push')) === pushes, 'Cancel or Esc pushed');

        // Confirmed: pending, then the result; the repository is read again.
        await mockDo(() => window.__repowatchMock.pause('push'));
        await pushButton.click();
        await confirmShown('Push main to origin/main?');
        await shot(det, 'detail-confirm');
        await inspect(det, 'detail confirmation');
        await answer('Push');
        await outcome('Pushing main to origin/main…');
        await shot(det, 'detail-pending');
        const reads = await count('repoDetail');
        await mockDo(() => window.__repowatchMock.resume('push'));
        await outcome('Pushed 3 commits to origin/main.');
        check((await count('push')) === pushes + 1, 'push ran more than once');
        await readsAfter(reads, 'repository read again after the push');
        await waitFor(det, () => document.querySelector('.detail .actions .btn.ink')?.getAttribute('aria-disabled') === 'true', null, 'Push still offered with nothing to push');

        // A rejected push shows git's words, and the repository is read again.
        await openDetail('api');
        await mockDo(() =>
          window.__repowatchMock.failNext('push', { kind: 'git', error: { kind: 'pushRejected', stderr: ' ! [rejected]        feature/auth -> feature/auth (fetch first)' } }),
        );
        await det.getByRole('button', { name: /^Push/ }).click();
        const first = await confirmShown('Push feature/auth to origin/feature/auth?');
        check(first.text.includes('makes it the upstream'), 'a first push does not say it sets the upstream');
        const before = await count('repoDetail');
        await answer('Push');
        await outcome('feature/auth was not pushed.');
        check((await activityText()).includes('[rejected]'), 'git error text missing');
        await readsAfter(before, 'repository read again after the failure');
        await waitFor(det, () => document.querySelector('[role="status"][aria-atomic="true"]')?.textContent.includes('feature/auth was not pushed'), null, 'failure announced');
        await shot(det, 'detail-error');
        await inspect(det, 'detail error');

        // Pull is fast-forward only: a diverged branch is not changed, and git's reason shows.
        await openDetail('data-pipeline');
        await det.getByRole('button', { name: /^Pull/ }).click();
        await outcome('main was not updated.');
        check((await activityText()).includes('cannot be fast-forwarded'), 'diverged pull reason missing');
        await openDetail('site');
        await det.getByRole('button', { name: /^Pull/ }).click();
        await outcome('Pulled origin/main into main (fast-forward).');
        check((await count('pull')) === 2, 'pull asked for a confirmation or ran twice');
      });

      await step('detail: a result for a repository left behind', det, async () => {
        await openDetail('forja');
        await mockDo(() => window.__repowatchMock.pause('push'));
        await det.getByRole('button', { name: /^Push/ }).click();
        await confirmShown('Push main to origin/main?');
        await answer('Push');
        await outcome('Pushing main to origin/main…');
        await switchTo('site');
        check(!(await activityText()).includes('Pushing'), 'the forja push shows as pending in site');
        await mockDo(() => window.__repowatchMock.resume('push'));
        await waitFor(det, () => window.__repowatchMock.getSnapshot().then((s) => s.repos.find((r) => r.name === 'forja').upstream.ahead === 0), null, 'forja pushed');
        await det.waitForTimeout(150);
        check(!(await activityText()).includes('Pushed'), 'the forja push result shows in site');
        check(!(await liveText()).includes('Pushed'), 'the forja push result was announced in site');
        check((await det.locator('.detail h1').innerText()) === 'site', 'the view left site');
        await switchTo('forja');
        await outcome('Pushed 4 commits to origin/main.', 'the forja result waits in its own view');

        // Slow reads: the repository shown last wins, whatever answers last.
        await mockDo(() => window.__repowatchMock.pause('repoDetail'));
        await switchTo('notes');
        await switchTo('docs');
        await mockDo(() => window.__repowatchMock.resume('repoDetail'));
        await readDone();
        await det.waitForTimeout(100);
        const docsPath = await repoPath('docs');
        check((await det.locator('.detail .path').innerText()) === docsPath, 'the path of another repository shows under docs');
        check((await det.locator('.detail [role="tab"]').first().innerText()).replace(/\s/g, '') === 'Changes0', 'files of another repository show under docs');
      });

      await step('detail: branches and worktrees', det, async () => {
        await openDetail('design-system');
        await det.keyboard.press('2');
        await waitFor(det, () => document.querySelector('.detail [role="tab"][aria-selected="true"]')?.textContent.startsWith('Branches'), null, '2 selects Branches');
        check((await det.evaluate(() => document.activeElement?.getAttribute('role'))) === 'tab', '2 does not focus the tab');
        // Only merged branches can be deleted; nothing anywhere offers force.
        check((await det.getByRole('button', { name: 'Delete branch old/merged' }).count()) === 1, 'merged branch has no Delete');
        check((await det.getByRole('button', { name: 'Delete branch feature/tokens' }).count()) === 0, 'an unmerged branch offers Delete');
        const controls = await det.locator('.detail button, .detail input, .detail select').evaluateAll((els) =>
          els.map((e) => `${e.getAttribute('aria-label') ?? ''} ${e.textContent} ${e.getAttribute('title') ?? ''}`),
        );
        check(!controls.some((c) => /force/i.test(c)), 'a control offers force');

        // Create: an invalid name is explained and never sent; a valid one is created.
        const name = det.getByLabel('New branch at the current commit');
        const creates = await count('createBranch');
        await name.fill('bad name');
        await det.getByRole('button', { name: 'Create branch' }).click();
        await det.getByText('A branch name cannot contain spaces.').waitFor({ timeout: 2000 });
        check((await count('createBranch')) === creates, 'an invalid branch name was sent');
        await name.fill('feature/repo-view');
        await name.press('Enter');
        await outcome('Created branch feature/repo-view.');
        check((await name.inputValue()) === '', 'the name stays after creating the branch');

        // Switch needs no confirmation.
        await det.getByRole('button', { name: 'Switch to feature/repo-view' }).click();
        await outcome('Switched to feature/repo-view.');
        await waitFor(det, () => document.querySelector('.detail .title-row .ref')?.textContent === 'feature/repo-view', null, 'header shows the new branch');
        await shot(det, 'detail-branches');
        await inspect(det, 'detail branches');

        // Delete asks first; Cancel does nothing.
        const deletes = await count('deleteBranch');
        await det.getByRole('button', { name: 'Delete branch old/merged' }).click();
        const asked = await confirmShown('Delete branch old/merged?');
        check(asked.text.includes('merged into main'), 'the confirmation does not say the commits are merged');
        await answer('Cancel');
        check((await count('deleteBranch')) === deletes, 'Cancel deleted the branch');
        await det.getByRole('button', { name: 'Delete branch old/merged' }).click();
        await confirmShown('Delete branch old/merged?');
        await answer('Delete branch');
        await outcome('Deleted branch old/merged.');
        check((await callsOf('deleteBranch')).at(-1)?.[1] === 'old/merged', 'deleteBranch not called for old/merged');
        await waitFor(det, () => !document.querySelector('.detail [aria-label="Delete branch old/merged"]'), null, 'deleted branch gone from the list');

        // Worktrees link to each other.
        await openDetail('repowatch');
        await det.getByRole('tab', { name: /^Branches/ }).click();
        await det.getByRole('button', { name: /^Show worktree .*repowatch-tray$/ }).click();
        await waitFor(det, () => document.querySelector('.detail h1')?.textContent === 'repowatch-tray', null, 'worktree shown');
      });

      await step('detail: stashes', det, async () => {
        await openDetail('design-system');
        await det.getByRole('tab', { name: /^Stashes/ }).click();
        const path = await repoPath('design-system');
        const stashes = await det.evaluate(async (p) => (await window.__repowatchMock.repoDetail(p)).stashes, path);
        await det.getByRole('button', { name: 'Apply stash@{0}' }).click();
        await confirmShown('Apply stash@{0}?');
        await answer('Apply stash');
        await outcome('Applied stash@{0}; the stash is kept.');
        check(JSON.stringify((await callsOf('applyStash')).at(-1)) === JSON.stringify([path, 0, stashes[0].oid]), 'applyStash arguments');

        const drops = await count('dropStash');
        await det.getByRole('button', { name: 'Drop stash@{1}' }).click();
        const asked = await confirmShown('Drop stash@{1}?');
        check(asked.text.includes('focus ring experiment') && asked.text.includes('Lost commits'), 'drop confirmation does not name the stash or how to undo');
        await answer('Cancel');
        check((await count('dropStash')) === drops, 'Cancel dropped the stash');
        await shot(det, 'detail-stashes');
        await inspect(det, 'detail stashes');
        await det.getByRole('button', { name: 'Drop stash@{1}' }).click();
        await confirmShown('Drop stash@{1}?');
        await answer('Drop stash');
        await outcome('Dropped stash@{1}.');
        check(JSON.stringify((await callsOf('dropStash')).at(-1)) === JSON.stringify([path, 1, stashes[1].oid]), 'dropStash arguments');
        await waitFor(det, () => document.querySelectorAll('.detail [aria-label="Stashes"] li').length === 1, null, 'one stash left');
      });

      await step('detail: lost commits and recovery', det, async () => {
        await openDetail('playground');
        await det.keyboard.press('4');
        await det.getByRole('button', { name: 'Find lost commits' }).click();
        await waitFor(det, () => document.querySelectorAll('.detail [aria-label="Lost commits"] li').length === 2, null, 'two lost commits listed');
        const path = await repoPath('playground');
        const lost = await det.evaluate(async (p) => (await window.__repowatchMock.lostCommits(p)).commits, path);
        const short = lost[0].oid.slice(0, 7);
        const recover = det.getByRole('button', { name: `Recover ${short} to a branch` });
        const recovers = await count('recoverCommit');
        await recover.click();
        const asked = await confirmShown(`Recover ${short} to a new branch?`);
        check(asked.text.includes(lost[0].subject), 'recover confirmation does not name the commit');
        const branchField = det.getByLabel('New branch name');
        check((await branchField.inputValue()) === `recovered/${short}`, 'no suggested branch name');
        await answer('Cancel');
        check((await count('recoverCommit')) === recovers, 'Cancel recovered the commit');

        await recover.click();
        await confirmShown(`Recover ${short} to a new branch?`);
        await branchField.fill('bad name');
        await det.getByText('A branch name cannot contain spaces.').waitFor({ timeout: 2000 });
        await confirmDialog.getByRole('button', { name: 'Recover to branch' }).dispatchEvent('click');
        check((await det.locator('dialog.confirm[open]').count()) === 1 && (await count('recoverCommit')) === recovers, 'an invalid branch name was sent');
        await branchField.fill('rescue/tray-badge');
        await shot(det, 'detail-lost');
        await inspect(det, 'detail lost commits');
        await answer('Recover to branch');
        await outcome(`Recovered ${short} to branch rescue/tray-badge.`);
        check(JSON.stringify((await callsOf('recoverCommit')).at(-1)) === JSON.stringify([path, lost[0].oid, 'rescue/tray-badge']), 'recoverCommit arguments');
        await waitFor(det, () => document.querySelectorAll('.detail [aria-label="Lost commits"] li').length === 1, null, 'recovered commit leaves the list');
        await waitFor(det, () => document.querySelectorAll('.detail [role="tab"]')[1]?.textContent === 'Branches2', null, 'the new branch is counted');
      });

      await step('detail: open in, read errors, keyboard', det, async () => {
        await openDetail('docs');
        const path = await repoPath('docs');
        await det.getByRole('button', { name: 'Open in VS Code' }).click();
        await outcome('Opened in VS Code.');
        check(JSON.stringify((await callsOf('openRepo')).at(-1)) === JSON.stringify([path, 'vsCode']), 'openRepo arguments');
        await mockDo(() => window.__repowatchMock.failNext('openRepo', { kind: 'openFailed', target: 'wt', message: 'Windows Terminal is not installed' }));
        await det.getByRole('button', { name: 'Open in terminal' }).click();
        await outcome('Not opened in the terminal.');
        check((await activityText()).includes('Windows Terminal is not installed'), 'open error text missing');
        await det.locator('.detail .activity').getByRole('button', { name: 'Dismiss' }).click();
        check((await det.locator('.detail .activity').count()) === 0, 'Dismiss left the result');

        // A repository git cannot read: the error and a retry.
        await openDetail('broken-repo');
        await det.locator('.detail-error').getByText('bad config line 1').waitFor({ timeout: 2000 });
        const retries = await count('repoDetail');
        await det.locator('.detail-error').getByRole('button', { name: 'Retry' }).click();
        await readsAfter(retries, 'Retry reads again');

        // Keyboard: every stop shows focus; 1-4 switch tabs; Esc goes back to the row.
        await openDetail('repowatch');
        const stops = await tabWalk(det, 40);
        for (const stop of stops.filter((s) => !s.ok)) failures.push(`${tag} repository view: no visible focus on ${stop.what}`);
        for (const name of ['Fetch', 'Push', 'Open in VS Code', 'Changes', 'Commit message'])
          check(stops.some((s) => s.what.includes(name)), `"${name}" is not reachable with Tab (stops: ${stops.map((s) => s.what).join(' | ')})`);
        check(stops.some((s) => s.key.startsWith('file-')), 'no file row is a tab stop');
        await det.locator('#detail-title').focus();
        await det.keyboard.press('4');
        await waitFor(det, () => document.activeElement?.textContent?.startsWith('Lost commits'), null, '4 focuses Lost commits');
        await det.keyboard.press('1');
        await det.keyboard.press('Escape');
        await det.locator('.detail').waitFor({ state: 'detached', timeout: 2000 });
        await waitFor(det, () => document.activeElement?.closest('.rows') && document.activeElement.getAttribute('aria-label')?.startsWith('repowatch,'), null, 'Esc focuses the repository row');
      });
      await det.close();

      // --- Settings that could not be read: retry -------------------------------
      const unread = await open('?latency=600');
      await step('settings read failure', unread, async () => {
        await unread.evaluate(() => window.__repowatchMock.failNext('getSettings', { kind: 'io', message: 'settings.json is locked' }));
        await waitFor(unread, rowsReady, null, 'rows rendered', 6000);
        await unread.getByRole('button', { name: 'Settings' }).click();
        const alert = unread.getByRole('alert').filter({ hasText: 'Settings could not be read' });
        await alert.waitFor({ timeout: 3000 });
        check((await alert.innerText()).includes('settings.json is locked'), 'read error text missing');
        await alert.getByRole('button', { name: 'Retry' }).click();
        await unread.getByRole('switch', { name: 'Background fetch' }).waitFor({ timeout: 3000 });
      });
      await unread.close();

      // --- Loading state ---------------------------------------------------
      const slow = await open('?latency=1500');
      await step('loading', slow, async () => {
        await slow.locator('.loading').waitFor({ timeout: 1000 });
        check(await slow.locator('.loading').getAttribute('aria-busy'), 'skeleton not busy');
        await shot(slow, 'loading');
        await waitFor(slow, rowsReady, null, 'rows after loading', 6000);
        check((await slow.locator('.loading').count()) === 0, 'skeleton still shown');
      });
      await slow.close();

      // --- Empty: no folders, then a folder without repositories ------------
      const empty = await open('?mock=empty');
      await step('empty: no folders', empty, async () => {
        await empty.getByRole('heading', { name: 'Choose folders to watch' }).waitFor({ timeout: 3000 });
        await shot(empty, 'empty-no-folders');
        await inspect(empty, 'empty no folders');
        await empty.getByRole('button', { name: 'Add folder' }).click();
        await empty.getByRole('heading', { name: 'No git repositories under these folders' }).waitFor({ timeout: 3000 });
        check(await empty.getByText('C:\\Users\\dev\\Projects').isVisible(), 'the searched folder is not named');
      });
      await empty.close();

      const none = await open('?mock=noRepos');
      await step('empty: no repositories', none, async () => {
        await none.getByRole('heading', { name: 'No git repositories under these folders' }).waitFor({ timeout: 3000 });
        await shot(none, 'empty-no-repos');
        await inspect(none, 'empty no repos');
        const g = await generation(none);
        await none.getByRole('button', { name: 'Rescan' }).last().click();
        await waitFor(none, (x) => window.__repowatchMock.getSnapshot().then((s) => s.generation > x), g, 'rescan from empty');
        check(await none.getByRole('heading', { name: 'No git repositories under these folders' }).isVisible(), 'empty state lost after rescan');
      });
      await none.close();

      // --- Per-repository errors and unreadable folders ----------------------
      const errs = await open('?mock=errors');
      await step('errors', errs, async () => {
        await waitFor(errs, rowsReady, null, 'rows rendered');
        const rows = await rowFacts(errs);
        const broken = rows.filter((r) => r.level === 'risk');
        check(broken.length === 2, `${broken.length} error rows, expected 2`);
        check(broken.some((r) => r.stateText.includes('dubious ownership')), 'git error text not in the row');
        check(await errs.getByText('C:\\Users\\dev\\Documents\\Locked').isVisible(), 'unreadable folder not listed');
        await errs.locator('.rows [role="option"]', { hasText: 'broken-repo' }).click();
        check(await errs.locator('.pane-error pre').innerText().then((t) => t.includes('bad config line 1')), 'pane does not show the git error');
        await shot(errs, 'errors');
        await inspect(errs, 'errors');
      });
      await errs.close();

      // --- Fifty repositories ----------------------------------------------------
      const many = await open('?mock=many');
      await step('many', many, async () => {
        await waitFor(many, rowsReady, null, 'rows rendered');
        await many.getByRole('button', { name: /^All/ }).click();
        check((await rowFacts(many)).length === 50, 'not every repository listed');
        await shot(many, 'many');
        await inspect(many, 'many');
      });
      await many.close();

      await context.close();
    }
  }

  // Motion follows the OS: the palette's 140 ms rise without reduced motion,
  // none with it (the theme loop above runs with reduced motion).
  if (!only) {
    for (const reducedMotion of ['no-preference', 'reduce']) {
      const context = await browser.newContext({ viewport: SIZES[0], reducedMotion });
      const page = await context.newPage();
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForSelector('.rows [role="option"]');
      await page.keyboard.press('Control+k');
      await page.waitForSelector('dialog.palette[open]');
      const motion = await page.evaluate(() => ({
        palette: getComputedStyle(document.querySelector('dialog.palette')).animationDuration,
        button: getComputedStyle(document.querySelector('.btn')).transitionDuration,
      }));
      const expected = reducedMotion === 'reduce' ? { palette: '1e-05s', button: '0s' } : { palette: '0.14s', button: '0.12s, 0.12s' };
      checks++;
      if (JSON.stringify(motion) !== JSON.stringify(expected)) failures.push(`motion (${reducedMotion}): ${JSON.stringify(motion)}, expected ${JSON.stringify(expected)}`);
      await context.close();
    }
  }
} catch (error) {
  failures.push(error.message);
} finally {
  await browser?.close();
  server.close();
}

if (failures.length) {
  console.error(`test:ui failed (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`test:ui passed: ${checks} checks in Edge (light and dark, 1440x900 and 1024x700), ${shots.length} screenshots in ${outDir}`);
