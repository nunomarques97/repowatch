// The one interface the UI uses to talk to the backend. `tauri.ts` implements
// it over Tauri IPC; `mock.ts` implements it in memory for UI tests and
// browser development.

import type {
  AppInfo,
  AppStatus,
  CommandError,
  DiffSide,
  FileDiff,
  GitError,
  LostCommits,
  OpenTarget,
  RepoDetail,
  RepoPath,
  ScanSnapshot,
  Settings,
} from './types';

/** Stops a subscription; safe to call more than once. */
export type Unsubscribe = () => void;

export interface RepowatchClient {
  appInfo(): Promise<AppInfo>;
  getSettings(): Promise<Settings>;
  /** Validates and saves; changed roots or exclusions start a scan. */
  updateSettings(settings: Settings): Promise<Settings>;
  getStatus(): Promise<AppStatus>;
  /** The last scan result without scanning; `null` before the first scan ends. */
  getSnapshot(): Promise<ScanSnapshot | null>;
  /** Scans now (overlapping requests share one scan) and returns the result. */
  scan(): Promise<ScanSnapshot>;

  repoDetail(repo: RepoPath): Promise<RepoDetail>;
  fileDiff(repo: RepoPath, path: string, side: DiffSide): Promise<FileDiff>;
  /** Finds lost commits in the configured window; updates the dashboard count. */
  lostCommits(repo: RepoPath): Promise<LostCommits>;

  stageFile(repo: RepoPath, path: string): Promise<void>;
  unstageFile(repo: RepoPath, path: string): Promise<void>;
  stageHunk(repo: RepoPath, path: string, hunkId: string): Promise<void>;
  unstageHunk(repo: RepoPath, path: string, hunkId: string): Promise<void>;
  commit(repo: RepoPath, message: string): Promise<void>;
  /** Read-only `git fetch --all`. */
  fetch(repo: RepoPath): Promise<void>;
  /** Fast-forward only. */
  pull(repo: RepoPath): Promise<void>;
  /** The current branch only; never forced. */
  push(repo: RepoPath): Promise<void>;
  /** At `start` (a full object id) or HEAD; does not switch. */
  createBranch(repo: RepoPath, name: string, start?: string): Promise<void>;
  switchBranch(repo: RepoPath, name: string): Promise<void>;
  /** Merged branches only. */
  deleteBranch(repo: RepoPath, name: string): Promise<void>;
  applyStash(repo: RepoPath, index: number, oid: string): Promise<void>;
  dropStash(repo: RepoPath, index: number, oid: string): Promise<void>;
  recoverCommit(repo: RepoPath, oid: string, branch: string): Promise<void>;
  openRepo(repo: RepoPath, target: OpenTarget): Promise<void>;
  /** Native folder picker; `null` when cancelled. */
  pickFolder(): Promise<string | null>;

  /** Every new snapshot (full scans and refreshes), in any order: keep the highest generation. */
  onSnapshot(handler: (snapshot: ScanSnapshot) => void): Unsubscribe;
  onStatus(handler: (status: AppStatus) => void): Unsubscribe;
  onSettings(handler: (settings: Settings) => void): Unsubscribe;
}

/** A rejected command. `error` is the backend's typed error. */
export class IpcError extends Error {
  readonly error: CommandError;

  constructor(error: CommandError) {
    super(describeError(error));
    this.name = 'IpcError';
    this.error = error;
  }
}

const COMMAND_ERROR_KINDS = new Set<CommandError['kind']>([
  'git',
  'unknownRepo',
  'busy',
  'invalidSettings',
  'notScanned',
  'openFailed',
  'io',
]);

/** Converts whatever a command rejected with into a typed `IpcError`. */
export function toIpcError(reason: unknown): IpcError {
  if (reason instanceof IpcError) {
    return reason;
  }
  if (
    typeof reason === 'object' &&
    reason !== null &&
    'kind' in reason &&
    COMMAND_ERROR_KINDS.has((reason as { kind: CommandError['kind'] }).kind)
  ) {
    return new IpcError(reason as CommandError);
  }
  // Tauri rejects with a plain string when arguments do not deserialize.
  const message =
    typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : String(reason);
  return new IpcError({ kind: 'io', message });
}

/** A sentence for the UI. Git's own output is kept verbatim. */
export function describeGitError(error: GitError): string {
  switch (error.kind) {
    case 'notInstalled':
      return 'git was not found. Install git and make sure it is on PATH.';
    case 'invalidPath':
      return `${error.path}: ${error.reason}`;
    case 'notARepository':
      return `${error.path} is not a git repository.`;
    case 'dubiousOwnership':
      return `git refuses ${error.path} because another user owns it (safe.directory).`;
    case 'refused':
      return `Refused: ${error.command}`;
    case 'invalidInput':
      return `Invalid ${error.field}: ${error.reason}`;
    case 'notFastForward':
      return 'The branch has diverged from its upstream, so it cannot be fast-forwarded. Nothing was changed.';
    case 'pushRejected':
      return `The remote rejected the push. Pull first.\n${error.stderr.trim()}`.trim();
    case 'branchNotMerged':
      return `${error.branch} has commits that are not merged, so it was not deleted.`;
    case 'branchExists':
      return `A branch named ${error.branch} already exists.`;
    case 'detachedHead':
      return 'HEAD is detached: there is no current branch.';
    case 'noUpstream':
      return `${error.branch} has no upstream branch.`;
    case 'noRemote':
      return 'This repository has no remote.';
    case 'nothingToCommit':
      return 'Nothing is staged.';
    case 'stale':
      return `The repository changed (${error.what}). Refresh and try again.`;
    case 'io':
      return error.message;
    case 'failed':
      return error.stderr.trim() || `git failed${error.code === null ? '' : ` with code ${error.code}`}.`;
    case 'parse':
      return `Unexpected git output: ${error.message}`;
  }
}

export function describeError(error: CommandError): string {
  switch (error.kind) {
    case 'git':
      return describeGitError(error.error);
    case 'unknownRepo':
      return `${error.path} is not one of the scanned repositories. Rescan and try again.`;
    case 'busy':
      return 'Another action is still running in this repository.';
    case 'invalidSettings':
      return `${error.field}: ${error.reason}`;
    case 'notScanned':
      return 'No scan has finished yet.';
    case 'openFailed':
      return `Cannot open ${error.target}: ${error.message}`;
    case 'io':
      return error.message;
  }
}
