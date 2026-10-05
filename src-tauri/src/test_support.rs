//! Helpers shared by the unit tests: temporary folders, small git
//! repositories built with an isolated git, and a fake scan backend.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use repowatch_core::{
    Attention, ChangeCounts, DiscoveredRepo, Discovery, DiscoveryOptions, Git, Head, RepoKind,
    RepoSummary, Upstream,
};

use crate::scanner::{GitBackend, ScanBackend, lock};

/// A new empty folder inside the OS temp folder.
pub fn temp_dir(name: &str) -> PathBuf {
    static COUNTER: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir()
        .join("repowatch-app-tests")
        .join(format!(
            "{name}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn git_env_dir() -> PathBuf {
    let dir = std::env::temp_dir()
        .join("repowatch-app-tests")
        .join("git-env");
    std::fs::create_dir_all(dir.join("home")).unwrap();
    // Identity for commits made by the actions under test.
    std::fs::write(
        dir.join("gitconfig"),
        "[user]\n\tname = Repowatch Tests\n\temail = tests@repowatch.invalid\n\
         [commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n",
    )
    .unwrap();
    dir
}

/// Environment that isolates git from the user's system and global config.
fn isolated_env() -> Vec<(&'static str, PathBuf)> {
    let dir = git_env_dir();
    vec![
        ("GIT_CONFIG_NOSYSTEM", PathBuf::from("1")),
        ("GIT_CONFIG_GLOBAL", dir.join("gitconfig")),
        ("HOME", dir.join("home")),
        ("XDG_CONFIG_HOME", dir.join("xdg")),
    ]
}

/// The core's git with the isolated environment.
pub fn isolated_git() -> Git {
    isolated_env()
        .into_iter()
        .fold(Git::new(), |git, (key, value)| git.with_env(key, value))
}

pub fn git_backend() -> GitBackend {
    GitBackend(isolated_git())
}

/// Runs git in `dir` (test setup only) and returns its stdout.
pub fn git(dir: &Path, args: &[&str]) -> String {
    let mut command = Command::new("git");
    command
        .args([
            "-c",
            "user.name=Repowatch Tests",
            "-c",
            "user.email=tests@repowatch.invalid",
            "-c",
            "init.defaultBranch=main",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.autocrlf=false",
        ])
        .args(args)
        .current_dir(dir);
    for key in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"] {
        command.env_remove(key);
    }
    for (key, value) in isolated_env() {
        command.env(key, value);
    }
    let output = command.output().expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// A repository at `dir` with one commit on `main`.
pub fn commit_repo(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    git(dir, &["init", "--quiet"]);
    std::fs::write(dir.join("README.md"), "hello\n").unwrap();
    git(dir, &["add", "README.md"]);
    git(dir, &["commit", "--quiet", "-m", "first"]);
}

/// A repository cloned from a new bare remote; returns (clone, remote).
pub fn repo_with_remote(dir: &Path) -> (PathBuf, PathBuf) {
    let seed = dir.join("seed");
    let remote = dir.join("remote.git");
    let clone = dir.join("clone");
    commit_repo(&seed);
    git(dir, &["clone", "--quiet", "--bare", "seed", "remote.git"]);
    git(dir, &["clone", "--quiet", "remote.git", "clone"]);
    (clone, remote)
}

/// A scan backend with named fake repositories under a fake root.
#[derive(Clone)]
pub struct FakeBackend {
    inner: Arc<FakeInner>,
}

struct FakeInner {
    root: PathBuf,
    names: Mutex<Vec<String>>,
    staged: Mutex<HashMap<String, u32>>,
    discover_calls: AtomicUsize,
    summarize_calls: Mutex<HashMap<String, usize>>,
    gate: Gate,
    discovering: (Mutex<usize>, Condvar),
}

/// Blocks discovery until opened; open by default.
#[derive(Clone)]
pub struct Gate {
    inner: Arc<(Mutex<bool>, Condvar)>,
}

impl Gate {
    fn new(open: bool) -> Self {
        Self {
            inner: Arc::new((Mutex::new(open), Condvar::new())),
        }
    }

    pub fn open(&self) {
        *lock(&self.inner.0) = true;
        self.inner.1.notify_all();
    }

    fn close(&self) {
        *lock(&self.inner.0) = false;
    }

    fn pass(&self) {
        let mut open = lock(&self.inner.0);
        while !*open {
            open = self.inner.1.wait(open).unwrap();
        }
    }
}

impl FakeBackend {
    pub fn new(names: &[&str]) -> Self {
        Self {
            inner: Arc::new(FakeInner {
                root: std::env::temp_dir().join("repowatch-fake-root"),
                names: Mutex::new(names.iter().map(|name| name.to_string()).collect()),
                staged: Mutex::new(HashMap::new()),
                discover_calls: AtomicUsize::new(0),
                summarize_calls: Mutex::new(HashMap::new()),
                gate: Gate::new(true),
                discovering: (Mutex::new(0), Condvar::new()),
            }),
        }
    }

    pub fn root(&self) -> &Path {
        &self.inner.root
    }

    /// Closes the discovery gate and returns it.
    pub fn gate(&self) -> Gate {
        self.inner.gate.close();
        self.inner.gate.clone()
    }

    /// Waits until `count` discoveries have started.
    pub fn wait_until_discovering(&self, count: usize) {
        let (started, signal) = &self.inner.discovering;
        let mut started = lock(started);
        while *started < count {
            let (next, timeout) = signal
                .wait_timeout(started, Duration::from_secs(10))
                .unwrap();
            assert!(!timeout.timed_out(), "discovery did not start");
            started = next;
        }
    }

    pub fn discover_calls(&self) -> usize {
        self.inner.discover_calls.load(Ordering::SeqCst)
    }

    pub fn summarize_calls(&self, name: &str) -> usize {
        lock(&self.inner.summarize_calls)
            .get(name)
            .copied()
            .unwrap_or(0)
    }

    pub fn set_staged(&self, name: &str, count: u32) {
        lock(&self.inner.staged).insert(name.to_string(), count);
    }

    pub fn remove(&self, name: &str) {
        lock(&self.inner.names).retain(|known| known != name);
    }

    pub fn repo(&self, name: &str) -> DiscoveredRepo {
        let path = self.inner.root.join(name);
        DiscoveredRepo {
            git_dir: path.join(".git"),
            path,
            kind: RepoKind::Main,
        }
    }
}

impl ScanBackend for FakeBackend {
    fn discover(&self, _roots: &[PathBuf], _options: &DiscoveryOptions) -> Discovery {
        self.inner.discover_calls.fetch_add(1, Ordering::SeqCst);
        {
            let (started, signal) = &self.inner.discovering;
            *lock(started) += 1;
            signal.notify_all();
        }
        self.inner.gate.pass();
        Discovery {
            repos: lock(&self.inner.names)
                .iter()
                .map(|name| self.repo(name))
                .collect(),
            issues: Vec::new(),
        }
    }

    fn summarize(&self, repo: &DiscoveredRepo) -> RepoSummary {
        let name = repo
            .path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        *lock(&self.inner.summarize_calls)
            .entry(name.clone())
            .or_default() += 1;
        let staged = lock(&self.inner.staged).get(&name).copied().unwrap_or(0);
        clean_summary(repo, &name, staged)
    }
}

/// A summary of a clean repository on `main` tracking `origin/main`, with
/// `staged` staged files.
pub fn clean_summary(repo: &DiscoveredRepo, name: &str, staged: u32) -> RepoSummary {
    let mut summary = RepoSummary {
        path: repo.path.clone(),
        name: name.to_string(),
        kind: repo.kind.clone(),
        head: Some(Head::Branch {
            name: "main".into(),
        }),
        oid: Some("a".repeat(40)),
        upstream: Some(Upstream {
            name: "origin/main".into(),
            ahead: 0,
            behind: 0,
            gone: false,
        }),
        remotes: vec!["origin".into()],
        counts: ChangeCounts {
            staged,
            ..ChangeCounts::default()
        },
        stash_count: 0,
        last_commit: None,
        default_branch: None,
        branch_count: 1,
        unmerged_branches: Vec::new(),
        worktrees: Vec::new(),
        lost_commits: None,
        error: None,
        attention: Attention::from_reasons(Vec::new()),
    };
    summary.attention = Attention::from_reasons(summary.reasons());
    summary
}
