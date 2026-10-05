//! Optional background fetch: off by default; when the user enables it, a
//! read-only `git fetch --all` of each repository every interval. It only
//! updates remote-tracking refs (see [`repowatch_core::fetch`]); this module
//! has no way to push, pull or change a branch.
//!
//! Background fetches never prompt: git's terminal prompt is off for every
//! command, and Git Credential Manager is told not to open windows
//! (`GCM_INTERACTIVE=never`), so a repository that needs credentials just
//! fails quietly until the user fetches it by hand.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use repowatch_core::{Git, GitError, RepoKind};

use crate::scanner::{RepoMap, ScanSnapshot, lock};

/// Delay before the first fetch after start-up or after enabling, when the
/// interval is longer.
pub const FIRST_FETCH_DELAY: Duration = Duration::from_secs(120);

pub trait Fetcher: Send + Sync + 'static {
    fn fetch(&self, repo: &Path) -> Result<(), GitError>;
}

/// Fetches with the git CLI, never prompting for credentials.
pub struct GitFetcher(pub Git);

impl GitFetcher {
    pub fn new(git: Git) -> Self {
        Self(git.with_env("GCM_INTERACTIVE", "never"))
    }
}

impl Fetcher for GitFetcher {
    fn fetch(&self, repo: &Path) -> Result<(), GitError> {
        repowatch_core::fetch(&self.0, repo, None)
    }
}

/// One fetch: the working tree it runs in and every discovered working tree
/// of the same repository, which all see the new remote refs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchTarget {
    pub path: PathBuf,
    pub affected: Vec<String>,
}

/// Repositories with a remote, one fetch per shared git folder (a main
/// repository and its worktrees are fetched once, from the main one).
pub fn fetch_targets(repos: &RepoMap, snapshot: &ScanSnapshot) -> Vec<FetchTarget> {
    let mut groups: BTreeMap<String, (Option<PathBuf>, Vec<String>)> = BTreeMap::new();
    for summary in snapshot
        .repos
        .iter()
        .filter(|summary| !summary.remotes.is_empty())
    {
        let key = summary.path.to_string_lossy().into_owned();
        let Some(repo) = repos.get(&key) else {
            continue;
        };
        let (common, is_main) = match &repo.kind {
            RepoKind::Main => (repo.git_dir.clone(), true),
            RepoKind::LinkedWorktree { common_dir, .. } => (common_dir.clone(), false),
        };
        // Windows paths are case-insensitive; elsewhere case matters.
        let mut common = common
            .to_string_lossy()
            .replace('/', std::path::MAIN_SEPARATOR_STR);
        if cfg!(windows) {
            common = common.to_lowercase();
        }
        let group = groups.entry(common).or_default();
        if is_main || group.0.is_none() {
            group.0 = Some(repo.path.clone());
        }
        group.1.push(key);
    }
    groups
        .into_values()
        .filter_map(|(path, affected)| path.map(|path| FetchTarget { path, affected }))
        .collect()
}

pub enum FetchEvent {
    Started,
    /// A round finished; these repositories should be read again.
    Finished(Vec<String>),
}

pub struct BackgroundFetch {
    shared: Arc<Shared>,
}

struct Shared {
    state: Mutex<State>,
    changed: Condvar,
}

struct State {
    enabled: bool,
    interval: Duration,
    first_delay: Duration,
    stopped: bool,
}

