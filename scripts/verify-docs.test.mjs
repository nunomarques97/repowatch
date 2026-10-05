import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkDocument, findTargets, headingAnchors } from './verify-docs.mjs';

describe('findTargets', () => {
  it('finds links, images, nested images, references and HTML, with line numbers', () => {
    const markdown = [
      '# Title',
      '[guide](docs/guide.md) and ![shot](img/a.png "title")',
      '[![badge](img/b.png)](https://example.com)',
      '[ref]: <docs/ref file.md>',
      '<img src="img/c.png" alt="C"> <a href=\'LICENSE\'>licence</a>',
    ].join('\n');
    const targets = findTargets(markdown).map(({ kind, target, line }) => [kind, target, line]);
    expect(targets).toEqual(
      expect.arrayContaining([
        ['link', 'docs/guide.md', 2],
        ['image', 'img/a.png', 2],
        ['image', 'img/b.png', 3],
        ['link', 'https://example.com', 3],
        ['link', 'docs/ref file.md', 4],
        ['image', 'img/c.png', 5],
        ['link', 'LICENSE', 5],
      ]),
    );
    expect(targets).toHaveLength(7);
  });

  it('ignores code blocks and code spans', () => {
    const markdown = ['```md', '[x](missing.md)', '```', 'Use `[y](missing.md)` here.', '~~~', '![z](no.png)', '~~~'].join(
      '\n',
    );
    expect(findTargets(markdown)).toEqual([]);
  });
});

describe('headingAnchors', () => {
  it('follows GitHub slugs, including duplicates, accents and code', () => {
    const anchors = headingAnchors(
      ['# Build from source', '## 1. Name: keep "Repowatch"', '## Instalação', '## `npm run x`', '## Build from source'].join(
        '\n',
      ),
    );
    expect([...anchors]).toEqual([
      'build-from-source',
      '1-name-keep-repowatch',
      'instalação',
      'npm-run-x',
      'build-from-source-1',
    ]);
  });
});

describe('checkDocument', () => {
  let base;
  const write = (relative, content) => {
    const file = path.join(base, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-docs-test-'));
    write('docs/Guide.md', '# Guide\n\n## Install steps\n');
    write('docs/shot.png', 'png');
    write('notes.txt', 'text');
    write('ignored/out.png', 'png');
    write('outside.md', '# Outside\n');
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('accepts links and images that resolve', () => {
    const file = write(
      'README.md',
      '[g](docs/Guide.md#install-steps) [n](notes.txt) [top](#readme) [d](docs/) ![s](docs/shot.png) [w](https://x.org/a.md)\n# Readme\n',
    );
    const result = checkDocument(file, { base });
    expect(result.problems).toEqual([]);
    expect(result.external).toEqual(['https://x.org/a.md']);
  });

  it('reports every kind of broken target', () => {
    const file = write(
      'docs/BAD.md',
      [
        '[missing](nothing.md)',
        '[case](guide.md)',
        '[anchor](Guide.md#nope)',
        '[escape](../../x.md)',
        '[absolute](/docs/Guide.md)',
        '[backslash](..\\notes.txt)',
        '![text](../notes.txt)',
        '![](shot.png)',
        '![ignored](../ignored/out.png)',
        '[fragment](../notes.txt#a)',
        '[empty]()',
      ].join('\n'),
    );
    const ignored = (paths) => new Set(paths.filter((p) => p.startsWith('ignored/')));
    const { problems } = checkDocument(file, { base, ignored });
    const byLine = (line) => problems.filter((p) => p.startsWith(`docs/BAD.md:${line}:`)).join(' | ');
    expect(byLine(1)).toContain('does not exist');
    // Case-insensitive file systems find the file under another case.
    const caseInsensitive = fs.existsSync(path.join(base, 'docs', 'guide.md'));
    expect(byLine(2)).toContain(caseInsensitive ? 'letter case differs' : 'does not exist');
    expect(byLine(3)).toContain('no heading for #nope');
    expect(byLine(4)).toContain('outside the repository');
    expect(byLine(5)).toContain('relative path');
    expect(byLine(6)).toContain('relative path');
    expect(byLine(7)).toContain('not an image file');
    expect(byLine(8)).toContain('no alt text');
    expect(byLine(9)).toContain('ignored by git');
    expect(byLine(10)).toContain('not Markdown');
    expect(byLine(11)).toContain('empty link');
    expect(problems).toHaveLength(11);
  });

  it('reports a missing document', () => {
    expect(checkDocument(path.join(base, 'NOPE.md'), { base }).problems).toEqual(['NOPE.md: file is missing']);
  });
});
