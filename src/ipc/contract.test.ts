import { describe, expect, it } from 'vitest';
import { describeError, toIpcError } from './client';
import * as contract from './contract.generated';
import { createMockClient, reasonLevel } from './mock';

/** Object keys at every depth, as `a.b.c` paths (array items share `[]`). */
function shape(value: unknown, prefix = ''): Set<string> {
  const keys = new Set<string>();
  if (Array.isArray(value)) {
    for (const item of value) for (const key of shape(item, `${prefix}[]`)) keys.add(key);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.add(`${prefix}.${key}`);
      for (const nested of shape(child, `${prefix}.${key}`)) keys.add(nested);
    }
  }
  return keys;
}

describe('IPC contract samples (from the Rust types)', () => {
  it('describe every command error and wrap it unchanged', () => {
    const kinds = new Set<string>();
    for (const error of contract.commandErrors) {
      kinds.add(error.kind === 'git' ? `git:${error.error.kind}` : error.kind);
      expect(describeError(error).length).toBeGreaterThan(0);
      expect(toIpcError(error).error).toBe(error);
    }
    expect(kinds.size).toBe(contract.commandErrors.length);
  });

  it('give every reason the level the backend gives it', () => {
    const reasons = contract.snapshot.repos[0]!.attention.reasons;
    expect(reasons).toHaveLength(14);
    for (const reason of reasons) {
      expect(reasonLevel(reason), reason.kind).toBe(reason.level);
    }
  });

  it('have the same fields as the mock values', async () => {
    const mock = createMockClient();
    const snapshot = await mock.scan();
    const repowatch = snapshot.repos.find((r) => r.name === 'repowatch')!;
    // Every field the mock produces exists in the Rust output.
    const rust = shape(contract.snapshot.repos);
    for (const key of shape([repowatch])) {
      expect(rust, key).toContain(key);
    }
    expect(Object.keys(repowatch).sort()).toEqual(Object.keys(contract.snapshot.repos[0]!).sort());
    expect(Object.keys(snapshot).sort()).toEqual(Object.keys(contract.snapshot).sort());

    const detail = await mock.repoDetail(repowatch.path);
    const rustDetail = shape(contract.repoDetail);
    for (const key of shape(detail)) {
      expect(rustDetail, key).toContain(key);
    }
    const diff = await mock.fileDiff(repowatch.path, 'src/App.tsx', 'unstaged');
    const rustDiff = shape(contract.fileDiff);
    for (const key of shape(diff)) {
      expect(rustDiff, key).toContain(key);
    }
    expect(Object.keys(await mock.getSettings()).sort()).toEqual(Object.keys(contract.settings).sort());
    expect(Object.keys(await mock.getStatus()).sort()).toEqual(Object.keys(contract.appStatus).sort());
    expect(Object.keys(await mock.appInfo()).sort()).toEqual(Object.keys(contract.appInfo).sort());
    const lost = await mock.lostCommits(snapshot.repos.find((r) => r.name === 'playground')!.path);
    for (const key of shape(lost)) {
      expect(shape(contract.lostCommits), key).toContain(key);
    }
  });

  it('have background fetch off by default', () => {
    expect(contract.settings.backgroundFetch.enabled).toBe(false);
  });
});
