//! One serializable summary per repository: everything the dashboard row,
//! the sorting and the tray badge need, plus its [`Attention`].
//!
//! A summary costs a few read-only git runs (status, remotes, branches with
//! merge counts, and the worktree list only when the repository has linked
//! worktrees). It never fails: a git error becomes the summary's `error` and
//! a `scanError` reason, so one broken repository does not break a scan.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::analysis::{Branch, DefaultBranch, Worktree, list_worktrees, read_branches};
use crate::attention::{Attention, Reason};
use crate::discovery::{DiscoveredRepo, RepoKind};
use crate::git::{Git, GitError};
use crate::status::{ChangeCounts, Head, RepoStatus, Upstream, lossy, read_status};

/// The commit HEAD points at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastCommit {
    pub oid: String,
    /// Committer time, in seconds since the Unix epoch.
    pub time: i64,
    pub subject: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    /// Root of the working tree; identifies the repository.
    pub path: PathBuf,
    /// Folder name.
    pub name: String,
    /// Main working tree or linked worktree.
    pub kind: RepoKind,
    /// `None` only when the status could not be read.
    pub head: Option<Head>,
    pub oid: Option<String>,
    pub upstream: Option<Upstream>,
    pub remotes: Vec<String>,
    pub counts: ChangeCounts,
    pub stash_count: u32,
    pub last_commit: Option<LastCommit>,
    pub default_branch: Option<DefaultBranch>,
    pub branch_count: u32,
    /// Local branches with commits not in the default branch.
    pub unmerged_branches: Vec<Branch>,
    /// Every working tree, main first, when the repository has linked
    /// worktrees; empty otherwise.
    pub worktrees: Vec<Worktree>,
    /// Lost commits in the window; `None` until counted on demand.
    pub lost_commits: Option<u32>,
    /// The first git error met while reading the repository.
    pub error: Option<GitError>,
    pub attention: Attention,
}

impl RepoSummary {
    /// Records the result of an on-demand lost-commit count and updates the
    /// attention.
    pub fn set_lost_commits(&mut self, count: u32) {
        self.lost_commits = Some(count);
        self.attention = Attention::from_reasons(self.reasons());
    }

    /// The issues of this repository, in [`Reason`] variant order.
    pub fn reasons(&self) -> Vec<Reason> {
        let mut reasons = Vec::new();
        if let Some(error) = &self.error {
            reasons.push(Reason::ScanError {
                message: error.to_string(),
            });
        }
        let counts = self.counts;
        if counts.conflicted > 0 {
            reasons.push(Reason::Conflicts {
                count: counts.conflicted,
            });
        }
        if self.head == Some(Head::Detached) {
            reasons.push(Reason::DetachedHead);
        }
        if let Some(count) = self.lost_commits.filter(|count| *count > 0) {
            reasons.push(Reason::LostCommits { count });
        }
        if counts.staged > 0 {
            reasons.push(Reason::Staged {
                count: counts.staged,
            });
        }
        if counts.unstaged > 0 {
            reasons.push(Reason::Unstaged {
                count: counts.unstaged,
            });
        }
        if counts.untracked > 0 {
            reasons.push(Reason::Untracked {
                count: counts.untracked,
            });
        }
        if let Some(upstream) = &self.upstream {
            if upstream.ahead > 0 {
                reasons.push(Reason::Ahead {
                    count: upstream.ahead,
                });
            }
            if upstream.behind > 0 {
                reasons.push(Reason::Behind {
                    count: upstream.behind,
                });
            }
        }
        let on_branch = matches!(self.head, Some(Head::Branch { .. }));
        let has_remote = !self.remotes.is_empty();
        if on_branch && has_remote && self.upstream.is_none() {
            reasons.push(Reason::NoUpstream);
        }
        if self.upstream.as_ref().is_some_and(|upstream| upstream.gone) {
            reasons.push(Reason::UpstreamGone);
        }
        if self.head.is_some() && self.oid.is_some() && !has_remote {
            reasons.push(Reason::NoRemote);
        }
        if !self.unmerged_branches.is_empty() {
            reasons.push(Reason::UnmergedBranches {
                count: u32::try_from(self.unmerged_branches.len()).unwrap_or(u32::MAX),
            });
        }
        if self.stash_count > 0 {
            reasons.push(Reason::Stashes {
                count: self.stash_count,
            });
        }
        reasons
    }
}

