/* global document, getComputedStyle, innerWidth, innerHeight -- inspectPage runs in the browser */
// Renders the static design mocks in docs/design/ with the installed Microsoft
// Edge (Playwright, no browser download) and checks them:
//   - no page errors, console errors or failed requests,
//   - no horizontal overflow at 1440x900 and 1024x700,
//   - every text colour token pair has a contrast ratio of at least 4.5:1,
//     in light and dark, and so does the rendered text of every element,
//   - state colours used as dots and rails reach 3:1 against the background.
// Screenshots go to the git-ignored .artifacts/design/ folder. With --docs they
// are also written to docs/design/screenshots/ (the tracked copies).
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = join(root, '.artifacts', 'design');
const docsDir = join(root, 'docs', 'design', 'screenshots');
const writeDocs = process.argv.includes('--docs');

const MOCKS = [
  { id: 'a-ledger', file: 'docs/design/a-ledger.html' },
  { id: 'b-lanes', file: 'docs/design/b-lanes.html' },
  { id: 'c-signal', file: 'docs/design/c-signal.html' },
];
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const VIEWS = ['dashboard', 'detail'];
const THEMES = ['light', 'dark'];
const SIZES = [
  { width: 1440, height: 900 },
  { width: 1024, height: 700 },
];

// Foreground/background token pairs used for text in the design system.
const TEXT_PAIRS = [
  ['--text', '--bg'],
  ['--text', '--surface'],
  ['--text', '--surface-2'],
  ['--text', '--surface-3'],
  ['--text-2', '--bg'],
  ['--text-2', '--surface'],
  ['--text-2', '--surface-2'],
  ['--text-2', '--surface-3'],
  ['--text-3', '--bg'],
  ['--text-3', '--surface'],
  ['--text-3', '--surface-2'],
  ['--on-ink', '--ink'],
  ['--on-danger', '--danger'],
  ['--text', '--diff-add'],
  ['--text', '--diff-del'],
  ['--text-2', '--diff-hunk'],
  ['--text-3', '--diff-add'],
  ['--text-3', '--diff-del'],
  ...['clean', 'change', 'sync', 'branch', 'risk'].flatMap((s) => [
    [`--${s}-text`, '--bg'],
    [`--${s}-text`, '--surface'],
    [`--${s}-text`, '--surface-2'],
    [`--${s}-text`, `--${s}-tint`],
  ]),
  ['--clean-text', '--diff-add'],
  ['--risk-text', '--diff-del'],
];

// State dots and rails are non-text graphics: at least 3:1 against the surfaces they sit on.
const GRAPHIC_PAIRS = ['clean', 'change', 'sync', 'branch', 'risk'].flatMap((s) => [
  [`--${s}`, '--bg'],
  [`--${s}`, '--surface'],
]);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// Serves the repository read-only on 127.0.0.1 so the mocks can load fonts
// from node_modules with absolute paths.
function serve() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = normalize(join(root, decodeURIComponent(url.pathname)));
      if (path !== root && !path.startsWith(root + sep)) throw new Error('outside root');
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

