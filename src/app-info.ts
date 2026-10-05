export const APP_NAME = 'Repowatch';

/** Formats a semver string for display, for example "v0.1.0". */
export function formatVersion(version: string): string {
  const trimmed = version.trim();
  if (trimmed === '') {
    return 'unknown version';
  }
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}
