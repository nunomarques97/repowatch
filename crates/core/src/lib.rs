//! Git core for Repowatch: discovery, status parsing, analysis and the git
//! actions of the detail view.
//!
//! This crate has no Tauri dependency so it can be tested and benchmarked on
//! its own. All git operations go through the git CLI, spawned without a
//! shell; the read path never fetches and never takes optional locks, and
//! the write path can only run allow-listed, non-destructive commands (see
//! [`git`] and [`actions`]).

pub mod actions;
pub mod analysis;
pub mod attention;
pub mod diff;
pub mod discovery;
pub mod git;
pub mod lost;
pub mod status;
pub mod summary;
pub mod validate;

pub use actions::{
    apply_stash, commit, create_branch, delete_merged_branch, drop_stash, fetch, pull, push,
    recover_commit, stage_file, stage_hunk, switch_branch, unstage_file, unstage_hunk,
};

pub use analysis::{
    Branch, BranchReport, DefaultBranch, DefaultBranchSource, MergeState, Stash, Worktree,
    list_stashes, list_worktrees, read_branches,
};
pub use attention::{Attention, AttentionLevel, AttentionReason, Reason};
pub use diff::{DiffLine, DiffSide, FileDiff, Hunk, LineKind, read_file_diff};

pub use discovery::{
    DiscoveredRepo, Discovery, DiscoveryIssue, DiscoveryOptions, RepoKind, discover,
};
pub use git::{Git, GitError};
pub use lost::{LostCommit, LostCommitOptions, LostCommits, LostOrigin, find_lost_commits};
pub use status::{
    ChangeCounts, EntryKind, FileChange, Head, RepoStatus, StatusEntry, StatusReport, Upstream,
    read_status,
};
pub use summary::{
    LastCommit, RepoSummary, attention_order, needs_attention_count, sort_by_attention, summarize,
};

/// Version of the core crate, shared with the app for diagnostics.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_matches_workspace() {
        assert_eq!(VERSION, "0.1.0");
    }
}
