//! Lost commits: commits that no branch, tag, remote-tracking ref or HEAD
//! reaches any more.
//!
//! They come from deleted branches, `reset --hard`, amended or rebased
//! commits (still listed in a reflog) and dropped stashes (dangling: listed
//! nowhere). git keeps them until garbage collection prunes them, so they can
//! still be recovered to a branch.
//!
//! Detection walks every object (`git fsck --connectivity-only`), which is
//! too slow for the dashboard scan on large repositories, so it runs on
//! demand for one repository at a time. Only commits whose committer date is
//! inside the window (30 days by default, git's own default for expiring
//! unreachable reflog entries) are reported. Stash entries and the index and
//! untracked-files commits that make up a stash are not lost commits.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::analysis::{check_oid, list_stashes, parse_i64};
use crate::git::{Git, GitError};
use crate::status::{lossy, parse_error};

/// Default window, in days.
pub const DEFAULT_WINDOW_DAYS: u32 = 30;
/// Default maximum number of commits returned.
pub const DEFAULT_LIMIT: usize = 200;
/// Object ids passed per `git log` run, well under the Windows command-line
/// limit (32 767 characters).
const LOG_CHUNK: usize = 400;

const SECONDS_PER_DAY: i64 = 86_400;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LostCommitOptions {
    /// Only commits whose committer date is at most this many days old.
    pub window_days: u32,
    /// Maximum number of commits returned (newest first).
    pub limit: usize,
}

impl Default for LostCommitOptions {
    fn default() -> Self {
        Self {
            window_days: DEFAULT_WINDOW_DAYS,
            limit: DEFAULT_LIMIT,
        }
    }
}

/// Where a lost commit can still be seen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LostOrigin {
    /// Listed in a reflog only (deleted branch, hard reset, amend, rebase).
    Reflog,
    /// Referenced by nothing (for example a dropped stash).
    Dangling,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LostCommit {
    pub oid: String,
    pub parents: Vec<String>,
    /// Committer time, in seconds since the Unix epoch.
    pub time: i64,
    pub author: String,
    pub subject: String,
    pub origin: LostOrigin,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LostCommits {
    /// Newest first.
    pub commits: Vec<LostCommit>,
    pub window_days: u32,
    /// More commits matched than `limit`; the oldest were left out.
    pub truncated: bool,
}

/// Finds the lost commits of the repository at `repo` (any of its working
/// trees). Read-only: never writes to the repository or fetches.
pub fn find_lost_commits(
    git: &Git,
    repo: &Path,
    options: &LostCommitOptions,
) -> Result<LostCommits, GitError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX)
        });
    let cutoff = now.saturating_sub(i64::from(options.window_days) * SECONDS_PER_DAY);
    let mut result = LostCommits {
        commits: Vec::new(),
        window_days: options.window_days,
        truncated: false,
    };

    let fsck = git.read(
        repo,
        &[
            "fsck",
            "--unreachable",
            "--no-reflogs",
            "--connectivity-only",
            "--no-progress",
        ],
    )?;
    let mut unreachable = parse_fsck(&fsck)?;
    if unreachable.is_empty() {
        return Ok(result);
    }
    // Older stash entries are reachable only through the stash reflog.
    for stash in list_stashes(git, repo)? {
        unreachable.remove(&stash.oid);
        for parent in &stash.parents {
            unreachable.remove(parent);
        }
    }
    if unreachable.is_empty() {
        return Ok(result);
    }

    let mut oids: Vec<String> = unreachable.into_iter().collect();
    oids.sort_unstable();
    let mut details = Vec::with_capacity(oids.len());
    for chunk in oids.chunks(LOG_CHUNK) {
        let mut args = vec![
            "log",
            "--no-walk=unsorted",
            "--no-show-signature",
            "--format=%H%x1f%P%x1f%ct%x1f%an%x1f%s%x1e",
        ];
        args.extend(chunk.iter().map(String::as_str));
        details.extend(parse_log(&git.read(repo, &args)?)?);
    }
    let stash_parts = dropped_stash_parts(&details);
    let mut commits: Vec<LostCommit> = details
        .into_iter()
        .filter(|commit| commit.time >= cutoff && !stash_parts.contains(&commit.oid))
        .collect();
    if commits.is_empty() {
        return Ok(result);
    }

    let reflog_only: HashSet<String> = git
        .read(repo, &["rev-list", "--reflog", "--not", "--all"])
        .map(|output| {
            lossy(&output)
                .lines()
                .map(|line| line.trim().to_string())
                .collect()
        })?;
    for commit in &mut commits {
        if reflog_only.contains(&commit.oid) {
            commit.origin = LostOrigin::Reflog;
        }
    }
    commits.sort_by(|a, b| b.time.cmp(&a.time).then_with(|| a.oid.cmp(&b.oid)));
    result.truncated = commits.len() > options.limit;
    commits.truncate(options.limit);
    result.commits = commits;
    Ok(result)
}