// Runs in the page: token pair contrast and per-element rendered text contrast.
function inspectPage({ pairs, graphicPairs }) {
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
  function ratio(a, b) {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  }
  const probe = document.createElement('span');
  probe.style.setProperty('transition', 'none', 'important');
  document.body.append(probe);
  function token(name) {
    probe.style.color = `var(${name})`;
    return parse(getComputedStyle(probe).color);
  }
  const tokenFailures = [];
  for (const [fg, bg] of pairs) {
    const r = ratio(token(fg), token(bg));
    if (r < 4.5) tokenFailures.push(`${fg} on ${bg}: ${r.toFixed(2)} (text needs 4.5)`);
  }
  for (const [fg, bg] of graphicPairs) {
    const r = ratio(token(fg), token(bg));
    if (r < 3) tokenFailures.push(`${fg} on ${bg}: ${r.toFixed(2)} (state graphic needs 3)`);
  }
  probe.remove();

  function background(el) {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) {
        layers.push(c);
        if (c.a >= 1) break;
      }
    }
    let result = { r: 255, g: 255, b: 255, a: 1 };
    if (!layers.length || layers[layers.length - 1].a < 1) {
      result = parse(getComputedStyle(document.body).backgroundColor) ?? result;
    }
    for (let i = layers.length - 1; i >= 0; i--) result = over(layers[i], result);
    return result;
  }
  const textFailures = [];
  for (const el of document.body.querySelectorAll('*')) {
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasText) continue;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height || box.bottom < 0 || box.top > innerHeight) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || el.closest('[aria-hidden="true"]')) continue;
    const bg = background(el);
    const fg = over(parse(style.color), bg);
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    const r = ratio(fg, bg);
    if (r < (large ? 3 : 4.5)) {
      textFailures.push(`<${el.tagName.toLowerCase()} class="${el.getAttribute('class') ?? ''}"> "${el.textContent.trim().slice(0, 30)}": ${r.toFixed(2)}`);
    }
  }

  const doc = document.scrollingElement;
  const overflow = [];
  if (doc.scrollWidth > doc.clientWidth) overflow.push(`page scrollWidth ${doc.scrollWidth} > ${doc.clientWidth}`);
  for (const el of document.body.querySelectorAll('*')) {
    const box = el.getBoundingClientRect();
    if (!box.width || box.right <= innerWidth + 0.5) continue;
    // Content inside a scroll or clip container that itself fits is not page overflow.
    let clipped = false;
    for (let p = el.parentElement; p && p !== document.body && !clipped; p = p.parentElement) {
      clipped = getComputedStyle(p).overflowX !== 'visible' && p.getBoundingClientRect().right <= innerWidth + 0.5;
    }
    if (!clipped) overflow.push(`<${el.tagName.toLowerCase()} class="${el.getAttribute('class') ?? ''}"> right edge ${Math.round(box.right)} > ${innerWidth}`);
  }
  return { tokenFailures, textFailures, overflow: overflow.slice(0, 10) };
}

const failures = [];
let shots = 0;
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}/`;
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
  if (writeDocs) await mkdir(docsDir, { recursive: true });

  for (const mock of MOCKS.filter((m) => !only || m.id === only)) {
    for (const theme of THEMES) {
      for (const size of SIZES) {
        const context = await browser.newContext({ viewport: size, colorScheme: theme, reducedMotion: 'reduce', deviceScaleFactor: 1 });
        for (const view of VIEWS) {
          const label = `${mock.id} ${view} ${theme} ${size.width}x${size.height}`;
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
          page.on('console', (m) => m.type() === 'error' && errors.push(`console error: ${m.text()}`));
          page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()}`));
          page.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()}: ${r.url()}`));
          try {
            await page.goto(`${base}${mock.file}?view=${view}`, { waitUntil: 'load' });
          } catch (error) {
            failures.push(`${label}: could not load ${mock.file}: ${error.message.split('\n')[0]}`);
            await page.close();
            continue;
          }
          await page.evaluate(() => document.fonts.ready);
          const result = await page.evaluate(inspectPage, { pairs: TEXT_PAIRS, graphicPairs: GRAPHIC_PAIRS });
          const name = `${mock.id}-${view}-${theme}-${size.width}x${size.height}.png`;
          const png = await page.screenshot({ path: join(outDir, name) });
          if (writeDocs) await writeFile(join(docsDir, name), png);
          shots++;
          await page.close();
          for (const e of errors) failures.push(`${label}: ${e}`);
          for (const e of result.overflow) failures.push(`${label}: horizontal overflow: ${e}`);
          for (const e of result.textFailures) failures.push(`${label}: text contrast below minimum: ${e}`);
          // Token pairs are theme properties; report them once per theme.
          if (size.width === 1440 && view === 'dashboard') {
            for (const e of result.tokenFailures) failures.push(`${mock.id} ${theme}: token pair below minimum: ${e}`);
          }
        }
        await context.close();
      }
    }
  }
} finally {
  await browser?.close();
  server.close();
}

if (failures.length) {
  console.error(`design:check failed (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`design:check passed: ${shots} renders in Edge, no page errors, no horizontal overflow, text contrast >= 4.5:1, state graphics >= 3:1.`);
console.log(`Screenshots: ${outDir}${writeDocs ? ` and ${docsDir}` : ''}`);
