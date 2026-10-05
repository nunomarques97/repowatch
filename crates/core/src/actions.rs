//! The git actions of the detail view: stage, unstage, commit, fetch, pull,
//! push, branches, stashes and lost-commit recovery.
//!
//! Safety rules, enforced here and by the write allow-list in [`crate::git`]:
//!
//! - nothing is ever forced: no force push, no `branch -D`, no
//!   `reset --hard`, no rebase, no amend, no discarding of working-tree
//!   changes;
//! - pull only fast-forwards (`fetch` then `merge --ff-only`); a diverged
//!   branch fails with [`GitError::NotFastForward`] and nothing changes;
//! - push sends only the current branch to its upstream (or sets one), with
//!   an explicit refspec that cannot force or delete; a rejected push fails
//!   with [`GitError::PushRejected`];
//! - only branches merged into the default branch are deleted, otherwise
//!   [`GitError::BranchNotMerged`];
//! - every caller value is validated first (see [`crate::validate`]) and
//!   passed after `--`, so it can never act as an option;
//! - hunks and stashes are named by content (hunk id, stash object id) and
//!   checked against the current repository, so a stale view fails with
//!   [`GitError::Stale`] instead of acting on the wrong thing.
//!
//! Confirmation of dangerous actions (dropping a stash, deleting a branch)
//! belongs to the user interface; these functions run what they are asked.

use std::path::Path;

use crate::analysis::{list_stashes, read_branches};
use crate::diff::{DiffSide, read_patch};
use crate::git::{Git, GitError};
use crate::status::{lossy, read_status};
use crate::validate;

/// Stages a whole file (`git add`), including a deletion or an untracked
/// file or folder.
pub fn stage_file(git: &Git, repo: &Path, path: &str) -> Result<(), GitError> {
    let pathspec = validate::repo_path(path)?;
    git.write(repo, &["add", "--", &pathspec], None)?;
    Ok(())
}

/// Unstages a whole file (`git restore --staged`); the working tree is
/// never touched.
pub fn unstage_file(git: &Git, repo: &Path, path: &str) -> Result<(), GitError> {
    let pathspec = validate::repo_path(path)?;
    if read_status(git, repo)?.report.oid.is_some() {
        git.write(repo, &["restore", "--staged", "--", &pathspec], None)?;
    } else {
        // Before the first commit there is no HEAD: restore from the empty
        // tree, which removes the file from the index.
        let source = empty_tree_source(git, repo)?;
        git.write(
            repo,
            &["restore", "--staged", source, "--", &pathspec],
            None,
        )?;
    }
    Ok(())
}

fn empty_tree_source(git: &Git, repo: &Path) -> Result<&'static str, GitError> {
    let format = lossy(&git.read(repo, &["rev-parse", "--show-object-format"])?);
    match format.trim() {
        "sha1" => Ok("--source=4b825dc642cb6eb9a060e54bf8d69288fbee4904"),
        "sha256" => Ok("--source=6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321"),
        other => Err(crate::status::parse_error(format!(
            "unknown object format {other:?}"
        ))),
    }
}

/// Stages one hunk of a file's unstaged changes, named by the id from
/// [`crate::read_file_diff`] with [`DiffSide::Unstaged`].
pub fn stage_hunk(git: &Git, repo: &Path, path: &str, hunk_id: &str) -> Result<(), GitError> {
    apply_hunk(git, repo, path, hunk_id, DiffSide::Unstaged)
}

/// Unstages one hunk of a file's staged changes, named by the id from
/// [`crate::read_file_diff`] with [`DiffSide::Staged`]. The working tree
/// keeps the change.
pub fn unstage_hunk(git: &Git, repo: &Path, path: &str, hunk_id: &str) -> Result<(), GitError> {
    apply_hunk(git, repo, path, hunk_id, DiffSide::Staged)
}

fn apply_hunk(
    git: &Git,
    repo: &Path,
    path: &str,
    hunk_id: &str,
    side: DiffSide,
) -> Result<(), GitError> {
    let pathspec = validate::repo_path(path)?;
    let patch = read_patch(git, repo, &pathspec, side)?;
    let stale = || GitError::Stale {
        what: format!("the changes of {path}"),
    };
    let hunk = patch
        .hunks
        .iter()
        .find(|raw| raw.hunk.id == hunk_id)
        .ok_or_else(stale)?;
    let mut args = vec!["apply", "--cached"];
    if side == DiffSide::Staged {
        args.push("--reverse");
    }
    args.extend(["--whitespace=nowarn", "-"]);
    match git.write(repo, &args, Some(&patch.single(hunk))) {
        Err(GitError::Failed { stderr, .. }) if stderr.contains("patch does not apply") => {
            Err(stale())
        }
        other => other.map(drop),
    }
}

