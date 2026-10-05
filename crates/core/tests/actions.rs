//! The git actions against throwaway repositories.
//!
//! Every test builds its own sandbox in the OS temp folder: a working
//! repository whose `origin` is a local bare repository, plus helper clones
//! that play "someone else". Git runs with an isolated configuration, so no
//! test reads the user's config, touches a real repository or uses the
//! network.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};

use repowatch_core::{
    DiffSide, FileDiff, Git, GitError, LineKind, LostCommitOptions, apply_stash, commit,
    create_branch, delete_merged_branch, drop_stash, fetch, find_lost_commits, list_stashes, pull,
    push, read_branches, read_file_diff, read_status, recover_commit, stage_file, stage_hunk,
    switch_branch, unstage_file, unstage_hunk,
};

const PREFIX: &str = "repowatch-actions-";

const GITCONFIG: &str = "[user]\n\tname = Repowatch Tests\n\temail = tests@repowatch.invalid\n\
[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n\tfsmonitor = false\n\
[commit]\n\tgpgSign = false\n[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n\
[advice]\n\tdetachedHead = false\n";

/// Twenty numbered lines, so edits at the top and bottom make two hunks.
fn numbered() -> String {
    (1..=20).map(|n| format!("line {n}\n")).collect()
}

struct Sandbox {
    dir: PathBuf,
    /// The repository the actions run on.
    work: PathBuf,
    /// Its `origin`.
    remote: PathBuf,
    git: Git,
}

