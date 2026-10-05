//! Status reads against the generated fixture repositories.

mod common;

use std::fs;
use std::path::Path;
use std::process::Command;

use common::fixtures;
use repowatch_core::{
    ChangeCounts, EntryKind, FileChange, Git, GitError, Head, RepoStatus, Upstream, read_status,
};

fn status(name: &str) -> RepoStatus {
    let fixtures = fixtures();
    read_status(&fixtures.git, &fixtures.repo(name))
        .unwrap_or_else(|error| panic!("{name}: {error}"))
}

fn counts(staged: u32, unstaged: u32, untracked: u32, conflicted: u32) -> ChangeCounts {
    ChangeCounts {
        staged,
        unstaged,
        untracked,
        conflicted,
    }
}

fn branch(name: &str) -> Head {
    Head::Branch { name: name.into() }
}

fn tracking(name: &str, ahead: u32, behind: u32) -> Option<Upstream> {
    Some(Upstream {
        name: name.into(),
        ahead,
        behind,
        gone: false,
    })
}

#[test]
fn clean_repository_with_upstream() {
    let s = status("clean");
    assert_eq!(s.report.head, branch("main"));
    assert_eq!(s.report.oid.as_ref().map(String::len), Some(40));
    assert_eq!(s.report.upstream, tracking("origin/main", 0, 0));
    assert_eq!(s.remotes, ["origin"]);
    assert!(s.has_remote());
    assert!(s.report.counts.is_clean());
    assert_eq!(s.report.stash_count, 0);
}

#[test]
fn staged_unstaged_and_untracked_changes_are_counted() {
    assert_eq!(status("staged").report.counts, counts(2, 0, 0, 0));
    assert_eq!(status("unstaged").report.counts, counts(0, 2, 0, 0));
    // Two files and one untracked folder (listed once, as `new-dir/`).
    let untracked = status("untracked");
    assert_eq!(untracked.report.counts, counts(0, 0, 3, 0));
    assert!(
        untracked
            .report
            .entries
            .iter()
            .any(|e| e.path == "new-dir/" && e.kind == EntryKind::Untracked)
    );
    // src/app.txt is both staged and modified again: counted on both sides.
    let mixed = status("mixed");
    assert_eq!(mixed.report.counts, counts(2, 2, 1, 0));
    let app = mixed
        .report
        .entries
        .iter()
        .find(|e| e.path == "src/app.txt")
        .unwrap();
    assert_eq!(
        (app.index, app.worktree),
        (FileChange::Modified, FileChange::Modified)
    );
    let deleted = status("unstaged")
        .report
        .entries
        .into_iter()
        .find(|e| e.path == "src/app.txt")
        .unwrap();
    assert_eq!(deleted.worktree, FileChange::Deleted);
}

#[test]
fn staged_rename_keeps_both_paths() {
    let s = status("renamed");
    assert_eq!(s.report.counts, counts(1, 0, 0, 0));
    let entry = &s.report.entries[0];
    assert_eq!(entry.kind, EntryKind::Renamed);
    assert_eq!(entry.index, FileChange::Renamed);
    assert_eq!(entry.path, "src/main.txt");
    assert_eq!(entry.original_path.as_deref(), Some("src/app.txt"));
}

#[test]
fn merge_conflict_is_counted() {
    let s = status("conflict");
    assert_eq!(s.report.counts, counts(1, 0, 0, 1));
    let conflict = s
        .report
        .entries
        .iter()
        .find(|e| e.kind == EntryKind::Conflicted)
        .unwrap();
    assert_eq!(conflict.path, "notes.txt");
    assert_eq!(
        (conflict.index, conflict.worktree),
        (FileChange::Unmerged, FileChange::Unmerged)
    );
    assert!(!s.has_remote());
}