/// Commits the staged changes with `message` (passed on standard input, so
/// it can never be read as an option). Hooks run as on the command line.
pub fn commit(git: &Git, repo: &Path, message: &str) -> Result<(), GitError> {
    validate::commit_message(message)?;
    match git.write(
        repo,
        &["commit", "--quiet", "--file=-"],
        Some(message.as_bytes()),
    ) {
        Err(GitError::Failed { stderr, .. })
            if stderr.contains("nothing to commit")
                || stderr.contains("no changes added to commit")
                || stderr.contains("nothing added to commit") =>
        {
            Err(GitError::NothingToCommit)
        }
        other => other.map(drop),
    }
}

/// Fetches one remote, or every remote when `remote` is `None`. Only
/// remote-tracking refs change; local branches and the working tree do not.
pub fn fetch(git: &Git, repo: &Path, remote: Option<&str>) -> Result<(), GitError> {
    let remotes = read_status(git, repo)?.remotes;
    if remotes.is_empty() {
        return Err(GitError::NoRemote);
    }
    match remote {
        Some(remote) => {
            known_remote(remote, &remotes)?;
            git.write(repo, &["fetch", "--quiet", "--", remote], None)?;
        }
        None => {
            git.write(repo, &["fetch", "--quiet", "--all"], None)?;
        }
    }
    Ok(())
}

fn known_remote(remote: &str, remotes: &[String]) -> Result<(), GitError> {
    validate::remote_name(remote)?;
    if remotes.iter().any(|known| known == remote) {
        Ok(())
    } else {
        Err(GitError::InvalidInput {
            field: "remote name".into(),
            reason: format!("{remote} is not a remote of this repository"),
        })
    }
}

/// Pulls the current branch from its upstream by fast-forward only: fetches
/// the upstream's remote, then `merge --ff-only`. A diverged branch fails
/// with [`GitError::NotFastForward`] and nothing changes.
pub fn pull(git: &Git, repo: &Path) -> Result<(), GitError> {
    let branch = current_branch(git, repo)?;
    let upstream = read_upstream(git, repo, &branch)?.ok_or_else(|| GitError::NoUpstream {
        branch: branch.clone(),
    })?;
    if let Some(remote) = &upstream.remote {
        git.write(repo, &["fetch", "--quiet", "--", remote], None)?;
    }
    match git.write(
        repo,
        &[
            "merge",
            "--ff-only",
            "--no-autostash",
            "--quiet",
            "--",
            &upstream.tracking_ref,
        ],
        None,
    ) {
        Err(GitError::Failed { stderr, .. })
            if stderr
                .to_lowercase()
                .contains("not possible to fast-forward") =>
        {
            Err(GitError::NotFastForward)
        }
        other => other.map(drop),
    }
}

/// Pushes the current branch. With an upstream on a remote it goes there;
/// without one it goes to `origin` (or the only remote) under the same name,
/// and becomes the upstream. Never forces: a rejected push fails with
/// [`GitError::PushRejected`].
pub fn push(git: &Git, repo: &Path) -> Result<(), GitError> {
    let status = read_status(git, repo)?;
    let branch = branch_of(&status)?;
    let local = format!("refs/heads/{branch}");
    let upstream = read_upstream(git, repo, &branch)?;
    let result = match upstream {
        Some(Upstream {
            remote: Some(remote),
            remote_ref: Some(remote_ref),
            ..
        }) => {
            let refspec = format!("{local}:{remote_ref}");
            git.write(
                repo,
                &["push", "--porcelain", "--", &remote, &refspec],
                None,
            )
        }
        _ => {
            let remote = default_remote(&status.remotes)?;
            let refspec = format!("{local}:{local}");
            git.write(
                repo,
                &[
                    "push",
                    "--porcelain",
                    "--set-upstream",
                    "--",
                    remote,
                    &refspec,
                ],
                None,
            )
        }
    };
    match result {
        Err(GitError::Failed { stderr, .. })
            if stderr.contains("[rejected]")
                || stderr.contains("[remote rejected]")
                || stderr.contains("non-fast-forward") =>
        {
            Err(GitError::PushRejected { stderr })
        }
        other => other.map(drop),
    }
}

fn default_remote(remotes: &[String]) -> Result<&str, GitError> {
    let remote = match remotes {
        [] => return Err(GitError::NoRemote),
        [only] => only,
        _ => remotes
            .iter()
            .find(|remote| *remote == "origin")
            .ok_or_else(|| GitError::InvalidInput {
                field: "remote name".into(),
                reason: "the repository has several remotes and none is named origin; \
                         set an upstream first"
                    .into(),
            })?,
    };
    validate::remote_name(remote)?;
    Ok(remote)
}

