import { describe, expect, it } from 'vitest';
import type { EventCallback, UnlistenFn } from '@tauri-apps/api/event';
import { IpcError } from './client';
import { createTauriClient, type TauriBindings } from './tauri';
import type { CommandError, ScanSnapshot } from './types';

function fakeBindings(result: (command: string, args?: Record<string, unknown>) => unknown) {
  const invoked: { command: string; args?: Record<string, unknown> }[] = [];
  const handlers = new Map<string, EventCallback<unknown>[]>();
  const pending: { resolve: () => void }[] = [];
  let stopped = 0;
  let deferListen = false;
  const bindings: TauriBindings = {
    invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
      invoked.push({ command, args });
      return result(command, args) as T;
    },
    listen: <T,>(event: string, handler: EventCallback<T>) => {
      const register = () => {
        const list = handlers.get(event) ?? [];
        list.push(handler as EventCallback<unknown>);
        handlers.set(event, list);
        const stop: UnlistenFn = () => {
          stopped += 1;
          handlers.set(
            event,
            (handlers.get(event) ?? []).filter((h) => h !== handler),
          );
        };
        return stop;
      };
      if (!deferListen) return Promise.resolve(register());
      return new Promise<UnlistenFn>((resolve) => pending.push({ resolve: () => resolve(register()) }));
    },
  };
  return {
    bindings,
    invoked,
    emit(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) {
        handler({ event, id: 1, payload });
      }
    },
    listeners: (event: string) => (handlers.get(event) ?? []).length,
    stopped: () => stopped,
    defer() {
      deferListen = true;
    },
    resolveListens() {
      for (const p of pending.splice(0)) p.resolve();
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('tauri client', () => {
  it('maps every method to its command and camelCase arguments', async () => {
    const fake = fakeBindings(() => null);
    const client = createTauriClient(fake.bindings);
    const repo = 'C:\\r';
    await client.appInfo();
    await client.getSettings();
    await client.getStatus();
    await client.getSnapshot();
    await client.scan();
    await client.repoDetail(repo);
    await client.fileDiff(repo, 'a.ts', 'staged');
    await client.lostCommits(repo);
    await client.stageFile(repo, 'a.ts');
    await client.unstageFile(repo, 'a.ts');
    await client.stageHunk(repo, 'a.ts', 'h1');
    await client.unstageHunk(repo, 'a.ts', 'h1');
    await client.commit(repo, 'msg');
    await client.fetch(repo);
    await client.pull(repo);
    await client.push(repo);
    await client.createBranch(repo, 'b');
    await client.createBranch(repo, 'c', 'f'.repeat(40));
    await client.switchBranch(repo, 'b');
    await client.deleteBranch(repo, 'b');
    await client.applyStash(repo, 0, 'a'.repeat(40));
    await client.dropStash(repo, 1, 'b'.repeat(40));
    await client.recoverCommit(repo, 'c'.repeat(40), 'rescued');
    await client.openRepo(repo, 'vsCode');
    await client.pickFolder();
    expect(fake.invoked).toEqual([
      { command: 'app_info', args: undefined },
      { command: 'get_settings', args: undefined },
      { command: 'get_status', args: undefined },
      { command: 'get_snapshot', args: undefined },
      { command: 'scan', args: undefined },
      { command: 'repo_detail', args: { repo } },
      { command: 'file_diff', args: { repo, path: 'a.ts', side: 'staged' } },
      { command: 'lost_commits', args: { repo } },
      { command: 'stage_file', args: { repo, path: 'a.ts' } },
      { command: 'unstage_file', args: { repo, path: 'a.ts' } },
      { command: 'stage_hunk', args: { repo, path: 'a.ts', hunkId: 'h1' } },
      { command: 'unstage_hunk', args: { repo, path: 'a.ts', hunkId: 'h1' } },
      { command: 'commit', args: { repo, message: 'msg' } },
      { command: 'fetch', args: { repo } },
      { command: 'pull', args: { repo } },
      { command: 'push', args: { repo } },
      { command: 'create_branch', args: { repo, name: 'b', start: null } },
      { command: 'create_branch', args: { repo, name: 'c', start: 'f'.repeat(40) } },
      { command: 'switch_branch', args: { repo, name: 'b' } },
      { command: 'delete_branch', args: { repo, name: 'b' } },
      { command: 'apply_stash', args: { repo, index: 0, oid: 'a'.repeat(40) } },
      { command: 'drop_stash', args: { repo, index: 1, oid: 'b'.repeat(40) } },
      { command: 'recover_commit', args: { repo, oid: 'c'.repeat(40), branch: 'rescued' } },
      { command: 'open_repo', args: { repo, target: 'vsCode' } },
      { command: 'pick_folder', args: undefined },
    ]);
  });

  it('rejects with typed errors', async () => {
    const error: CommandError = { kind: 'git', error: { kind: 'notFastForward' } };
    const client = createTauriClient(
      fakeBindings((command) => {
        if (command === 'pull') throw error;
        throw 'invalid args `repo` for command `push`';
      }).bindings,
    );
    const pulled = await client.pull('C:\\r').catch((e: unknown) => e);
    expect(pulled).toBeInstanceOf(IpcError);
    expect((pulled as IpcError).error).toEqual(error);
    expect((pulled as IpcError).message).toContain('fast-forwarded');
    const pushed = await client.push('C:\\r').catch((e: unknown) => e);
    expect((pushed as IpcError).error).toEqual({ kind: 'io', message: 'invalid args `repo` for command `push`' });
  });

  it('delivers events until unsubscribed', async () => {
    const fake = fakeBindings(() => null);
    const client = createTauriClient(fake.bindings);
    const seen: number[] = [];
    const stop = client.onSnapshot((snapshot) => seen.push(snapshot.generation));
    await tick();
    fake.emit('snapshot', { generation: 1 } as ScanSnapshot);
    stop();
    stop();
    fake.emit('snapshot', { generation: 2 } as ScanSnapshot);
    expect(seen).toEqual([1]);
    expect(fake.stopped()).toBe(1);
    expect(fake.listeners('snapshot')).toBe(0);
  });

  it('cleans up a listener that resolves after unsubscribe (StrictMode setup/cleanup/setup)', async () => {
    const fake = fakeBindings(() => null);
    fake.defer();
    const client = createTauriClient(fake.bindings);
    const first: string[] = [];
    const second: string[] = [];
    const stopFirst = client.onStatus(() => first.push('first'));
    stopFirst();
    const stopSecond = client.onStatus(() => second.push('second'));
    fake.resolveListens();
    await tick();
    expect(fake.listeners('status')).toBe(1);
    fake.emit('status', { scanning: true });
    expect(first).toEqual([]);
    expect(second).toEqual(['second']);
    stopSecond();
    expect(fake.listeners('status')).toBe(0);
  });

  it('ignores a failed listen', async () => {
    const client = createTauriClient({
      invoke: async () => null as never,
      listen: () => Promise.reject(new Error('event.listen not allowed')),
    });
    const stop = client.onSettings(() => {});
    await tick();
    expect(() => stop()).not.toThrow();
  });
});
