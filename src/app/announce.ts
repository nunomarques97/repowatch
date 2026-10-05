// Words for the polite live region: what changed between two snapshots.

import type { ScanSnapshot } from '../ipc';
import { reasonText } from '../features/dashboard/model';

const MAX_NAMED = 3;

function stateOf(snapshot: ScanSnapshot, path: string): string | null {
  const repo = snapshot.repos.find((r) => r.path === path);
  if (!repo) return null;
  const first = repo.attention.reasons[0];
  return first ? reasonText(first) : 'clean';
}

/** A summary after a full scan. */
export function scanSummary(snapshot: ScanSnapshot): string {
  const total = snapshot.repos.length;
  const repos = `${total} ${total === 1 ? 'repository' : 'repositories'}`;
  return `Scan finished: ${repos}, ${snapshot.attentionCount} need attention.`;
}

/**
 * Repositories whose state changed, for example "forja: 2 to push". `null`
 * when nothing visible changed. A full scan (new `scannedAt`) is summarized.
 */
export function describeUpdate(previous: ScanSnapshot | null, next: ScanSnapshot): string | null {
  if (!previous || previous.scannedAt !== next.scannedAt) return scanSummary(next);
  const changes: string[] = [];
  for (const repo of next.repos) {
    const before = stateOf(previous, repo.path);
    const after = stateOf(next, repo.path);
    if (after !== null && before !== after) changes.push(`${repo.name}: ${after}`);
  }
  if (!changes.length) return null;
  const named = changes.slice(0, MAX_NAMED).join('; ');
  const rest = changes.length - MAX_NAMED;
  return rest > 0 ? `${named}; and ${rest} more.` : `${named}.`;
}
