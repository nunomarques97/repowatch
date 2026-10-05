// Checks that every local link and image in the project's Markdown documents
// resolves, so the README and the docs read correctly on GitHub.
//
// For each document it finds Markdown links and images (inline and reference
// definitions) and HTML <a href> / <img src>, outside code blocks and code
// spans, and checks that:
//   - the target is a relative path that stays inside the repository,
//   - it exists with exactly that letter case (GitHub is case-sensitive,
//     Windows is not),
//   - it is not ignored by git (an ignored file is never published),
//   - an image points to an image file and has alt text,
//   - a #fragment names a heading of the target Markdown file.
// Web links (https:, mailto:, ...) are listed but never requested: the check
// makes no network calls.
//
// Usage: npm run verify:docs [-- <file.md>...]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DOCUMENTS = [
  'README.md',
  'CONTRIBUTING.md',
  'DESIGN.md',
  'docs/DECISIONS.md',
  'docs/REPORT-PT.md',
  'docs/BUILD.md',
  'docs/PERFORMANCE.md',
];

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);

const blank = (text) => text.replace(/[^\n]/g, ' ');

/** Replaces fenced code blocks with spaces, keeping offsets and line breaks. */
function stripFences(markdown) {
  const lines = markdown.split('\n');
  let fence = null;
  const kept = lines.map((line) => {
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && line.trim() === open[1].trim()) {
        fence = null;
      }
      return blank(line);
    }
    if (open) {
      fence = open[1];
      return blank(line);
    }
    return line;
  });
  return kept.join('\n');
}

/** Replaces fenced code blocks and code spans with spaces, keeping offsets and line breaks. */
export function stripCode(markdown) {
  return stripFences(markdown).replace(/(`+)[\s\S]*?\1/g, (span) => blank(span));
}

/** Every link and image target in a Markdown document, with its line number. */
export function findTargets(markdown) {
  let text = stripCode(markdown);
  const targets = [];
  const lineOf = (index) => text.slice(0, index).split('\n').length;
  const add = (kind, target, index, alt) => targets.push({ kind, target, line: lineOf(index), alt });

  // Innermost first, so an image inside a link ([![alt](img)](href)) is found
  // and then replaced by placeholder text that keeps the outer link parseable.
  const inline = /(!?)\[([^[\]]*)\]\(\s*(<[^>\n]*>|[^\s)]*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
  for (;;) {
    let found = false;
    text = text.replace(inline, (match, bang, label, destination, index) => {
      found = true;
      add(bang ? 'image' : 'link', unwrap(destination), index, label);
      return '_'.repeat(match.length);
    });
    if (!found) break;
  }
  for (const match of text.matchAll(/^ {0,3}\[([^\]\n]+)\]:[ \t]*(<[^>\n]*>|\S+)/gm)) {
    add('link', unwrap(match[2]), match.index);
  }
  for (const match of text.matchAll(/<(img|a)\b([^>]*)>/gi)) {
    const attributes = match[2];
    const isImage = match[1].toLowerCase() === 'img';
    const value = new RegExp(`\\b${isImage ? 'src' : 'href'}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attributes);
    if (!value) continue;
    const alt = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes);
    add(isImage ? 'image' : 'link', value[1] ?? value[2], match.index, alt ? (alt[1] ?? alt[2]) : '');
  }
  return targets.sort((a, b) => a.line - b.line);
}

function unwrap(destination) {
  return destination.startsWith('<') ? destination.slice(1, -1) : destination;
}

