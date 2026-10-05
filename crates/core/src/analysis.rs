//! Branch and merge analysis, stashes and worktrees.
//!
//! All reads go through [`Git::read`], so they never fetch and never write.
//!
//! The default branch is the target of `refs/remotes/origin/HEAD` (set by
//! `git clone` or `git remote set-head`); without it, `main`, then `master`,
//! when a local or `origin` branch of that name exists. A local branch is
//! *unmerged* when it has commits that are in neither the local default
//! branch nor its `origin` counterpart, so a branch merged on the server (and
//! fetched) or merged locally (not yet pushed) both count as merged.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::discovery::normalize;
use crate::git::{Git, GitError};
use crate::status::{lossy, parse_error};

/// Field and record separators used in `--format` strings. Subjects come
/// last, so a stray separator inside one cannot shift other fields.
const FS: u8 = 0x1f;
const RS: u8 = 0x1e;

const REF_FORMAT: &str = "--format=%(refname)%1f%(symref)%1f%(objectname)%1f%(HEAD)%1f\
%(upstream:short)%1f%(upstream:track,nobracket)%1f%(committerdate:unix)%1f%(contents:subject)%1e";

const ORIGIN_PREFIX: &str = "refs/remotes/origin/";
const HEADS_PREFIX: &str = "refs/heads/";
/// `for-each-ref` patterns match whole leading path components.
const HEADS_PATTERN: &str = "refs/heads";
const ORIGIN_PATTERN: &str = "refs/remotes/origin";

/// Branch names tried, in order, when `origin/HEAD` is not set.
pub const CONVENTIONAL_DEFAULT_BRANCHES: &[&str] = &["main", "master"];

/// How the default branch was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DefaultBranchSource {
    /// `refs/remotes/origin/HEAD` points at it.
    OriginHead,
    /// No `origin/HEAD`; a branch named `main` or `master` exists.
    Conventional,
}

/// The branch other branches are compared with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultBranch {
    /// Short name, for example `main`.
    pub name: String,
    pub source: DefaultBranchSource,
    /// The local branch of that name exists.
    pub local: bool,
    /// The remote-tracking branch (for example `origin/main`), when it exists.
    pub remote: Option<String>,
}

/// How a branch compares with the default branch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeState {
    /// Commits on the branch that are not in the default branch. Zero means
    /// the branch is merged.
    pub ahead: u32,
    /// Commits in the default branch that are not on the branch.
    pub behind: u32,
}

/// A local branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    /// Short name, for example `feature/a`.
    pub name: String,
    pub oid: String,
    /// HEAD of this working tree is on this branch.
    pub is_head: bool,
    pub is_default: bool,
    /// For example `origin/feature/a`.
    pub upstream: Option<String>,
    /// The upstream is configured but no longer exists.
    pub upstream_gone: bool,
    /// Committer time of the tip, in seconds since the Unix epoch.
    pub commit_time: i64,
    /// Subject of the tip commit.
    pub subject: String,
    /// Comparison with the default branch; `None` for the default branch
    /// itself or when the repository has no default branch.
    pub merge: Option<MergeState>,
}

impl Branch {
    /// The branch has commits that are not in the default branch.
    pub fn is_unmerged(&self) -> bool {
        self.merge.is_some_and(|merge| merge.ahead > 0)
    }
}

/// Local branches and the default branch of a repository.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchReport {
    pub default_branch: Option<DefaultBranch>,
    /// Local branches sorted by name.
    pub branches: Vec<Branch>,
}

impl BranchReport {
    /// Branches with commits that are not in the default branch.
    pub fn unmerged(&self) -> impl Iterator<Item = &Branch> {
        self.branches.iter().filter(|branch| branch.is_unmerged())
    }

    /// The branch HEAD is on.
    pub fn head(&self) -> Option<&Branch> {
        self.branches.iter().find(|branch| branch.is_head)
    }
}