impl BackgroundFetch {
    /// Starts the scheduler, disabled. `targets` is called at each round.
    pub fn start(
        fetcher: impl Fetcher,
        first_delay: Duration,
        targets: impl Fn() -> Vec<FetchTarget> + Send + 'static,
        events: impl Fn(FetchEvent) + Send + 'static,
    ) -> Self {
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                enabled: false,
                interval: Duration::from_secs(30 * 60),
                first_delay,
                stopped: false,
            }),
            changed: Condvar::new(),
        });
        let worker = Arc::clone(&shared);
        thread::Builder::new()
            .name("repowatch-background-fetch".into())
            .spawn(move || worker.run(&fetcher, &targets, &events))
            .expect("cannot start the background fetch thread");
        Self { shared }
    }

    pub fn configure(&self, enabled: bool, interval: Duration) {
        let mut state = lock(&self.shared.state);
        state.enabled = enabled;
        state.interval = interval;
        self.shared.changed.notify_all();
    }

    /// Whether fetching is enabled, and the interval.
    #[cfg(test)]
    pub fn config(&self) -> (bool, Duration) {
        let state = lock(&self.shared.state);
        (state.enabled, state.interval)
    }
}

impl Drop for BackgroundFetch {
    fn drop(&mut self) {
        lock(&self.shared.state).stopped = true;
        self.shared.changed.notify_all();
    }
}

impl Shared {
    fn run(
        &self,
        fetcher: &dyn Fetcher,
        targets: &dyn Fn() -> Vec<FetchTarget>,
        events: &dyn Fn(FetchEvent),
    ) {
        // Set when the scheduler was enabled or last fetched.
        let mut since: Option<Instant> = None;
        let mut fetched_once = false;
        loop {
            {
                let mut state = lock(&self.state);
                loop {
                    if state.stopped {
                        return;
                    }
                    if !state.enabled {
                        since = None;
                        fetched_once = false;
                        state = self.wait(state, None);
                        continue;
                    }
                    let start = *since.get_or_insert_with(Instant::now);
                    let delay = if fetched_once {
                        state.interval
                    } else {
                        state.interval.min(state.first_delay)
                    };
                    let left = delay.saturating_sub(start.elapsed());
                    if left.is_zero() {
                        break;
                    }
                    // Woken early by a settings change: recompute.
                    state = self.wait(state, Some(left));
                }
            }
            events(FetchEvent::Started);
            let mut affected = Vec::new();
            for target in targets() {
                if !self.enabled() {
                    break;
                }
                // A failure (offline, credentials needed) is retried next round.
                let _ = fetcher.fetch(&target.path);
                affected.extend(target.affected);
            }
            events(FetchEvent::Finished(affected));
            since = Some(Instant::now());
            fetched_once = true;
        }
    }

    fn enabled(&self) -> bool {
        let state = lock(&self.state);
        state.enabled && !state.stopped
    }