/** GitHub's heading anchors for a Markdown document. */
export function headingAnchors(markdown) {
  const anchors = new Set();
  const seen = new Map();
  for (const match of stripFences(markdown).matchAll(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/gm)) {
    const text = match[1]
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/[*~`]/g, '');
    const base = text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

export function isExternal(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//');
}

/** True when the path exists with exactly this letter case in every part below `base`. */
export function existsWithCase(base, relative) {
  let current = base;
  for (const part of relative.split('/').filter((p) => p && p !== '.')) {
    if (part === '..') {
      current = path.dirname(current);
      continue;
    }
    let names;
    try {
      names = fs.readdirSync(current);
    } catch {
      return false;
    }
    if (!names.includes(part)) return false;
    current = path.join(current, part);
  }
  return true;
}

/**
 * Problems in one document. `base` is the repository root; `ignored` receives
 * repository-relative paths (forward slashes) and returns the ignored ones.
 */
export function checkDocument(file, { base = root, ignored = () => new Set() } = {}) {
  const problems = [];
  const relativeFile = path.relative(base, file).split(path.sep).join('/');
  if (!fs.existsSync(file)) {
    return { problems: [`${relativeFile}: file is missing`], external: [] };
  }
  const markdown = fs.readFileSync(file, 'utf8');
  const external = [];
  const local = [];
  for (const entry of findTargets(markdown)) {
    const where = `${relativeFile}:${entry.line}`;
    const fail = (message) => problems.push(`${where}: ${message} (${entry.target})`);
    if (entry.kind === 'image' && !entry.alt?.trim()) fail('image has no alt text');
    if (!entry.target) {
      fail('empty link');
      continue;
    }
    if (isExternal(entry.target)) {
      external.push(entry.target);
      continue;
    }
    const hash = entry.target.indexOf('#');
    const rawPath = hash === -1 ? entry.target : entry.target.slice(0, hash);
    const fragment = hash === -1 ? null : entry.target.slice(hash + 1);
    let decoded;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      fail('invalid percent-encoding');
      continue;
    }
    if (decoded.startsWith('/') || decoded.includes('\\') || /^[a-z]:/i.test(decoded)) {
      fail('use a relative path with forward slashes');
      continue;
    }
    const resolved = decoded ? path.resolve(path.dirname(file), decoded) : file;
    const inside = path.relative(base, resolved);
    if (inside.startsWith('..') || path.isAbsolute(inside)) {
      fail('target is outside the repository');
      continue;
    }
    const repoPath = inside.split(path.sep).join('/');
    if (!existsWithCase(base, repoPath)) {
      fail(fs.existsSync(resolved) ? 'letter case differs from the file on disk' : 'target does not exist');
      continue;
    }
    const stat = fs.statSync(resolved);
    if (entry.kind === 'image' && (!stat.isFile() || !IMAGE_EXTENSIONS.has(path.extname(resolved).toLowerCase()))) {
      fail('image target is not an image file');
      continue;
    }
    if (fragment !== null) {
      if (!stat.isFile() || path.extname(resolved).toLowerCase() !== '.md') {
        fail('#fragment on a file that is not Markdown');
        continue;
      }
      const anchors = headingAnchors(fs.readFileSync(resolved, 'utf8'));
      if (!anchors.has(decodeURIComponent(fragment).toLowerCase())) {
        fail(`no heading for #${fragment}`);
        continue;
      }
    }
    if (repoPath) local.push({ repoPath, where, target: entry.target });
  }
  const ignoredPaths = ignored(local.map((l) => l.repoPath));
  for (const entry of local) {
    if (ignoredPaths.has(entry.repoPath)) {
      problems.push(`${entry.where}: target is ignored by git and would not be published (${entry.target})`);
    }
  }
  return { problems, external };
}

/** Paths among `paths` that git ignores, asked in one read-only `git check-ignore` call. */
function gitIgnored(paths) {
  if (paths.length === 0) return new Set();
  const result = spawnSync('git', ['check-ignore', '--stdin'], {
    cwd: root,
    input: paths.join('\n') + '\n',
    encoding: 'utf8',
  });
  // Exit 1 means none is ignored; anything else but 0 is a git failure.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git check-ignore failed: ${result.stderr || result.error?.message}`);
  }
  return new Set(result.stdout.split(/\r?\n/).filter(Boolean));
}

function main(args) {
  const files = (args.length ? args : DOCUMENTS).map((f) => path.resolve(root, f));
  let problems = 0;
  let externalCount = 0;
  for (const file of files) {
    const result = checkDocument(file, { ignored: gitIgnored });
    externalCount += result.external.length;
    const name = path.relative(root, file).split(path.sep).join('/');
    if (result.problems.length === 0) {
      console.log(`  ok   ${name}`);
    }
    for (const problem of result.problems) {
      console.log(`  FAIL ${problem}`);
    }
    problems += result.problems.length;
  }
  console.log(`\n${files.length} documents, ${problems} problems; ${externalCount} web links not requested.`);
  if (problems > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