/// One `git for-each-ref` record.
struct RefRecord {
    refname: String,
    symref: String,
    oid: String,
    is_head: bool,
    upstream: String,
    track: String,
    commit_time: i64,
    subject: String,
}

/// Reads the local branches, detects the default branch and compares every
/// other branch with it.
pub fn read_branches(git: &Git, repo: &Path) -> Result<BranchReport, GitError> {
    read_branches_with(git, repo, false)
}

/// [`read_branches`] with the per-branch counting used for git older than
/// 2.41; public so tests can cover it on a current git.
#[doc(hidden)]
pub fn read_branches_counting_per_branch(git: &Git, repo: &Path) -> Result<BranchReport, GitError> {
    read_branches_with(git, repo, true)
}

fn read_branches_with(git: &Git, repo: &Path, per_branch: bool) -> Result<BranchReport, GitError> {
    let output = git.read(
        repo,
        &["for-each-ref", REF_FORMAT, HEADS_PATTERN, ORIGIN_PATTERN],
    )?;
    let records = parse_refs(&output)?;

    let mut remote_oids: HashMap<String, String> = HashMap::new();
    let mut origin_head: Option<String> = None;
    let mut branches = Vec::new();
    for record in records {
        if let Some(name) = record.refname.strip_prefix(HEADS_PREFIX) {
            branches.push(Branch {
                name: name.to_string(),
                oid: record.oid,
                is_head: record.is_head,
                is_default: false,
                upstream: (!record.upstream.is_empty()).then_some(record.upstream),
                upstream_gone: record.track == "gone",
                commit_time: record.commit_time,
                subject: record.subject,
                merge: None,
            });
        } else if let Some(name) = record.refname.strip_prefix(ORIGIN_PREFIX) {
            if name == "HEAD" {
                origin_head = record
                    .symref
                    .strip_prefix(ORIGIN_PREFIX)
                    .map(str::to_string);
            } else {
                remote_oids.insert(name.to_string(), record.oid);
            }
        }
    }
    branches.sort_by(|a, b| a.name.cmp(&b.name));

    let local_oid = |name: &str| {
        branches
            .iter()
            .find(|branch| branch.name == name)
            .map(|branch| branch.oid.clone())
    };
    let exists = |name: &str| local_oid(name).is_some() || remote_oids.contains_key(name);
    let default = match origin_head.filter(|name| exists(name)) {
        Some(name) => Some((name, DefaultBranchSource::OriginHead)),
        None => CONVENTIONAL_DEFAULT_BRANCHES
            .iter()
            .find(|name| exists(name))
            .map(|name| (name.to_string(), DefaultBranchSource::Conventional)),
    };
    let Some((name, source)) = default else {
        return Ok(BranchReport {
            default_branch: None,
            branches,
        });
    };

    let mut bases: Vec<String> = Vec::new();
    bases.extend(local_oid(&name));
    if let Some(oid) = remote_oids.get(&name) {
        if !bases.contains(oid) {
            bases.push(oid.clone());
        }
    }
    let default_branch = DefaultBranch {
        local: local_oid(&name).is_some(),
        remote: remote_oids
            .contains_key(&name)
            .then(|| format!("origin/{name}")),
        name,
        source,
    };
    for branch in &mut branches {
        branch.is_default = branch.name == default_branch.name;
    }
    if branches.iter().any(|branch| !branch.is_default) {
        for base in &bases {
            check_oid(base)?;
        }
        let states = if per_branch {
            merge_states_per_branch(git, repo, &branches, &bases)?
        } else {
            match merge_states(git, repo, &bases) {
                // `%(ahead-behind)` needs git 2.41.
                Err(GitError::Failed { stderr, .. }) if stderr.contains("ahead-behind") => {
                    merge_states_per_branch(git, repo, &branches, &bases)?
                }
                other => other?,
            }
        };
        for branch in branches.iter_mut().filter(|branch| !branch.is_default) {
            branch.merge = states.get(&branch.name).copied();
        }
    }
    Ok(BranchReport {
        default_branch: Some(default_branch),
        branches,
    })
}