/// Reads the summary of a discovered repository or worktree. Never fetches,
/// never writes, never fails (errors are recorded in the summary).
pub fn summarize(git: &Git, repo: &DiscoveredRepo) -> RepoSummary {
    let mut summary = RepoSummary {
        path: repo.path.clone(),
        name: repo
            .path
            .file_name()
            .map_or_else(|| repo.path.display().to_string(), lossy_os),
        kind: repo.kind.clone(),
        head: None,
        oid: None,
        upstream: None,
        remotes: Vec::new(),
        counts: ChangeCounts::default(),
        stash_count: 0,
        last_commit: None,
        default_branch: None,
        branch_count: 0,
        unmerged_branches: Vec::new(),
        worktrees: Vec::new(),
        lost_commits: None,
        error: None,
        attention: Attention::from_reasons(Vec::new()),
    };
    if let Err(error) = fill(git, repo, &mut summary) {
        summary.error = Some(error);
    }
    summary.attention = Attention::from_reasons(summary.reasons());
    summary
}

fn fill(git: &Git, repo: &DiscoveredRepo, summary: &mut RepoSummary) -> Result<(), GitError> {
    let RepoStatus {
        remotes, report, ..
    } = read_status(git, &repo.path)?;
    summary.head = Some(report.head.clone());
    summary.oid = report.oid.clone();
    summary.upstream = report.upstream;
    summary.remotes = remotes;
    summary.counts = report.counts;
    summary.stash_count = report.stash_count;

    let branches = read_branches(git, &repo.path)?;
    summary.branch_count = u32::try_from(branches.branches.len()).unwrap_or(u32::MAX);
    summary.last_commit = match (branches.head(), &report.oid) {
        (Some(branch), Some(oid)) if &branch.oid == oid => Some(LastCommit {
            oid: branch.oid.clone(),
            time: branch.commit_time,
            subject: branch.subject.clone(),
        }),
        (_, Some(_)) => Some(read_head_commit(git, &repo.path)?),
        (_, None) => None,
    };
    summary.unmerged_branches = branches.unmerged().cloned().collect();
    summary.default_branch = branches.default_branch;

    if has_linked_worktrees(repo) {
        summary.worktrees = list_worktrees(git, &repo.path)?;
    }
    Ok(())
}

/// Reads HEAD's commit when HEAD is not on a branch.
fn read_head_commit(git: &Git, repo: &Path) -> Result<LastCommit, GitError> {
    let output = git.read(
        repo,
        &[
            "log",
            "-1",
            "--no-show-signature",
            "--format=%H%x1f%ct%x1f%s",
            "HEAD",
        ],
    )?;
    let text = lossy(&output);
    let mut fields = text.trim_end_matches(['\r', '\n']).splitn(3, '\x1f');
    match (fields.next(), fields.next(), fields.next()) {
        (Some(oid), Some(time), Some(subject)) => Ok(LastCommit {
            oid: oid.to_string(),
            time: crate::analysis::parse_i64(time)?,
            subject: subject.to_string(),
        }),
        _ => Err(crate::status::parse_error(format!(
            "malformed HEAD commit {text:?}"
        ))),
    }
}

/// Linked worktrees exist (or existed) when the shared git folder has a
/// `worktrees` folder; checking it saves a git run for most repositories.
fn has_linked_worktrees(repo: &DiscoveredRepo) -> bool {
    match &repo.kind {
        RepoKind::Main => repo.git_dir.join("worktrees").is_dir(),
        RepoKind::LinkedWorktree { .. } => true,
    }
}

fn lossy_os(name: &std::ffi::OsStr) -> String {
    name.to_string_lossy().into_owned()
}

/// Dashboard order: most severe level first, then name (ignoring case), then
/// path.
pub fn attention_order(a: &RepoSummary, b: &RepoSummary) -> Ordering {
    b.attention
        .level
        .cmp(&a.attention.level)
        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        .then_with(|| a.path.cmp(&b.path))
}

/// Sorts summaries in [`attention_order`].
pub fn sort_by_attention(summaries: &mut [RepoSummary]) {
    summaries.sort_by(attention_order);
}

/// Number of repositories that need attention: the tray badge count.
pub fn needs_attention_count(summaries: &[RepoSummary]) -> usize {
    summaries
        .iter()
        .filter(|summary| summary.attention.needs_attention)
        .count()
}