#[test]
fn ahead_behind_and_diverged() {
    assert_eq!(
        status("ahead").report.upstream,
        tracking("origin/main", 2, 0)
    );
    assert_eq!(
        status("behind").report.upstream,
        tracking("origin/main", 0, 1)
    );
    assert_eq!(
        status("diverged").report.upstream,
        tracking("origin/main", 1, 2)
    );
}

#[test]
fn status_does_not_fetch() {
    // The remote has a commit this clone never fetched.
    let fixtures = fixtures();
    let repo = fixtures.repo("unfetched");
    let tracking_ref = repo.join(".git/refs/remotes/origin/main");
    let before = fs::read(&tracking_ref).unwrap();
    let s = status("unfetched");
    assert_eq!(s.report.upstream, tracking("origin/main", 0, 0));
    assert_eq!(fs::read(&tracking_ref).unwrap(), before);
    assert!(!repo.join(".git/FETCH_HEAD").exists());
}

#[test]
fn branch_without_upstream_and_repository_without_remote() {
    let no_upstream = status("no-upstream");
    assert_eq!(no_upstream.report.head, branch("feature/no-upstream"));
    assert_eq!(no_upstream.report.upstream, None);
    assert!(no_upstream.has_remote());

    let no_remote = status("no-remote");
    assert_eq!(no_remote.report.upstream, None);
    assert!(!no_remote.has_remote());
    assert!(no_remote.remotes.is_empty());
}

#[test]
fn upstream_deleted_on_the_remote_is_gone() {
    let s = status("upstream-gone");
    assert_eq!(s.report.head, branch("feature/gone"));
    assert_eq!(
        s.report.upstream,
        Some(Upstream {
            name: "origin/feature/gone".into(),
            ahead: 0,
            behind: 0,
            gone: true
        })
    );
}

#[test]
fn detached_head() {
    let s = status("detached");
    assert_eq!(s.report.head, Head::Detached);
    assert_eq!(s.report.upstream, None);
    assert!(s.report.oid.is_some());
    assert!(s.has_remote());
}

#[test]
fn stashes_are_counted() {
    let s = status("stashes");
    assert_eq!(s.report.stash_count, 2);
    assert!(s.report.counts.is_clean());
}

#[test]
fn empty_repository_has_unborn_branch() {
    let s = status("empty");
    assert_eq!(
        s.report.head,
        Head::Unborn {
            name: "main".into()
        }
    );
    assert_eq!(s.report.oid, None);
    assert_eq!(s.report.upstream, None);
    assert!(!s.has_remote());
    assert!(s.report.counts.is_clean());
}

#[test]
fn other_default_branch_names() {
    let master = status("master-default");
    assert_eq!(master.report.head, branch("master"));
    assert_eq!(master.report.upstream, tracking("origin/master", 0, 0));
    assert_eq!(status("no-default-branch").report.head, branch("trunk"));
}

#[test]
fn linked_worktree_has_its_own_status() {
    let linked = status("worktrees-linked");
    assert_eq!(linked.report.head, branch("linked-branch"));
    assert_eq!(linked.report.counts, counts(0, 1, 0, 0));
    let inner = status("worktrees-main/.worktrees/inner");
    assert_eq!(inner.report.head, branch("inner-branch"));
    assert!(inner.report.counts.is_clean());
    // The inner worktree is excluded in the main repository.
    assert!(status("worktrees-main").report.counts.is_clean());
}

#[test]
fn nested_repository_is_an_untracked_folder_of_its_parent() {
    let s = status("nested-outer");
    assert_eq!(s.report.counts, counts(0, 0, 1, 0));
    assert_eq!(s.report.entries[0].path, "inner-repo/");
}