/// Compares every local branch with each base commit (validated object ids)
/// in one `for-each-ref` run and keeps, per branch, the comparison with the
/// fewest unmerged commits.
fn merge_states(
    git: &Git,
    repo: &Path,
    bases: &[String],
) -> Result<HashMap<String, MergeState>, GitError> {
    // Bases are passed as object ids: a ref name may contain `)`, which
    // would end the format atom.
    let mut format = String::from("--format=%(refname)");
    for base in bases {
        format.push_str(&format!("%1f%(ahead-behind:{base})"));
    }
    format.push_str("%1e");
    let output = git.read(repo, &["for-each-ref", &format, HEADS_PATTERN])?;
    let mut states = HashMap::new();
    for record in records(&output) {
        let mut fields = record.split(|byte| *byte == FS);
        let refname = lossy(fields.next().unwrap_or_default());
        let Some(name) = refname.strip_prefix(HEADS_PREFIX) else {
            continue;
        };
        let compared = fields
            .map(|field| parse_ahead_behind(&lossy(field)))
            .collect::<Result<Vec<_>, _>>()?;
        if let Some(state) = fewest_unmerged(compared) {
            states.insert(name.to_string(), state);
        }
    }
    Ok(states)
}

/// [`merge_states`] for git older than 2.41: one `rev-list` per branch and
/// base.
fn merge_states_per_branch(
    git: &Git,
    repo: &Path,
    branches: &[Branch],
    bases: &[String],
) -> Result<HashMap<String, MergeState>, GitError> {
    let mut states = HashMap::new();
    for branch in branches.iter().filter(|branch| !branch.is_default) {
        check_oid(&branch.oid)?;
        let mut compared = Vec::new();
        for base in bases {
            let range = format!("{}...{base}", branch.oid);
            let output = git.read(repo, &["rev-list", "--left-right", "--count", &range])?;
            compared.push(parse_ahead_behind(&lossy(&output))?);
        }
        if let Some(state) = fewest_unmerged(compared) {
            states.insert(branch.name.clone(), state);
        }
    }
    Ok(states)
}

/// The comparison with the fewest unmerged commits; the local default
/// branch (first) wins ties.
fn fewest_unmerged(compared: Vec<MergeState>) -> Option<MergeState> {
    compared.into_iter().min_by_key(|state| state.ahead)
}

/// Parses `"<ahead> <behind>"` (also tab-separated, as `rev-list` prints).
fn parse_ahead_behind(value: &str) -> Result<MergeState, GitError> {
    let mut parts = value.split_whitespace();
    match (parts.next(), parts.next(), parts.next()) {
        (Some(ahead), Some(behind), None) => Ok(MergeState {
            ahead: parse_u32(ahead)?,
            behind: parse_u32(behind)?,
        }),
        _ => Err(parse_error(format!("malformed ahead-behind {value:?}"))),
    }
}

fn parse_refs(output: &[u8]) -> Result<Vec<RefRecord>, GitError> {
    records(output)
        .map(|record| {
            let fields: Vec<&[u8]> = record.splitn(8, |byte| *byte == FS).collect();
            if fields.len() != 8 {
                return Err(parse_error(format!(
                    "malformed ref record {:?}",
                    lossy(record)
                )));
            }
            let time = lossy(fields[6]);
            Ok(RefRecord {
                refname: lossy(fields[0]),
                symref: lossy(fields[1]),
                oid: lossy(fields[2]),
                is_head: fields[3] == b"*",
                upstream: lossy(fields[4]),
                track: lossy(fields[5]),
                commit_time: if time.is_empty() {
                    0
                } else {
                    parse_i64(&time)?
                },
                subject: lossy(fields[7]),
            })
        })
        .collect()
}

