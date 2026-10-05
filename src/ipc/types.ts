// IPC types: the JSON the Rust commands and events exchange (serde, camelCase).
// `contract.generated.ts` is written by the Rust tests from real Rust values
// and typed with these types, so `npm run typecheck` catches any drift.

/** Absolute path as reported by the backend; sent back unchanged. */
export type RepoPath = string;
/** Full hexadecimal object id. */
export type Oid = string;
/** Seconds since the Unix epoch. */
export type UnixSeconds = number;
/** Milliseconds since the Unix epoch. */
export type UnixMillis = number;

// Settings

export type Theme = 'system' | 'light' | 'dark';
export type Density = 'compact' | 'comfortable';

export interface BackgroundFetchSettings {
  /** Off by default. */
  enabled: boolean;
  /** 5 to 1440. */
  intervalMinutes: number;
}

export interface Settings {
  /** Absolute folders searched for repositories. */
  roots: string[];
  /** Absolute folders skipped with everything below them. */
  excluded: string[];
  theme: Theme;
  density: Density;
  backgroundFetch: BackgroundFetchSettings;
  /** 1 to 365; lost commits older than this are not shown. */
  lostCommitWindowDays: number;
  /** Closing the window keeps the app running in the tray. */
  closeToTray: boolean;
}

// Repository summary (dashboard row)

export type RepoKind =
  | { kind: 'main' }
  | { kind: 'linkedWorktree'; commonDir: string; mainPath: string | null };

export type Head =
  | { kind: 'branch'; name: string }
  | { kind: 'unborn'; name: string }
  | { kind: 'detached' };

export interface Upstream {
  /** For example `origin/main`. */
  name: string;
  /** Unpushed commits. */
  ahead: number;
  /** Commits to pull, as of the last fetch. */
  behind: number;
  /** Configured but deleted on the remote. */
  gone: boolean;
}