#[test]
fn odd_file_names_are_parsed_exactly() {
    let s = status("odd-names");
    let mut expected_untracked = vec!["-leading-dash.txt", "emoji 🚀.txt"];
    if !cfg!(windows) {
        expected_untracked.extend(["arrow -> name.txt", "tab\tand\nnewline.txt"]);
    }
    expected_untracked.sort_unstable();
    assert_eq!(
        s.report.counts,
        counts(3, 1, expected_untracked.len() as u32, 0)
    );

    let paths = |kind: EntryKind| {
        let mut paths: Vec<&str> = s
            .report
            .entries
            .iter()
            .filter(|e| e.kind == kind)
            .map(|e| e.path.as_str())
            .collect();
        paths.sort_unstable();
        paths
    };
    assert_eq!(paths(EntryKind::Untracked), expected_untracked);
    assert_eq!(
        paths(EntryKind::Changed),
        ["ação ü 日本.txt", "dash -- name.txt", "quote'and;semi.txt"]
    );
    let rename = s
        .report
        .entries
        .iter()
        .find(|e| e.kind == EntryKind::Renamed)
        .unwrap();
    assert_eq!(rename.path, "renamed space.txt");
    assert_eq!(rename.original_path.as_deref(), Some("with space.txt"));
}

#[test]
fn reading_status_does_not_rewrite_the_index() {
    // README.md's timestamp changed but not its content, so a status run that
    // may take optional locks refreshes and rewrites the index.
    let fixtures = fixtures();
    let repo = fixtures.repo("stat-dirty");
    let index = repo.join(".git/index");
    let before = fs::read(&index).unwrap();
    for _ in 0..2 {
        assert!(status("stat-dirty").report.counts.is_clean());
    }
    assert_eq!(
        fs::read(&index).unwrap(),
        before,
        "read_status rewrote the index"
    );

    // Control: plain `git status` (optional locks allowed) does rewrite it,
    // so the assertion above is meaningful.
    let output = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .arg("status")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", fixtures.out.join("git-env/gitconfig"))
        .env_remove("GIT_OPTIONAL_LOCKS")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_ne!(
        fs::read(&index).unwrap(),
        before,
        "control run did not refresh the index"
    );
}

#[test]
fn broken_repository_is_a_git_failure() {
    let fixtures = fixtures();
    match read_status(&fixtures.git, &fixtures.repo("broken")) {
        Err(GitError::Failed { code, stderr }) => {
            assert_eq!(code, Some(128));
            assert!(stderr.contains("bad object"), "{stderr}");
        }
        other => panic!("expected a git failure, got {other:?}"),
    }
}

#[test]
fn folder_that_is_not_a_repository() {
    let fixtures = fixtures();
    let result = read_status(&fixtures.git, &fixtures.repo("not-a-repo"));
    assert!(
        matches!(result, Err(GitError::NotARepository { .. })),
        "{result:?}"
    );
    // A subfolder of a repository is not read as that repository: git must
    // not walk up past the requested folder.
    let result = read_status(&fixtures.git, &fixtures.repo("clean").join("src"));
    assert!(
        matches!(result, Err(GitError::NotARepository { .. })),
        "{result:?}"
    );
}

#[test]
fn invalid_paths_and_missing_git() {
    let fixtures = fixtures();
    let missing = read_status(&fixtures.git, &fixtures.root.join("does-not-exist"));
    assert!(
        matches!(missing, Err(GitError::InvalidPath { .. })),
        "{missing:?}"
    );
    let relative = read_status(&fixtures.git, Path::new("clean"));
    assert!(
        matches!(relative, Err(GitError::InvalidPath { .. })),
        "{relative:?}"
    );

    let no_git = Git::new().with_program("repowatch-no-such-git-binary");
    let result = read_status(&no_git, &fixtures.repo("clean"));
    assert_eq!(result, Err(GitError::NotInstalled));
}

#[test]
fn status_serializes_for_the_app() {
    let json = serde_json::to_value(status("ahead")).unwrap();
    assert_eq!(
        json["head"],
        serde_json::json!({ "kind": "branch", "name": "main" })
    );
    assert_eq!(json["upstream"]["ahead"], 2);
    assert_eq!(json["counts"]["staged"], 0);
    assert_eq!(json["stashCount"], 0);
    assert_eq!(json["remotes"], serde_json::json!(["origin"]));
}