/// Splits `--format=...%1e` output (one record per line) into records.
fn records(output: &[u8]) -> impl Iterator<Item = &[u8]> {
    output.split(|byte| *byte == RS).filter_map(|record| {
        let record = record.strip_prefix(b"\n").unwrap_or(record);
        let record = record.strip_prefix(b"\r\n").unwrap_or(record);
        (!record.is_empty()).then_some(record)
    })
}

/// A stash entry, newest first (`stash@{0}` has index 0).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stash {
    pub index: u32,
    pub oid: String,
    /// Creation time, in seconds since the Unix epoch.
    pub time: i64,
    /// For example `On main: first stash` or `WIP on main: 1a2b3c4 Subject`.
    pub message: String,
    /// The commits a stash is built on: the base commit, the index commit
    /// and, when untracked files were stashed, the untracked-files commit.
    pub parents: Vec<String>,
}

/// Lists the stashes of a repository.
pub fn list_stashes(git: &Git, repo: &Path) -> Result<Vec<Stash>, GitError> {
    let output = git.read(
        repo,
        &[
            "stash",
            "list",
            "--no-show-signature",
            "--format=%H%x1f%P%x1f%ct%x1f%gs%x1e",
        ],
    )?;
    records(&output)
        .enumerate()
        .map(|(index, record)| {
            let fields: Vec<&[u8]> = record.splitn(4, |byte| *byte == FS).collect();
            if fields.len() != 4 {
                return Err(parse_error(format!("malformed stash {:?}", lossy(record))));
            }
            Ok(Stash {
                index: u32::try_from(index).unwrap_or(u32::MAX),
                oid: lossy(fields[0]),
                parents: lossy(fields[1])
                    .split_whitespace()
                    .map(str::to_string)
                    .collect(),
                time: parse_i64(&lossy(fields[2]))?,
                message: lossy(fields[3]),
            })
        })
        .collect()
}

/// A working tree of a repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: PathBuf,
    /// HEAD commit; `None` before the first commit.
    pub oid: Option<String>,
    /// Short branch name; `None` when detached or bare.
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    pub locked: bool,
    /// Its folder no longer exists (`git worktree prune` would remove it).
    pub prunable: bool,
    /// The main working tree (listed first by git).
    pub is_main: bool,
}

/// Lists the main working tree and the linked worktrees of a repository.
pub fn list_worktrees(git: &Git, repo: &Path) -> Result<Vec<Worktree>, GitError> {
    let output = git.read(repo, &["worktree", "list", "--porcelain", "-z"])?;
    parse_worktrees(&output)
}

fn parse_worktrees(output: &[u8]) -> Result<Vec<Worktree>, GitError> {
    let mut worktrees: Vec<Worktree> = Vec::new();
    let mut current: Option<Worktree> = None;
    for line in output.split(|byte| *byte == 0) {
        if line.is_empty() {
            worktrees.extend(current.take());
            continue;
        }
        let line = lossy(line);
        let (key, value) = line.split_once(' ').unwrap_or((&line, ""));
        if key == "worktree" {
            worktrees.extend(current.take());
            current = Some(Worktree {
                path: normalize(Path::new(value)),
                oid: None,
                branch: None,
                detached: false,
                bare: false,
                locked: false,
                prunable: false,
                is_main: worktrees.is_empty(),
            });
            continue;
        }
        let worktree = current
            .as_mut()
            .ok_or_else(|| parse_error(format!("worktree attribute before path: {line:?}")))?;
        match key {
            "HEAD" => worktree.oid = value.bytes().any(|byte| byte != b'0').then(|| value.into()),
            "branch" => {
                worktree.branch = Some(value.strip_prefix(HEADS_PREFIX).unwrap_or(value).into());
            }
            "detached" => worktree.detached = true,
            "bare" => worktree.bare = true,
            "locked" => worktree.locked = true,
            "prunable" => worktree.prunable = true,
            _ => {}
        }
    }
    worktrees.extend(current);
    Ok(worktrees)
}