impl Sandbox {
    /// A repository with two commits on `main`, pushed to its bare `origin`
    /// with an upstream.
    fn new(label: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "{PREFIX}{}-{}-{label}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        if dir.exists() {
            fs::remove_dir_all(&dir).unwrap();
        }
        let env = dir.join("git-env");
        fs::create_dir_all(env.join("home")).unwrap();
        fs::create_dir_all(env.join("xdg")).unwrap();
        fs::write(env.join("gitconfig"), GITCONFIG).unwrap();
        let git = Git::new()
            .with_env("GIT_CONFIG_NOSYSTEM", "1")
            .with_env("GIT_CONFIG_GLOBAL", env.join("gitconfig"))
            .with_env("HOME", env.join("home"))
            .with_env("XDG_CONFIG_HOME", env.join("xdg"));
        let sandbox = Self {
            work: dir.join("work"),
            remote: dir.join("remote.git"),
            dir,
            git,
        };
        sandbox.run(
            &sandbox.dir,
            &["init", "-q", "--bare", "-b", "main", "remote.git"],
        );
        sandbox.run(&sandbox.dir, &["init", "-q", "-b", "main", "work"]);
        sandbox.write("README.md", "# Sandbox\n");
        sandbox.write("notes.txt", &numbered());
        sandbox.commit_all("Initial commit");
        sandbox.write("CHANGELOG.md", "- first\n");
        sandbox.commit_all("Add changelog");
        let remote = sandbox.remote.to_string_lossy().into_owned();
        sandbox.run(&sandbox.work, &["remote", "add", "origin", &remote]);
        sandbox.run(&sandbox.work, &["push", "-q", "-u", "origin", "main"]);
        sandbox
    }

    /// Runs a setup git command (any command; this is test scaffolding, not
    /// the code under test) and returns stdout.
    fn run(&self, cwd: &Path, args: &[&str]) -> String {
        let output = self.setup_command(cwd, args).output().unwrap();
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    fn setup_command(&self, cwd: &Path, args: &[&str]) -> Command {
        assert!(cwd.starts_with(&self.dir), "setup runs only in the sandbox");
        let env = self.dir.join("git-env");
        let mut command = Command::new("git");
        command
            .arg("--no-optional-locks")
            .args(args)
            .current_dir(cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", env.join("gitconfig"))
            .env("HOME", env.join("home"))
            .env("XDG_CONFIG_HOME", env.join("xdg"))
            .env("GIT_CEILING_DIRECTORIES", &self.dir)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C");
        for (key, _) in std::env::vars_os() {
            let key = key.to_string_lossy().to_uppercase();
            if key.starts_with("GIT_")
                && !matches!(
                    key.as_str(),
                    "GIT_CONFIG_NOSYSTEM"
                        | "GIT_CONFIG_GLOBAL"
                        | "GIT_CEILING_DIRECTORIES"
                        | "GIT_TERMINAL_PROMPT"
                )
            {
                command.env_remove(&key);
            }
        }
        command
    }

    fn write(&self, relative: &str, content: &str) {
        let path = self.work.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn read(&self, relative: &str) -> String {
        fs::read_to_string(self.work.join(relative)).unwrap()
    }

    fn commit_all(&self, message: &str) {
        self.run(&self.work, &["add", "-A"]);
        self.run(&self.work, &["commit", "-q", "-m", message]);
    }

    fn rev(&self, repo: &Path, rev: &str) -> String {
        self.run(repo, &["rev-parse", "--verify", rev])
            .trim()
            .to_string()
    }

    /// A second clone of `origin` that commits and pushes `count` changes.
    fn push_from_elsewhere(&self, name: &str, count: u32) {
        let other = self.dir.join(name);
        let remote = self.remote.to_string_lossy().into_owned();
        self.run(&self.dir, &["clone", "-q", &remote, name]);
        for n in 1..=count {
            fs::write(other.join(format!("{name}-{n}.txt")), format!("{n}\n")).unwrap();
            self.run(&other, &["add", "-A"]);
            self.run(
                &other,
                &["commit", "-q", "-m", &format!("Remote change {n}")],
            );
        }
        self.run(&other, &["push", "-q", "origin", "HEAD"]);
    }

    /// Everything an action could change in the working repository: refs,
    /// HEAD, index, stashes, status and working-tree files.
    fn state(&self) -> String {
        let mut state = String::new();
        for args in [
            &[
                "for-each-ref",
                "--format=%(refname) %(objectname) %(upstream)",
            ][..],
            &["symbolic-ref", "-q", "HEAD"],
            &["ls-files", "--stage"],
            &["stash", "list", "--format=%H %gs"],
            &[
                "status",
                "--porcelain=v2",
                "--branch",
                "--untracked-files=all",
            ],
        ] {
            let output = self.setup_command(&self.work, args).output().unwrap();
            state.push_str(&String::from_utf8_lossy(&output.stdout));
            state.push_str("--\n");
        }
        let mut files = Vec::new();
        collect_files(&self.work, &self.work, &mut files);
        files.sort();
        for (path, content) in files {
            state.push_str(&format!("{path}: {content:?}\n"));
        }
        state
    }

    /// The remote's refs.
    fn remote_refs(&self) -> String {
        self.run(
            &self.remote,
            &["for-each-ref", "--format=%(refname) %(objectname)"],
        )
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        // Only folders this helper created, inside the OS temp folder.
        if self.dir.starts_with(std::env::temp_dir())
            && self
                .dir
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with(PREFIX))
        {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }
}

fn collect_files(root: &Path, dir: &Path, files: &mut Vec<(String, Vec<u8>)>) {
    for entry in fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if entry.file_name() == ".git" {
            continue;
        }
        if path.is_dir() {
            collect_files(root, &path, files);
        } else {
            let relative = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            files.push((relative, fs::read(&path).unwrap()));
        }
    }
}

fn texts(diff: &FileDiff, kind: LineKind) -> Vec<String> {
    diff.hunks
        .iter()
        .flat_map(|hunk| &hunk.lines)
        .filter(|line| line.kind == kind)
        .map(|line| line.text.clone())
        .collect()
}

/// Edits the first and last lines of `notes.txt`: two unstaged hunks.
fn edit_both_ends(sandbox: &Sandbox) {
    let edited = numbered()
        .replace("line 1\n", "line 1 edited\n")
        .replace("line 20\n", "line 20 edited\n");
    sandbox.write("notes.txt", &edited);
}

#[test]
fn diffs_of_unstaged_staged_and_untracked_files() {
    let s = Sandbox::new("diff");
    edit_both_ends(&s);
    s.write("README.md", "# Sandbox\n\nStaged line.\n");
    s.run(&s.work, &["add", "README.md"]);
    s.write("new.txt", "first\nsecond");
    s.write("image.bin", "a\0b");

    let unstaged = read_file_diff(&s.git, &s.work, "notes.txt", DiffSide::Unstaged).unwrap();
    assert_eq!(unstaged.hunks.len(), 2);
    assert!(!unstaged.binary && !unstaged.truncated);
    assert_eq!(texts(&unstaged, LineKind::Removed), ["line 1", "line 20"]);
    assert_eq!(
        texts(&unstaged, LineKind::Added),
        ["line 1 edited", "line 20 edited"]
    );
    let first = &unstaged.hunks[0];
    assert_eq!((first.old_start, first.new_start), (1, 1));
    assert_eq!(first.lines[0].old_line, Some(1));

    let staged = read_file_diff(&s.git, &s.work, "README.md", DiffSide::Staged).unwrap();
    assert_eq!(texts(&staged, LineKind::Added), ["", "Staged line."]);
    let none = read_file_diff(&s.git, &s.work, "README.md", DiffSide::Unstaged).unwrap();
    assert!(none.hunks.is_empty());

    let untracked = read_file_diff(&s.git, &s.work, "new.txt", DiffSide::Untracked).unwrap();
    assert_eq!(texts(&untracked, LineKind::Added), ["first", "second"]);
    assert_eq!(untracked.hunks[0].header, "@@ -0,0 +1,2 @@");
    assert_eq!(
        untracked.hunks[0].lines.last().unwrap().kind,
        LineKind::NoNewline
    );
    let binary = read_file_diff(&s.git, &s.work, "image.bin", DiffSide::Untracked).unwrap();
    assert!(binary.binary && binary.hunks.is_empty());

    let missing = read_file_diff(&s.git, &s.work, "gone.txt", DiffSide::Untracked);
    assert!(
        matches!(missing, Err(GitError::Stale { .. })),
        "{missing:?}"
    );
}

#[test]
fn files_and_hunks_are_staged_and_unstaged() {
    let s = Sandbox::new("stage");
    edit_both_ends(&s);
    let before = read_file_diff(&s.git, &s.work, "notes.txt", DiffSide::Unstaged).unwrap();
    let (top, bottom) = (&before.hunks[0], &before.hunks[1]);

    // Stage only the bottom hunk.
    stage_hunk(&s.git, &s.work, "notes.txt", &bottom.id).unwrap();
    let staged = read_file_diff(&s.git, &s.work, "notes.txt", DiffSide::Staged).unwrap();
    assert_eq!(texts(&staged, LineKind::Added), ["line 20 edited"]);
    let unstaged = read_file_diff(&s.git, &s.work, "notes.txt", DiffSide::Unstaged).unwrap();
    assert_eq!(texts(&unstaged, LineKind::Added), ["line 1 edited"]);
    assert_eq!(unstaged.hunks[0].id, top.id, "the other hunk is unchanged");

    // A hunk id that is no longer in the diff is stale; nothing changes.
    let state = s.state();
    let stale = stage_hunk(&s.git, &s.work, "notes.txt", &bottom.id);
    assert!(matches!(stale, Err(GitError::Stale { .. })), "{stale:?}");
    let unknown = stage_hunk(&s.git, &s.work, "notes.txt", "0000000000000000");
    assert!(
        matches!(unknown, Err(GitError::Stale { .. })),
        "{unknown:?}"
    );
    assert_eq!(s.state(), state);

    // Unstage that hunk again: the working tree keeps both edits.
    let staged_hunk = &staged.hunks[0];
    unstage_hunk(&s.git, &s.work, "notes.txt", &staged_hunk.id).unwrap();
    let staged = read_file_diff(&s.git, &s.work, "notes.txt", DiffSide::Staged).unwrap();
    assert!(staged.hunks.is_empty());
    assert!(s.read("notes.txt").contains("line 20 edited"));

    // Whole files, including an untracked one.
    s.write("new.txt", "new\n");
    stage_file(&s.git, &s.work, "notes.txt").unwrap();
    stage_file(&s.git, &s.work, "new.txt").unwrap();
    let counts = read_status(&s.git, &s.work).unwrap().report.counts;
    assert_eq!(
        (counts.staged, counts.unstaged, counts.untracked),
        (2, 0, 0)
    );
    unstage_file(&s.git, &s.work, "notes.txt").unwrap();
    unstage_file(&s.git, &s.work, "new.txt").unwrap();
    let counts = read_status(&s.git, &s.work).unwrap().report.counts;
    assert_eq!(
        (counts.staged, counts.unstaged, counts.untracked),
        (0, 1, 1)
    );
    assert!(s.read("notes.txt").contains("line 1 edited"));
}

#[test]
fn unstaging_works_before_the_first_commit() {
    let s = Sandbox::new("unborn");
    let fresh = s.dir.join("fresh");
    s.run(&s.dir, &["init", "-q", "-b", "main", "fresh"]);
    fs::write(fresh.join("a.txt"), "one\n").unwrap();
    stage_file(&s.git, &fresh, "a.txt").unwrap();
    fs::write(fresh.join("a.txt"), "one\ntwo\n").unwrap();
    assert_eq!(read_status(&s.git, &fresh).unwrap().report.counts.staged, 1);
    unstage_file(&s.git, &fresh, "a.txt").unwrap();
    let counts = read_status(&s.git, &fresh).unwrap().report.counts;
    assert_eq!((counts.staged, counts.untracked), (0, 1));
    assert_eq!(
        fs::read_to_string(fresh.join("a.txt")).unwrap(),
        "one\ntwo\n"
    );
}

#[test]
fn commit_takes_the_message_literally() {
    let s = Sandbox::new("commit");
    let state = s.state();
    assert_eq!(
        commit(&s.git, &s.work, "Nothing staged"),
        Err(GitError::NothingToCommit)
    );
    assert!(matches!(
        commit(&s.git, &s.work, "  \n"),
        Err(GitError::InvalidInput { .. })
    ));
    assert_eq!(s.state(), state);

    s.write("a.txt", "a\n");
    stage_file(&s.git, &s.work, "a.txt").unwrap();
    commit(&s.git, &s.work, "--amend\n\nBody; $(echo no shell) `x`").unwrap();
    let message = s.run(&s.work, &["log", "-1", "--format=%B"]);
    assert_eq!(message.trim_end(), "--amend\n\nBody; $(echo no shell) `x`");
    assert_eq!(s.run(&s.work, &["rev-list", "--count", "HEAD"]).trim(), "3");
    assert!(
        read_status(&s.git, &s.work)
            .unwrap()
            .report
            .counts
            .is_clean()
    );
}

#[test]
fn fetch_and_pull_fast_forward() {
    let s = Sandbox::new("pull");
    s.push_from_elsewhere("other", 2);
    let before = s.rev(&s.work, "HEAD");

    fetch(&s.git, &s.work, Some("origin")).unwrap();
    let upstream = read_status(&s.git, &s.work)
        .unwrap()
        .report
        .upstream
        .unwrap();
    assert_eq!((upstream.ahead, upstream.behind), (0, 2));
    assert_eq!(s.rev(&s.work, "HEAD"), before, "fetch leaves the branch");

    pull(&s.git, &s.work).unwrap();
    assert_eq!(
        s.rev(&s.work, "HEAD"),
        s.rev(&s.work, "refs/remotes/origin/main")
    );
    assert!(s.work.join("other-2.txt").is_file());

    // Already up to date, and fetching every remote.
    pull(&s.git, &s.work).unwrap();
    fetch(&s.git, &s.work, None).unwrap();
    assert!(matches!(
        fetch(&s.git, &s.work, Some("upstream")),
        Err(GitError::InvalidInput { .. })
    ));
}

#[test]
fn pull_of_a_diverged_branch_fails_and_changes_nothing() {
    let s = Sandbox::new("diverged");
    s.push_from_elsewhere("other", 1);
    s.write("local.txt", "local\n");
    s.commit_all("Local change");
    // Fetch first so the remote-tracking ref is current; the pull's own
    // fetch then has nothing to change.
    fetch(&s.git, &s.work, None).unwrap();
    let state = s.state();

    assert_eq!(pull(&s.git, &s.work), Err(GitError::NotFastForward));
    assert_eq!(s.state(), state);
    assert!(!s.work.join("other-1.txt").exists());
}

#[test]
fn pull_needs_a_branch_with_an_upstream() {
    let s = Sandbox::new("pull-errors");
    s.run(&s.work, &["switch", "-q", "-c", "lonely"]);
    assert_eq!(
        pull(&s.git, &s.work),
        Err(GitError::NoUpstream {
            branch: "lonely".into()
        })
    );
    s.run(&s.work, &["switch", "-q", "--detach"]);
    assert_eq!(pull(&s.git, &s.work), Err(GitError::DetachedHead));
    assert_eq!(push(&s.git, &s.work), Err(GitError::DetachedHead));
}

#[test]
fn push_sends_the_current_branch_and_never_forces() {
    let s = Sandbox::new("push");
    s.write("a.txt", "a\n");
    s.commit_all("Local change");
    push(&s.git, &s.work).unwrap();
    assert_eq!(s.rev(&s.remote, "refs/heads/main"), s.rev(&s.work, "HEAD"));

    // A branch without upstream is pushed under its name and tracks it.
    create_branch(&s.git, &s.work, "feature/x", None).unwrap();
    switch_branch(&s.git, &s.work, "feature/x").unwrap();
    s.write("x.txt", "x\n");
    s.commit_all("Feature");
    push(&s.git, &s.work).unwrap();
    assert_eq!(
        s.rev(&s.remote, "refs/heads/feature/x"),
        s.rev(&s.work, "HEAD")
    );
    let status = read_status(&s.git, &s.work).unwrap();
    assert_eq!(status.report.upstream.unwrap().name, "origin/feature/x");

    // Someone else pushed to main; the local main diverged: rejected.
    switch_branch(&s.git, &s.work, "main").unwrap();
    s.push_from_elsewhere("other", 1);
    s.write("b.txt", "b\n");
    s.commit_all("Diverging change");
    let remote = s.remote_refs();
    let state = s.state();
    let result = push(&s.git, &s.work);
    assert!(
        matches!(result, Err(GitError::PushRejected { .. })),
        "{result:?}"
    );
    assert_eq!(s.remote_refs(), remote, "the remote is unchanged");
    assert_eq!(s.state(), state);
}

#[test]
fn push_without_a_remote_fails() {
    let s = Sandbox::new("no-remote");
    s.run(&s.work, &["remote", "remove", "origin"]);
    assert_eq!(push(&s.git, &s.work), Err(GitError::NoRemote));
    assert_eq!(fetch(&s.git, &s.work, None), Err(GitError::NoRemote));
}

#[test]
fn branches_are_created_switched_and_deleted_only_when_merged() {
    let s = Sandbox::new("branches");
    create_branch(&s.git, &s.work, "merged", None).unwrap();
    assert_eq!(
        create_branch(&s.git, &s.work, "merged", None),
        Err(GitError::BranchExists {
            branch: "merged".into()
        })
    );
    create_branch(&s.git, &s.work, "unmerged", None).unwrap();
    switch_branch(&s.git, &s.work, "unmerged").unwrap();
    s.write("u.txt", "u\n");
    s.commit_all("Unmerged work");
    switch_branch(&s.git, &s.work, "main").unwrap();

    let state = s.state();
    assert_eq!(
        delete_merged_branch(&s.git, &s.work, "unmerged"),
        Err(GitError::BranchNotMerged {
            branch: "unmerged".into()
        })
    );
    let refused = |name: &str, expected: &str| match delete_merged_branch(&s.git, &s.work, name) {
        Err(GitError::InvalidInput { reason, .. }) => {
            assert!(reason.contains(expected), "{name}: {reason}")
        }
        other => panic!("{name}: {other:?}"),
    };
    refused("nope", "no such");
    refused("main", "current");
    switch_branch(&s.git, &s.work, "merged").unwrap();
    refused("merged", "current");
    refused("main", "default");
    switch_branch(&s.git, &s.work, "main").unwrap();
    assert_eq!(s.state(), state);

    delete_merged_branch(&s.git, &s.work, "merged").unwrap();
    let names: Vec<String> = read_branches(&s.git, &s.work)
        .unwrap()
        .branches
        .into_iter()
        .map(|branch| branch.name)
        .collect();
    assert_eq!(names, ["main", "unmerged"]);
}

#[test]
fn switching_never_discards_local_changes() {
    let s = Sandbox::new("switch");
    create_branch(&s.git, &s.work, "other", None).unwrap();
    switch_branch(&s.git, &s.work, "other").unwrap();
    s.write("README.md", "# Changed on other\n");
    s.commit_all("Change README");
    switch_branch(&s.git, &s.work, "main").unwrap();
    s.write("README.md", "# Uncommitted edit\n");
    let state = s.state();
    let result = switch_branch(&s.git, &s.work, "other");
    assert!(matches!(result, Err(GitError::Failed { .. })), "{result:?}");
    assert_eq!(s.state(), state);
    assert_eq!(s.read("README.md"), "# Uncommitted edit\n");
    // A branch that exists only on the remote is not guessed into a new
    // local branch.
    s.run(
        &s.work,
        &["push", "-q", "origin", "main:refs/heads/remote-only"],
    );
    s.run(&s.work, &["fetch", "-q", "origin"]);
    let state = s.state();
    let result = switch_branch(&s.git, &s.work, "remote-only");
    assert!(matches!(result, Err(GitError::Failed { .. })), "{result:?}");
    assert_eq!(s.state(), state);
}

#[test]
fn stashes_are_applied_and_dropped_by_identity() {
    let s = Sandbox::new("stash");
    s.write("README.md", "# First stash\n");
    s.run(&s.work, &["stash", "push", "-q", "-m", "first"]);
    s.write("notes.txt", "second stash\n");
    s.run(&s.work, &["stash", "push", "-q", "-m", "second"]);
    let stashes = list_stashes(&s.git, &s.work).unwrap();
    assert_eq!(stashes.len(), 2);
    let first = &stashes[1];
    assert!(first.message.ends_with("first"));

    apply_stash(&s.git, &s.work, first.index, &first.oid).unwrap();
    assert_eq!(s.read("README.md"), "# First stash\n");
    assert_eq!(list_stashes(&s.git, &s.work).unwrap().len(), 2, "kept");

    // The index now names another stash: refused, nothing changes.
    let state = s.state();
    let wrong = drop_stash(&s.git, &s.work, 0, &first.oid);
    assert!(matches!(wrong, Err(GitError::Stale { .. })), "{wrong:?}");
    let missing = apply_stash(&s.git, &s.work, 5, &first.oid);
    assert!(
        matches!(missing, Err(GitError::Stale { .. })),
        "{missing:?}"
    );
    assert!(matches!(
        drop_stash(&s.git, &s.work, 1, "stash@{1}"),
        Err(GitError::InvalidInput { .. })
    ));
    assert_eq!(s.state(), state);

    drop_stash(&s.git, &s.work, first.index, &first.oid).unwrap();
    let left = list_stashes(&s.git, &s.work).unwrap();
    assert_eq!(left.len(), 1);
    assert!(left[0].message.ends_with("second"));
}

#[test]
fn a_lost_commit_is_recovered_to_a_new_branch() {
    let s = Sandbox::new("recover");
    s.run(&s.work, &["switch", "-q", "-c", "doomed"]);
    s.write("doomed.txt", "work\n");
    s.commit_all("Work on a deleted branch");
    let oid = s.rev(&s.work, "HEAD");
    s.run(&s.work, &["switch", "-q", "main"]);
    s.run(&s.work, &["branch", "-q", "-D", "doomed"]); // test setup only

    let lost = find_lost_commits(&s.git, &s.work, &LostCommitOptions::default()).unwrap();
    assert!(lost.commits.iter().any(|commit| commit.oid == oid));
    assert_eq!(
        recover_commit(&s.git, &s.work, &oid, "main"),
        Err(GitError::BranchExists {
            branch: "main".into()
        })
    );
    recover_commit(&s.git, &s.work, &oid, "recovered/doomed").unwrap();
    assert_eq!(s.rev(&s.work, "refs/heads/recovered/doomed"), oid);
    assert_eq!(
        s.run(&s.work, &["symbolic-ref", "HEAD"]).trim(),
        "refs/heads/main"
    );
    let lost = find_lost_commits(&s.git, &s.work, &LostCommitOptions::default()).unwrap();
    assert!(lost.commits.iter().all(|commit| commit.oid != oid));
}

/// Option and path injection: every hostile value is refused before git runs
/// and the repository is unchanged.
#[test]
fn hostile_names_paths_and_ids_are_refused() {
    let s = Sandbox::new("injection");
    s.write("notes.txt", "edited\n");
    s.write("new.txt", "new\n");
    let state = s.state();
    let remote_refs = s.remote_refs();
    let head = s.rev(&s.work, "HEAD");
    let invalid = |result: Result<(), GitError>, what: &str| {
        assert!(
            matches!(result, Err(GitError::InvalidInput { .. })),
            "{what}: {result:?}"
        );
    };

    for name in [
        "-D",
        "--force",
        "-f",
        "--delete",
        "--upload-pack=calc.exe",
        "-",
        "a b",
        "..",
        "main~1",
        "x@{0}",
        "HEAD",
    ] {
        invalid(create_branch(&s.git, &s.work, name, None), name);
        invalid(switch_branch(&s.git, &s.work, name), name);
        invalid(delete_merged_branch(&s.git, &s.work, name), name);
        invalid(recover_commit(&s.git, &s.work, &head, name), name);
    }
    for oid in ["--all", "HEAD", "HEAD~1", "-1", &head[..12], "main"] {
        invalid(create_branch(&s.git, &s.work, "x", Some(oid)), oid);
        invalid(recover_commit(&s.git, &s.work, oid, "x"), oid);
        invalid(apply_stash(&s.git, &s.work, 0, oid), oid);
        invalid(drop_stash(&s.git, &s.work, 0, oid), oid);
    }
    let outside = s.dir.join("outside.txt");
    fs::write(&outside, "secret\n").unwrap();
    let outside_text = outside.to_string_lossy().replace('\\', "/");
    for path in [
        "../outside.txt",
        "sub/../../outside.txt",
        &outside_text,
        "/etc/passwd",
        "C:/Windows/win.ini",
        "notes.txt\\..\\..\\outside.txt",
        ".git/config",
        ".git/hooks/pre-commit",
        "",
        "./notes.txt",
    ] {
        invalid(stage_file(&s.git, &s.work, path), path);
        invalid(unstage_file(&s.git, &s.work, path), path);
        invalid(stage_hunk(&s.git, &s.work, path, "0"), path);
        invalid(unstage_hunk(&s.git, &s.work, path, "0"), path);
        for side in [DiffSide::Unstaged, DiffSide::Staged, DiffSide::Untracked] {
            let result = read_file_diff(&s.git, &s.work, path, side);
            assert!(
                matches!(result, Err(GitError::InvalidInput { .. })),
                "{path} {side:?}: {result:?}"
            );
        }
    }
    for remote in ["--upload-pack=calc.exe", "-oProxyCommand=x", "+origin"] {
        invalid(fetch(&s.git, &s.work, Some(remote)), remote);
    }
    assert_eq!(s.state(), state);
    assert_eq!(s.remote_refs(), remote_refs);
}

/// Paths that look like options or globs are staged literally, one file.
#[test]
fn option_and_glob_like_paths_stay_literal() {
    let s = Sandbox::new("literal");
    s.write("-A", "dash\n");
    s.write("--all", "dashes\n");
    s.write("notes.txt", "edited\n");
    s.write("other.txt", "other\n");
    stage_file(&s.git, &s.work, "-A").unwrap();
    stage_file(&s.git, &s.work, "--all").unwrap();
    let staged = s.run(&s.work, &["diff", "--cached", "--name-only"]);
    let mut staged: Vec<&str> = staged.lines().collect();
    staged.sort_unstable();
    assert_eq!(staged, ["--all", "-A"]);

    let state = s.state();
    for glob in ["*.txt", "*", ":(glob)*", "n?tes.txt", "[n]otes.txt"] {
        let result = stage_file(&s.git, &s.work, glob);
        assert!(result.is_err(), "{glob}: {result:?}");
    }
    assert_eq!(s.state(), state, "no glob matched anything");

    let diff = read_file_diff(&s.git, &s.work, "-A", DiffSide::Staged).unwrap();
    assert_eq!(texts(&diff, LineKind::Added), ["dash"]);
}

/// Runs every action with git tracing on and checks every git command that
/// ran, including the ones git starts itself: none forces, deletes with
/// `-D`, resets hard, rebases or amends.
#[test]
fn no_action_emits_force_delete_reset_rebase_or_amend() {
    let s = Sandbox::new("trace");
    let trace = s.dir.join("trace.log");
    let git = s.git.clone().with_env("GIT_TRACE", &trace);

    edit_both_ends(&s);
    s.write("new.txt", "new\n");
    let diff = read_file_diff(&git, &s.work, "notes.txt", DiffSide::Unstaged).unwrap();
    read_file_diff(&git, &s.work, "new.txt", DiffSide::Untracked).unwrap();
    stage_hunk(&git, &s.work, "notes.txt", &diff.hunks[0].id).unwrap();
    let staged = read_file_diff(&git, &s.work, "notes.txt", DiffSide::Staged).unwrap();
    unstage_hunk(&git, &s.work, "notes.txt", &staged.hunks[0].id).unwrap();
    stage_file(&git, &s.work, "notes.txt").unwrap();
    stage_file(&git, &s.work, "new.txt").unwrap();
    unstage_file(&git, &s.work, "new.txt").unwrap();
    commit(&git, &s.work, "--amend").unwrap();
    push(&git, &s.work).unwrap();
    s.push_from_elsewhere("other", 1);
    fetch(&git, &s.work, None).unwrap();
    pull(&git, &s.work).unwrap();
    create_branch(&git, &s.work, "topic", None).unwrap();
    switch_branch(&git, &s.work, "topic").unwrap();
    s.write("t.txt", "t\n");
    s.commit_all("Topic work");
    push(&git, &s.work).unwrap();
    switch_branch(&git, &s.work, "main").unwrap();
    assert!(delete_merged_branch(&git, &s.work, "topic").is_err());
    create_branch(&git, &s.work, "done", None).unwrap();
    delete_merged_branch(&git, &s.work, "done").unwrap();
    s.write("README.md", "# Stashed\n");
    s.run(&s.work, &["stash", "push", "-q"]);
    let stash = list_stashes(&git, &s.work).unwrap().remove(0);
    apply_stash(&git, &s.work, stash.index, &stash.oid).unwrap();
    s.run(&s.work, &["checkout", "-q", "--", "README.md"]); // test setup only
    drop_stash(&git, &s.work, stash.index, &stash.oid).unwrap();
    recover_commit(&git, &s.work, &stash.oid, "recovered").unwrap();
    // Failing paths too: non-fast-forward pull and rejected push.
    s.write("local.txt", "local\n");
    s.commit_all("Local");
    s.push_from_elsewhere("other-2", 1);
    assert_eq!(pull(&git, &s.work), Err(GitError::NotFastForward));
    assert!(matches!(
        push(&git, &s.work),
        Err(GitError::PushRejected { .. })
    ));

    let log = fs::read_to_string(&trace).unwrap();
    if std::env::var_os("REPOWATCH_SHOW_TRACE").is_some() {
        println!("{log}");
    }
    let commands: Vec<Vec<String>> = log
        .lines()
        .filter_map(|line| {
            ["trace: built-in: ", "trace: exec: ", "trace: run_command: "]
                .iter()
                .find_map(|marker| line.split_once(marker).map(|(_, rest)| rest))
        })
        .map(|command| {
            command
                .split_whitespace()
                .map(|word| word.trim_matches('\'').to_string())
                .collect()
        })
        .collect();
    for expected in [
        "add", "restore", "apply", "commit", "push", "fetch", "merge", "branch", "switch", "stash",
    ] {
        assert!(
            commands
                .iter()
                .any(|words| words.get(1).is_some_and(|word| word == expected)),
            "git {expected} was traced"
        );
    }
    let forbidden_word = |word: &str| {
        matches!(
            word,
            "-f" | "-D" | "-M" | "-C" | "--hard" | "--amend" | "--delete" | "--mirror"
        ) || word.starts_with("--force")
            || word.starts_with("+refs")
            || word.contains("rebase")
    };
    for words in &commands {
        // Our own commit message is on stdin, never in the command line.
        assert!(
            !words.iter().any(|word| forbidden_word(word)),
            "forbidden git command: {words:?}"
        );
        assert!(
            !(words.get(1).is_some_and(|word| word == "reset")),
            "git reset ran: {words:?}"
        );
    }
}