/// Creates a branch at `start` (a full object id) or at HEAD, without
/// switching to it. An existing branch is never overwritten.
pub fn create_branch(
    git: &Git,
    repo: &Path,
    name: &str,
    start: Option<&str>,
) -> Result<(), GitError> {
    validate::branch_name(name)?;
    let mut args = vec!["branch", "--no-track", "--", name];
    if let Some(start) = start {
        validate::object_id(start)?;
        args.push(start);
    }
    match git.write(repo, &args, None) {
        Err(GitError::Failed { stderr, .. }) if stderr.contains("already exists") => {
            Err(GitError::BranchExists {
                branch: name.to_string(),
            })
        }
        other => other.map(drop),
    }
}

/// Switches to a local branch. git refuses when local changes would be
/// overwritten; they are never discarded.
pub fn switch_branch(git: &Git, repo: &Path, name: &str) -> Result<(), GitError> {
    validate::branch_name(name)?;
    git.write(repo, &["switch", "--no-guess", "--", name], None)?;
    Ok(())
}

/// Deletes a local branch that is merged into the default branch (or, when
/// there is no default branch, that git itself considers merged). The
/// current and the default branch are never deleted.
pub fn delete_merged_branch(git: &Git, repo: &Path, name: &str) -> Result<(), GitError> {
    validate::branch_name(name)?;
    let report = read_branches(git, repo)?;
    let invalid = |reason: &str| GitError::InvalidInput {
        field: "branch name".into(),
        reason: reason.into(),
    };
    let branch = report
        .branches
        .iter()
        .find(|branch| branch.name == name)
        .ok_or_else(|| invalid("no such local branch"))?;
    if branch.is_head {
        return Err(invalid("is the current branch"));
    }
    if branch.is_default {
        return Err(invalid("is the default branch"));
    }
    let not_merged = || GitError::BranchNotMerged {
        branch: name.to_string(),
    };
    if branch.is_unmerged() {
        return Err(not_merged());
    }
    // `-d` makes git check again that the branch is merged (into its
    // upstream or HEAD), so it is never deleted with unmerged work.
    match git.write(repo, &["branch", "-d", "--", name], None) {
        Err(GitError::Failed { stderr, .. }) if stderr.contains("not fully merged") => {
            Err(not_merged())
        }
        other => other.map(drop),
    }
}

/// Applies a stash, keeping it. `index` and `oid` come from
/// [`crate::list_stashes`]; if `stash@{index}` is no longer that commit the
/// call fails with [`GitError::Stale`].
pub fn apply_stash(git: &Git, repo: &Path, index: u32, oid: &str) -> Result<(), GitError> {
    let stash = checked_stash(git, repo, index, oid)?;
    git.write(repo, &["stash", "apply", "--quiet", "--", &stash], None)?;
    Ok(())
}

/// Drops a stash (after the user confirmed it). Same identity check as
/// [`apply_stash`]. The commit stays recoverable as a lost commit until git
/// prunes it.
pub fn drop_stash(git: &Git, repo: &Path, index: u32, oid: &str) -> Result<(), GitError> {
    let stash = checked_stash(git, repo, index, oid)?;
    git.write(repo, &["stash", "drop", "--quiet", "--", &stash], None)?;
    Ok(())
}

fn checked_stash(git: &Git, repo: &Path, index: u32, oid: &str) -> Result<String, GitError> {
    validate::object_id(oid)?;
    let stashes = list_stashes(git, repo)?;
    let current = stashes.iter().find(|stash| stash.index == index);
    if current.is_none_or(|stash| !stash.oid.eq_ignore_ascii_case(oid)) {
        return Err(GitError::Stale {
            what: "the stash list".into(),
        });
    }
    Ok(format!("stash@{{{index}}}"))
}

/// Recovers a lost commit (see [`crate::find_lost_commits`]) by creating a
/// new branch at it. Nothing else changes.
pub fn recover_commit(git: &Git, repo: &Path, oid: &str, branch: &str) -> Result<(), GitError> {
    validate::object_id(oid)?;
    create_branch(git, repo, branch, Some(oid))
}

/// The current branch, validated so it can be used in a refspec.
fn current_branch(git: &Git, repo: &Path) -> Result<String, GitError> {
    branch_of(&read_status(git, repo)?)
}

fn branch_of(status: &crate::RepoStatus) -> Result<String, GitError> {
    let branch = status
        .report
        .head
        .branch()
        .ok_or(GitError::DetachedHead)?
        .to_string();
    validate::branch_name(&branch)?;
    Ok(branch)
}

