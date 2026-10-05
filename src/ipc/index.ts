// Entry point of the IPC layer. Inside the Tauri app the client talks to the
// Rust backend; in a plain browser (UI tests, `npm run dev` without Tauri) it
// is the in-memory mock, whose scenario can be chosen with `?mock=<name>` and
// whose command delay with `?latency=<ms>` (to see loading states).

import { isTauri } from '@tauri-apps/api/core';
import type { RepowatchClient } from './client';
import { MOCK_SCENARIOS, type MockScenario } from './mock-data';
import { createMockClient, type MockClient } from './mock';
import { createTauriClient } from './tauri';

export * from './types';
export { IpcError, describeError, describeGitError, toIpcError } from './client';
export type { RepowatchClient, Unsubscribe } from './client';
export { createMockClient, attentionOrder, reasonLevel } from './mock';
export type { MockClient, MockCommand, MockCall, MockOptions } from './mock';
export { MOCK_SCENARIOS } from './mock-data';
export type { MockScenario } from './mock-data';
export { createTauriClient } from './tauri';

declare global {
  interface Window {
    /** The mock client, exposed for browser tests (never set inside Tauri). */
    __repowatchMock?: MockClient;
  }
}

/** The mock scenario named in a URL query (`?mock=empty`), or `default`. */
export function scenarioFromSearch(search: string): MockScenario {
  const name = new URLSearchParams(search).get('mock');
  return MOCK_SCENARIOS.find((scenario) => scenario === name) ?? 'default';
}

/** The mock's command delay from a URL query (`?latency=800`), 0 to 10 s; 0 when absent. */
export function latencyFromSearch(search: string): number {
  const value = Number(new URLSearchParams(search).get('latency'));
  return Number.isFinite(value) ? Math.min(10_000, Math.max(0, Math.round(value))) : 0;
}

let client: RepowatchClient | null = null;

/** The app's client, created once. */
export function getClient(): RepowatchClient {
  if (!client) {
    if (isTauri()) {
      client = createTauriClient();
    } else {
      const { search } = window.location;
      const mock = createMockClient({ scenario: scenarioFromSearch(search), latencyMs: latencyFromSearch(search) });
      window.__repowatchMock = mock;
      client = mock;
    }
  }
  return client;
}