export interface ChangeCounts {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

export interface LastCommit {
  oid: Oid;
  time: UnixSeconds;
  subject: string;
}

export type DefaultBranchSource = 'originHead' | 'conventional';

export interface DefaultBranch {
  name: string;
  source: DefaultBranchSource;
  local: boolean;
  remote: string | null;
}

export interface MergeState {
  /** Commits not in the default branch; 0 means merged. */
  ahead: number;
  behind: number;
}

export interface Branch {
  name: string;
  oid: Oid;
  isHead: boolean;
  isDefault: boolean;
  upstream: string | null;
  upstreamGone: boolean;
  commitTime: UnixSeconds;
  subject: string;
  /** `null` for the default branch or when there is none. */
  merge: MergeState | null;
}

export interface Worktree {
  path: string;
  oid: Oid | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
  isMain: boolean;
}

/** DESIGN.md categories, from least to most severe. */
export type AttentionLevel = 'clean' | 'branch' | 'sync' | 'change' | 'risk';

export type Reason =
  | { kind: 'scanError'; message: string }
  | { kind: 'conflicts'; count: number }
  | { kind: 'detachedHead' }
  | { kind: 'lostCommits'; count: number }
  | { kind: 'staged'; count: number }
  | { kind: 'unstaged'; count: number }
  | { kind: 'untracked'; count: number }
  | { kind: 'ahead'; count: number }
  | { kind: 'behind'; count: number }
  | { kind: 'noUpstream' }
  | { kind: 'upstreamGone' }
  | { kind: 'noRemote' }
  | { kind: 'unmergedBranches'; count: number }
  | { kind: 'stashes'; count: number };

export type ReasonKind = Reason['kind'];

export type AttentionReason = Reason & { level: AttentionLevel };

export interface Attention {
  level: AttentionLevel;
  needsAttention: boolean;
  /** Most severe first. */
  reasons: AttentionReason[];
}

export interface RepoSummary {
  /** Identifies the repository in every command. */
  path: RepoPath;
  name: string;
  kind: RepoKind;
  /** `null` only when the status could not be read. */
  head: Head | null;
  oid: Oid | null;
  upstream: Upstream | null;
  remotes: string[];
  counts: ChangeCounts;
  stashCount: number;
  lastCommit: LastCommit | null;
  defaultBranch: DefaultBranch | null;
  branchCount: number;
  unmergedBranches: Branch[];
  /** Every working tree when the repository has linked worktrees. */
  worktrees: Worktree[];
  /** `null` until counted on demand (`lostCommits` command). */
  lostCommits: number | null;
  error: GitError | null;
  attention: Attention;
}

export interface DiscoveryIssue {
  path: string;
  message: string;
}

export interface ScanSnapshot {
  /** Increases with every change; keep the highest seen. */
  generation: number;
  scannedAt: UnixMillis;
  durationMs: number;
  roots: string[];
  /** In attention order. */
  repos: RepoSummary[];
  issues: DiscoveryIssue[];
  /** Repositories needing attention (the tray badge). */
  attentionCount: number;
}

// Repository detail

export type FileChange =
  | 'unmodified'
  | 'modified'
  | 'typeChanged'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'unmerged';

export type EntryKind = 'changed' | 'renamed' | 'conflicted' | 'untracked';

export interface StatusEntry {
  kind: EntryKind;
  /** Relative to the repository root, `/` separators; folders end with `/`. */
  path: string;
  originalPath: string | null;
  index: FileChange;
  worktree: FileChange;
}

export interface StatusReport {
  oid: Oid | null;
  head: Head;
  upstream: Upstream | null;
  stashCount: number;
  counts: ChangeCounts;
  entries: StatusEntry[];
}

/** The status report with the repository's path and remotes (flattened). */
export interface RepoStatus extends StatusReport {
  path: string;
  remotes: string[];
}

export interface BranchReport {
  defaultBranch: DefaultBranch | null;
  branches: Branch[];
}

export interface Stash {
  index: number;
  oid: Oid;
  time: UnixSeconds;
  message: string;
  parents: Oid[];
}

export interface RepoDetail {
  path: RepoPath;
  name: string;
  kind: RepoKind;
  status: RepoStatus;
  branches: BranchReport;
  stashes: Stash[];
  worktrees: Worktree[];
}

export type DiffSide = 'unstaged' | 'staged' | 'untracked';
export type LineKind = 'context' | 'added' | 'removed' | 'noNewline';

export interface DiffLine {
  kind: LineKind;
  /** Untrusted file content: render as text only. */
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface Hunk {
  /** Pass to stageHunk / unstageHunk. */
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  side: DiffSide;
  binary: boolean;
  hunks: Hunk[];
  truncated: boolean;
}

export type LostOrigin = 'reflog' | 'dangling';

export interface LostCommit {
  oid: Oid;
  parents: Oid[];
  time: UnixSeconds;
  author: string;
  subject: string;
  origin: LostOrigin;
}

export interface LostCommits {
  /** Newest first. */
  commits: LostCommit[];
  windowDays: number;
  truncated: boolean;
}

// App

export interface AppStatus {
  scanning: boolean;
  watchedRepos: number;
  backgroundFetchRunning: boolean;
  lastBackgroundFetchAt: UnixMillis | null;
}

export interface AppInfo {
  version: string;
  coreVersion: string;
  configDir: string;
}

export type OpenTarget = 'vsCode' | 'terminal' | 'fileManager';

// Errors

export type GitError =
  | { kind: 'notInstalled' }
  | { kind: 'invalidPath'; path: string; reason: string }
  | { kind: 'notARepository'; path: string }
  | { kind: 'dubiousOwnership'; path: string }
  | { kind: 'refused'; command: string }
  | { kind: 'invalidInput'; field: string; reason: string }
  | { kind: 'notFastForward' }
  | { kind: 'pushRejected'; stderr: string }
  | { kind: 'branchNotMerged'; branch: string }
  | { kind: 'branchExists'; branch: string }
  | { kind: 'detachedHead' }
  | { kind: 'noUpstream'; branch: string }
  | { kind: 'noRemote' }
  | { kind: 'nothingToCommit' }
  | { kind: 'stale'; what: string }
  | { kind: 'io'; message: string }
  | { kind: 'failed'; code: number | null; stderr: string }
  | { kind: 'parse'; message: string };

/** What every command rejects with. */
export type CommandError =
  | { kind: 'git'; error: GitError }
  | { kind: 'unknownRepo'; path: string }
  | { kind: 'busy'; path: string }
  | { kind: 'invalidSettings'; field: string; reason: string }
  | { kind: 'notScanned' }
  | { kind: 'openFailed'; target: string; message: string }
  | { kind: 'io'; message: string };