/// Accepts a full hexadecimal object id (SHA-1 or SHA-256).
pub(crate) fn check_oid(oid: &str) -> Result<(), GitError> {
    if matches!(oid.len(), 40 | 64) && oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(parse_error(format!("not an object id: {oid:?}")))
    }
}

pub(crate) fn parse_i64(value: &str) -> Result<i64, GitError> {
    value
        .trim()
        .parse()
        .map_err(|_| parse_error(format!("expected a number, got {value:?}")))
}

fn parse_u32(value: &str) -> Result<u32, GitError> {
    value
        .trim()
        .parse()
        .map_err(|_| parse_error(format!("expected a number, got {value:?}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "1111111111111111111111111111111111111111";

    #[test]
    fn ref_records_keep_subjects_with_separators_and_newlines() {
        let output = format!(
            "refs/heads/main\x1f\x1f{A}\x1f*\x1forigin/main\x1f\x1f1700000000\x1fFix: a\x1fb\x1e\n\
             refs/remotes/origin/HEAD\x1frefs/remotes/origin/main\x1f{A}\x1f \x1f\x1f\x1f1700000000\x1fline one\nline two\x1e\n"
        );
        let records = parse_refs(output.as_bytes()).unwrap();
        assert_eq!(records.len(), 2);
        assert!(records[0].is_head);
        assert_eq!(records[0].subject, "Fix: a\x1fb");
        assert_eq!(records[0].upstream, "origin/main");
        assert_eq!(records[1].symref, "refs/remotes/origin/main");
        assert_eq!(records[1].subject, "line one\nline two");
        assert!(parse_refs(b"refs/heads/x\x1fonly\x1e\n").is_err());
        assert!(parse_refs(b"").unwrap().is_empty());
    }

    #[test]
    fn ahead_behind_accepts_spaces_and_tabs() {
        assert_eq!(
            parse_ahead_behind("2 1").unwrap(),
            MergeState {
                ahead: 2,
                behind: 1
            }
        );
        assert_eq!(parse_ahead_behind("3\t0\n").unwrap().ahead, 3);
        for bad in ["", "1", "1 2 3", "x 1", "-1 2"] {
            assert!(parse_ahead_behind(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn worktree_list_is_parsed() {
        let zero = "0".repeat(40);
        let output = format!(
            "worktree C:/work/repo\0HEAD {A}\0branch refs/heads/main\0\0\
             worktree C:/work/linked\0HEAD {A}\0detached\0locked reason here\0\0\
             worktree C:/work/gone\0HEAD {zero}\0branch refs/heads/feature/x\0prunable gitdir file points to non-existent location\0\0"
        );
        let worktrees = parse_worktrees(output.as_bytes()).unwrap();
        assert_eq!(worktrees.len(), 3);
        assert!(worktrees[0].is_main);
        assert_eq!(worktrees[0].branch.as_deref(), Some("main"));
        assert_eq!(worktrees[0].path, normalize(Path::new("C:/work/repo")));
        assert!(!worktrees[1].is_main && worktrees[1].detached && worktrees[1].locked);
        assert_eq!(worktrees[1].branch, None);
        assert_eq!(worktrees[2].oid, None);
        assert!(worktrees[2].prunable);
        assert_eq!(worktrees[2].branch.as_deref(), Some("feature/x"));
        assert!(parse_worktrees(b"HEAD 1\0").is_err());
    }

    #[test]
    fn object_ids_are_validated() {
        assert!(check_oid(A).is_ok());
        assert!(check_oid(&"a".repeat(64)).is_ok());
        for bad in ["", "abc", "--all", &format!("{A})"), &"g".repeat(40)] {
            assert!(check_oid(bad).is_err(), "{bad:?}");
        }
    }
}