/// Commit ids from `git fsck --unreachable` (`unreachable commit <oid>` or,
/// for some git versions and errors, `dangling commit <oid>`).
fn parse_fsck(output: &[u8]) -> Result<HashSet<String>, GitError> {
    let mut commits = HashSet::new();
    for line in lossy(output).lines() {
        let mut words = line.split_whitespace();
        if let (Some("unreachable" | "dangling"), Some("commit"), Some(oid)) =
            (words.next(), words.next(), words.next())
        {
            check_oid(oid)?;
            commits.insert(oid.to_string());
        }
    }
    Ok(commits)
}

/// Parses `git log --format=%H%x1f%P%x1f%ct%x1f%an%x1f%s%x1e`. Every commit
/// starts as dangling; the caller marks the ones a reflog lists.
fn parse_log(output: &[u8]) -> Result<Vec<LostCommit>, GitError> {
    output
        .split(|byte| *byte == 0x1e)
        .map(|record| record.strip_prefix(b"\n").unwrap_or(record))
        .filter(|record| !record.is_empty())
        .map(|record| {
            let fields: Vec<&[u8]> = record.splitn(5, |byte| *byte == 0x1f).collect();
            if fields.len() != 5 {
                return Err(parse_error(format!("malformed commit {:?}", lossy(record))));
            }
            Ok(LostCommit {
                oid: lossy(fields[0]),
                parents: lossy(fields[1])
                    .split_whitespace()
                    .map(str::to_string)
                    .collect(),
                time: parse_i64(&lossy(fields[2]))?,
                author: lossy(fields[3]),
                subject: lossy(fields[4]),
                origin: LostOrigin::Dangling,
            })
        })
        .collect()
}

/// The index and untracked-files commits of dropped stashes: they are second
/// or third parents of another lost commit and git names them
/// `index on ...` / `untracked files on ...`. Only the stash commit itself is
/// reported.
fn dropped_stash_parts(commits: &[LostCommit]) -> HashSet<String> {
    let by_oid: HashMap<&str, &LostCommit> = commits
        .iter()
        .map(|commit| (commit.oid.as_str(), commit))
        .collect();
    commits
        .iter()
        .flat_map(|commit| commit.parents.iter().skip(1))
        .filter_map(|parent| by_oid.get(parent.as_str()))
        .filter(|parent| {
            parent.subject.starts_with("index on ")
                || parent.subject.starts_with("untracked files on ")
        })
        .map(|parent| parent.oid.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "1111111111111111111111111111111111111111";
    const B: &str = "2222222222222222222222222222222222222222";
    const C: &str = "3333333333333333333333333333333333333333";

    #[test]
    fn fsck_output_keeps_commits_only() {
        let output = format!(
            "unreachable tree {B}\nunreachable commit {A}\nunreachable blob {C}\n\
             dangling commit {C}\nnotice: No default references\n"
        );
        let commits = parse_fsck(output.as_bytes()).unwrap();
        assert_eq!(commits, HashSet::from([A.to_string(), C.to_string()]));
        assert!(parse_fsck(b"unreachable commit --all\n").is_err());
    }

    #[test]
    fn log_records_are_parsed() {
        let output = format!(
            "{A}\x1f{B} {C}\x1f1700000000\x1fAda\x1fOn main: wip\x1e\n{B}\x1f\x1f1600000000\x1fBob\x1fa\x1fb\x1e\n"
        );
        let commits = parse_log(output.as_bytes()).unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].parents, [B, C]);
        assert_eq!(commits[0].time, 1_700_000_000);
        assert!(commits[1].parents.is_empty());
        assert_eq!(commits[1].subject, "a\x1fb");
        assert_eq!(commits[1].origin, LostOrigin::Dangling);
        assert!(parse_log(b"x\x1fy\x1e").is_err());
    }

    #[test]
    fn index_and_untracked_commits_of_a_dropped_stash_are_hidden() {
        let commit = |oid: &str, parents: &[&str], subject: &str| LostCommit {
            oid: oid.into(),
            parents: parents.iter().map(|p| p.to_string()).collect(),
            time: 0,
            author: String::new(),
            subject: subject.into(),
            origin: LostOrigin::Dangling,
        };
        let base = "4444444444444444444444444444444444444444";
        let commits = [
            commit(A, &[base, B, C], "On main: dropped"),
            commit(B, &[base], "index on main: 4444444 Base"),
            commit(C, &[], "untracked files on main: 4444444 Base"),
        ];
        assert_eq!(
            dropped_stash_parts(&commits),
            HashSet::from([B.to_string(), C.to_string()])
        );
        // A lone commit with such a subject is still reported.
        assert!(dropped_stash_parts(&commits[1..]).is_empty());
    }
}
