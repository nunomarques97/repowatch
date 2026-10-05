import { describe, expect, it } from 'vitest';
import { APP_NAME, formatVersion } from './app-info';

describe('app info', () => {
  it('uses the product name', () => {
    expect(APP_NAME).toBe('Repowatch');
  });

  it('prefixes versions with v once', () => {
    expect(formatVersion('0.1.0')).toBe('v0.1.0');
    expect(formatVersion('v0.1.0')).toBe('v0.1.0');
  });

  it('handles an empty version', () => {
    expect(formatVersion('  ')).toBe('unknown version');
  });
});
