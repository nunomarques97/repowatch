// RepowatchClient over Tauri IPC. Command and event names match
// src-tauri/src/commands.rs; Tauri maps the camelCase argument names to the
// Rust snake_case parameters.

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen, type EventCallback, type UnlistenFn } from '@tauri-apps/api/event';
import { toIpcError, type RepowatchClient, type Unsubscribe } from './client';
import type { AppStatus, ScanSnapshot, Settings } from './types';

export const EVENTS = {
  snapshot: 'snapshot',
  status: 'status',
  settings: 'settings',
} as const;

export interface TauriBindings {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  listen: <T>(event: string, handler: EventCallback<T>) => Promise<UnlistenFn>;
}

const defaultBindings: TauriBindings = {
  invoke: (command, args) => tauriInvoke(command, args),
  listen: (event, handler) => tauriListen(event, handler),
};

export function createTauriClient(bindings: TauriBindings = defaultBindings): RepowatchClient {
  const call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    try {
      return await bindings.invoke<T>(command, args);
    } catch (reason) {
      throw toIpcError(reason);
    }
  };

  // Returns a synchronous unsubscribe: if it runs before `listen` resolves
  // (React StrictMode mounts, unmounts and mounts again), the listener is
  // removed as soon as it exists and the handler is never called.
  const subscribe = <T>(event: string, handler: (payload: T) => void): Unsubscribe => {
    let active = true;
    let unlisten: UnlistenFn | null = null;
    bindings
      .listen<T>(event, (message) => {
        if (active) {
          handler(message.payload);
        }
      })
      .then(
        (stop) => {
          if (active) {
            unlisten = stop;
          } else {
            stop();
          }
        },
        () => {
          // Listening failed (no permission or no Tauri): nothing to remove.
        },
      );
    return () => {
      if (!active) {
        return;
      }
      active = false;
      unlisten?.();
      unlisten = null;
    };
  };

  return {
    appInfo: () => call('app_info'),
    getSettings: () => call('get_settings'),
    updateSettings: (settings) => call('update_settings', { settings }),
    getStatus: () => call('get_status'),
    getSnapshot: () => call('get_snapshot'),
    scan: () => call('scan'),
    repoDetail: (repo) => call('repo_detail', { repo }),
    fileDiff: (repo, path, side) => call('file_diff', { repo, path, side }),
    lostCommits: (repo) => call('lost_commits', { repo }),
    stageFile: (repo, path) => call('stage_file', { repo, path }),
    unstageFile: (repo, path) => call('unstage_file', { repo, path }),
    stageHunk: (repo, path, hunkId) => call('stage_hunk', { repo, path, hunkId }),
    unstageHunk: (repo, path, hunkId) => call('unstage_hunk', { repo, path, hunkId }),
    commit: (repo, message) => call('commit', { repo, message }),
    fetch: (repo) => call('fetch', { repo }),
    pull: (repo) => call('pull', { repo }),
    push: (repo) => call('push', { repo }),
    createBranch: (repo, name, start) => call('create_branch', { repo, name, start: start ?? null }),
    switchBranch: (repo, name) => call('switch_branch', { repo, name }),
    deleteBranch: (repo, name) => call('delete_branch', { repo, name }),
    applyStash: (repo, index, oid) => call('apply_stash', { repo, index, oid }),
    dropStash: (repo, index, oid) => call('drop_stash', { repo, index, oid }),
    recoverCommit: (repo, oid, branch) => call('recover_commit', { repo, oid, branch }),
    openRepo: (repo, target) => call('open_repo', { repo, target }),
    pickFolder: () => call('pick_folder'),
    onSnapshot: (handler) => subscribe<ScanSnapshot>(EVENTS.snapshot, handler),
    onStatus: (handler) => subscribe<AppStatus>(EVENTS.status, handler),
    onSettings: (handler) => subscribe<Settings>(EVENTS.settings, handler),
  };
}