/// The configured upstream of a local branch.
#[derive(Debug, PartialEq, Eq)]
struct Upstream {
    /// Full ref of the upstream as seen locally, for example
    /// `refs/remotes/origin/main` (or `refs/heads/main` for a local
    /// upstream).
    tracking_ref: String,
    /// The remote, `None` for a local upstream (remote `.`).
    remote: Option<String>,
    /// The branch on the remote, for example `refs/heads/main`.
    remote_ref: Option<String>,
}

fn read_upstream(git: &Git, repo: &Path, branch: &str) -> Result<Option<Upstream>, GitError> {
    let refname = format!("refs/heads/{branch}");
    let output = git.read(
        repo,
        &[
            "for-each-ref",
            "--format=%(refname)%1f%(upstream)%1f%(upstream:remotename)%1f%(upstream:remoteref)%1e",
            &refname,
        ],
    )?;
    parse_upstream(&output, &refname)
}

/// Parses the `for-each-ref` record of `refname` (a pattern also matches
/// branches below it, so the exact name is picked).
fn parse_upstream(output: &[u8], refname: &str) -> Result<Option<Upstream>, GitError> {
    for record in output.split(|byte| *byte == 0x1e) {
        let record = lossy(record);
        let fields: Vec<&str> = record
            .trim_start_matches(['\r', '\n'])
            .split('\x1f')
            .collect();
        let [name, tracking, remote, remote_ref] = fields[..] else {
            continue;
        };
        if name != refname {
            continue;
        }
        if tracking.is_empty() {
            return Ok(None);
        }
        check_ref("upstream", tracking)?;
        let remote = match remote {
            "" | "." => None,
            remote => {
                validate::remote_name(remote)?;
                Some(remote.to_string())
            }
        };
        let remote_ref = match remote_ref {
            "" => None,
            remote_ref => {
                check_ref("upstream", remote_ref)?;
                Some(remote_ref.to_string())
            }
        };
        return Ok(Some(Upstream {
            tracking_ref: tracking.to_string(),
            remote,
            remote_ref,
        }));
    }
    Ok(None)
}

/// A full ref name read from the repository's config, before it goes into a
/// command: `refs/...`, no option, force or revision syntax.
fn check_ref(field: &str, name: &str) -> Result<(), GitError> {
    let ok = name
        .strip_prefix("refs/")
        .is_some_and(|rest| validate::branch_name(rest).is_ok());
    if ok {
        Ok(())
    } else {
        Err(GitError::InvalidInput {
            field: field.into(),
            reason: format!("{name:?} is not a plain ref name"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_record_of_the_exact_branch_is_used() {
        let output = b"refs/heads/a\x1frefs/remotes/origin/a\x1forigin\x1frefs/heads/a\x1e\n\
refs/heads/a/b\x1f\x1f\x1f\x1e\n";
        assert_eq!(
            parse_upstream(output, "refs/heads/a").unwrap(),
            Some(Upstream {
                tracking_ref: "refs/remotes/origin/a".into(),
                remote: Some("origin".into()),
                remote_ref: Some("refs/heads/a".into()),
            })
        );
        assert_eq!(parse_upstream(output, "refs/heads/a/b").unwrap(), None);
        assert_eq!(parse_upstream(output, "refs/heads/zzz").unwrap(), None);
        let local = b"refs/heads/x\x1frefs/heads/main\x1f.\x1frefs/heads/main\x1e\n";
        assert_eq!(
            parse_upstream(local, "refs/heads/x")
                .unwrap()
                .unwrap()
                .remote,
            None
        );
    }

    #[test]
    fn hostile_upstream_config_is_refused() {
        for record in [
            "refs/heads/a\x1f--upload-pack=x\x1forigin\x1frefs/heads/a\x1e",
            "refs/heads/a\x1frefs/remotes/origin/a\x1f-oProxy\x1frefs/heads/a\x1e",
            "refs/heads/a\x1frefs/remotes/origin/a\x1forigin\x1f+refs/heads/a\x1e",
            "refs/heads/a\x1frefs/remotes/origin/a\x1forigin\x1f:refs/heads/a\x1e",
            "refs/heads/a\x1frefs/remotes/origin/a\x1forigin\x1frefs/heads/a b\x1e",
        ] {
            assert!(
                matches!(
                    parse_upstream(record.as_bytes(), "refs/heads/a"),
                    Err(GitError::InvalidInput { .. })
                ),
                "{record:?}"
            );
        }
    }

    #[test]
    fn default_remote_prefers_origin() {
        let names = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(default_remote(&names(&["fork"])).unwrap(), "fork");
        assert_eq!(
            default_remote(&names(&["fork", "origin"])).unwrap(),
            "origin"
        );
        assert_eq!(default_remote(&[]), Err(GitError::NoRemote));
        assert!(default_remote(&names(&["a", "b"])).is_err());
        assert!(default_remote(&names(&["-x"])).is_err());
    }
}