    fn wait<'a>(
        &self,
        state: std::sync::MutexGuard<'a, State>,
        timeout: Option<Duration>,
    ) -> std::sync::MutexGuard<'a, State> {
        match timeout {
            Some(timeout) => {
                self.changed
                    .wait_timeout(state, timeout)
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .0
            }
            None => self
                .changed
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{
        FakeBackend, clean_summary, git, isolated_git, repo_with_remote, temp_dir,
    };
    use repowatch_core::{DiscoveredRepo, read_status};
    use std::sync::mpsc;

    struct CountingFetcher(mpsc::Sender<PathBuf>);

    impl Fetcher for CountingFetcher {
        fn fetch(&self, repo: &Path) -> Result<(), GitError> {
            let _ = self.0.send(repo.to_path_buf());
            Ok(())
        }
    }

    fn scheduler(
        targets: Vec<PathBuf>,
    ) -> (
        BackgroundFetch,
        mpsc::Receiver<PathBuf>,
        mpsc::Receiver<Vec<String>>,
    ) {
        let (fetched, fetches) = mpsc::channel();
        let (done, rounds) = mpsc::channel();
        let done = Mutex::new(done);
        let background = BackgroundFetch::start(
            CountingFetcher(fetched),
            Duration::from_millis(20),
            move || {
                targets
                    .iter()
                    .map(|path| FetchTarget {
                        path: path.clone(),
                        affected: vec![path.to_string_lossy().into_owned()],
                    })
                    .collect()
            },
            move |event| {
                if let FetchEvent::Finished(affected) = event {
                    let _ = lock(&done).send(affected);
                }
            },
        );
        (background, fetches, rounds)
    }

    #[test]
    fn nothing_is_fetched_while_disabled() {
        let (_background, fetches, _rounds) = scheduler(vec![PathBuf::from("a")]);
        assert!(fetches.recv_timeout(Duration::from_millis(300)).is_err());
    }

    #[test]
    fn enabling_fetches_each_round_and_disabling_stops() {
        let (background, fetches, rounds) = scheduler(vec![PathBuf::from("a"), PathBuf::from("b")]);
        background.configure(true, Duration::from_millis(50));
        let first = rounds.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(first, vec!["a".to_string(), "b".to_string()]);
        rounds
            .recv_timeout(Duration::from_secs(5))
            .expect("a second round");

        background.configure(false, Duration::from_millis(50));
        thread::sleep(Duration::from_millis(100));
        while fetches.try_recv().is_ok() {}
        assert!(fetches.recv_timeout(Duration::from_millis(300)).is_err());
    }

    #[test]
    fn targets_fetch_each_repository_with_a_remote_once() {
        let backend = FakeBackend::new(&[]);
        let main = backend.repo("main");
        let local_only = backend.repo("local");
        let worktree = DiscoveredRepo {
            path: backend.root().join("main-wt"),
            git_dir: main.git_dir.join("worktrees/main-wt"),
            kind: RepoKind::LinkedWorktree {
                common_dir: main.git_dir.clone(),
                main_path: Some(main.path.clone()),
            },
        };
        let mut no_remote = clean_summary(&local_only, "local", 0);
        no_remote.remotes.clear();
        let snapshot = ScanSnapshot {
            generation: 1,
            scanned_at: 0,
            duration_ms: 0,
            roots: vec![],
            repos: vec![
                clean_summary(&worktree, "main-wt", 0),
                clean_summary(&main, "main", 0),
                no_remote,
            ],
            issues: vec![],
            attention_count: 0,
        };
        let repos: RepoMap = [main.clone(), local_only, worktree.clone()]
            .into_iter()
            .map(|repo| (repo.path.to_string_lossy().into_owned(), repo))
            .collect();
        let targets = fetch_targets(&repos, &snapshot);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].path, main.path, "fetched from the main tree");
        let mut affected = targets[0].affected.clone();
        affected.sort();
        assert_eq!(
            affected,
            vec![
                main.path.to_string_lossy().into_owned(),
                worktree.path.to_string_lossy().into_owned()
            ]
        );
    }

    #[test]
    fn a_background_fetch_never_pushes_or_moves_local_branches() {
        let dir = temp_dir("background-fetch");
        let (clone, remote) = repo_with_remote(&dir);
        // A local commit that is not pushed.
        std::fs::write(clone.join("local.txt"), "local\n").unwrap();
        git(&clone, &["add", "local.txt"]);
        git(&clone, &["commit", "--quiet", "-m", "local only"]);
        let local_head = git(&clone, &["rev-parse", "HEAD"]);
        // Someone else pushes a commit to the remote.
        let other = dir.join("other");
        git(&dir, &["clone", "--quiet", "remote.git", "other"]);
        std::fs::write(other.join("other.txt"), "other\n").unwrap();
        git(&other, &["add", "other.txt"]);
        git(&other, &["commit", "--quiet", "-m", "other"]);
        git(&other, &["push", "--quiet"]);
        let remote_head = git(&remote, &["rev-parse", "main"]);

        GitFetcher::new(isolated_git()).fetch(&clone).unwrap();

        assert_eq!(
            git(&remote, &["rev-parse", "main"]),
            remote_head,
            "nothing pushed"
        );
        assert_eq!(
            git(&clone, &["rev-parse", "HEAD"]),
            local_head,
            "branch not moved"
        );
        let upstream = read_status(&isolated_git(), &clone)
            .unwrap()
            .report
            .upstream
            .unwrap();
        assert_eq!((upstream.ahead, upstream.behind), (1, 1));
    }
}
