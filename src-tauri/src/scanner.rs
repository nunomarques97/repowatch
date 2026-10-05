//! Scans: discovery plus one summary per repository, run by one worker
//! thread so reads of a repository never overlap.
//!
//! - A full scan request made while a scan runs is served by one follow-up
//!   scan, however many requests arrive: overlapping requests coalesce, and
//!   every caller gets a result that started after its request.
//! - A refresh re-reads only the named repositories (after a file change or
//!   an action); it never adds or removes repositories.
//! - A summary never fails (see [`repowatch_core::summarize`]), so one broken
//!   repository shows as an error row and never fails the scan.
//! - Every change produces a snapshot with a higher `generation`; listeners
//!   receive snapshots in increasing generation order.
//! - The repositories of the last full scan are the only paths commands may
//!   act on ([`Scanner::resolve`]).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use repowatch_core::{
    DiscoveredRepo, Discovery, DiscoveryIssue, DiscoveryOptions, Git, RepoKind, RepoSummary,
};
use serde::Serialize;

use crate::error::CommandError;

/// Most repositories summarized at the same time.
const MAX_SCAN_THREADS: usize = 8;
/// Longest caller-supplied path echoed back in an error.
const MAX_ECHOED_PATH_CHARS: usize = 300;

/// Reads repositories; replaced by a fake in tests.
pub trait ScanBackend: Send + Sync + 'static {
    fn discover(&self, roots: &[PathBuf], options: &DiscoveryOptions) -> Discovery;
    fn summarize(&self, repo: &DiscoveredRepo) -> RepoSummary;
}

/// The real backend: the core crate over the git CLI.
pub struct GitBackend(pub Git);

impl ScanBackend for GitBackend {
    fn discover(&self, roots: &[PathBuf], options: &DiscoveryOptions) -> Discovery {
        repowatch_core::discover(roots, options)
    }

    fn summarize(&self, repo: &DiscoveredRepo) -> RepoSummary {
        repowatch_core::summarize(&self.0, repo)
    }
}

/// What a full scan searches.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScanConfig {
    pub roots: Vec<PathBuf>,
    pub excluded: Vec<PathBuf>,
}

/// The dashboard's data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSnapshot {
    /// Increases with every change; a client keeps the highest it has seen.
    pub generation: u64,
    /// When the last full scan finished, in milliseconds since the Unix epoch.
    pub scanned_at: u64,
    /// Duration of the last full scan.
    pub duration_ms: u64,
    pub roots: Vec<String>,
    /// In attention order (most severe first, then name).
    pub repos: Vec<RepoSummary>,
    /// Folders that could not be searched or repositories that were skipped.
    pub issues: Vec<DiscoveryIssue>,
    /// Repositories that need attention: the tray badge.
    pub attention_count: u32,
}

/// Repositories of the last full scan, by path.
pub type RepoMap = BTreeMap<String, DiscoveredRepo>;

pub enum ScanEvent {
    /// A full scan started.
    Started,
    /// A full scan finished: a new repository set.
    Finished(Arc<ScanSnapshot>, Arc<RepoMap>),
    /// Some repositories were read again.
    Updated(Arc<ScanSnapshot>),
}

type Listener = Box<dyn Fn(ScanEvent) + Send + Sync>;

pub struct Scanner {
    shared: Arc<Shared>,
}

struct Shared {
    backend: Box<dyn ScanBackend>,
    state: Mutex<State>,
    /// Signals the worker that there is work.
    work: Condvar,
    /// Signals waiters that a full scan finished.
    done: Condvar,
    listener: Listener,
    /// Held from installing a snapshot until the listener has it, so the
    /// listener sees every snapshot, in generation order.
    announcing: Mutex<()>,
}

#[derive(Default)]
struct State {
    config: ScanConfig,
    /// Full scans requested and completed, as sequence numbers.
    requested: u64,
    completed: u64,
    refresh: BTreeSet<String>,
    generation: u64,
    snapshot: Option<Arc<ScanSnapshot>>,
    repos: Arc<RepoMap>,
    stopped: bool,
}

enum Job {
    Full { target: u64, config: ScanConfig },
    Refresh(Vec<DiscoveredRepo>),
}

impl Scanner {
    /// Starts the worker thread. Nothing is scanned until a request.
    pub fn start(
        backend: impl ScanBackend,
        listener: impl Fn(ScanEvent) + Send + Sync + 'static,
    ) -> Self {
        let shared = Arc::new(Shared {
            backend: Box::new(backend),
            state: Mutex::new(State::default()),
            work: Condvar::new(),
            done: Condvar::new(),
            listener: Box::new(listener),
            announcing: Mutex::new(()),
        });
        let worker = Arc::clone(&shared);
        thread::Builder::new()
            .name("repowatch-scanner".into())
            .spawn(move || worker.run())
            .expect("cannot start the scanner thread");
        Self { shared }
    }

    /// Sets what the next full scan searches.
    pub fn configure(&self, config: ScanConfig) {
        lock(&self.shared.state).config = config;
    }

    /// Requests a full scan and returns its ticket for [`Scanner::wait`].
    pub fn request_scan(&self) -> u64 {
        let mut state = lock(&self.shared.state);
        state.requested += 1;
        self.shared.work.notify_all();
        state.requested
    }

    /// Waits until a full scan that started after `ticket` was requested has
    /// finished, and returns the current snapshot.
    pub fn wait(&self, ticket: u64) -> Result<Arc<ScanSnapshot>, CommandError> {
        let mut state = lock(&self.shared.state);
        while state.completed < ticket && !state.stopped {
            state = self
                .shared
                .done
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        state.snapshot.clone().ok_or(CommandError::NotScanned)
    }

    /// Requests a full scan and waits for it.
    pub fn scan(&self) -> Result<Arc<ScanSnapshot>, CommandError> {
        let ticket = self.request_scan();
        self.wait(ticket)
    }

    /// Re-reads these repositories soon; unknown paths are ignored.
    pub fn request_refresh<I, S>(&self, paths: I)
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let mut state = lock(&self.shared.state);
        let before = state.refresh.len();
        state.refresh.extend(paths.into_iter().map(Into::into));
        if state.refresh.len() != before {
            self.shared.work.notify_all();
        }
    }

    pub fn snapshot(&self) -> Option<Arc<ScanSnapshot>> {
        lock(&self.shared.state).snapshot.clone()
    }

    pub fn repos(&self) -> Arc<RepoMap> {
        Arc::clone(&lock(&self.shared.state).repos)
    }

    pub fn is_scanning(&self) -> bool {
        let state = lock(&self.shared.state);
        state.requested > state.completed
    }

    /// The discovered repository at exactly `path`, as the last full scan
    /// reported it. Any other path (a sub-folder, a different spelling, a
    /// repository outside the roots, one removed by a later scan) is refused.
    pub fn resolve(&self, path: &str) -> Result<DiscoveredRepo, CommandError> {
        lock(&self.shared.state)
            .repos
            .get(path)
            .cloned()
            .ok_or_else(|| CommandError::UnknownRepo {
                path: path.chars().take(MAX_ECHOED_PATH_CHARS).collect(),
            })
    }

    /// Records an on-demand lost-commit count in the repository's summary.
    pub fn record_lost_commits(&self, path: &str, count: u32) {
        self.shared.publish(|state| {
            let current = state.snapshot.clone()?;
            let mut next = (*current).clone();
            let summary = next
                .repos
                .iter_mut()
                .find(|repo| repo_key(&repo.path) == path)?;
            if summary.lost_commits == Some(count) {
                return None;
            }
            summary.set_lost_commits(count);
            Some(ScanEvent::Updated(state.install(next)))
        });
    }
}

impl Drop for Scanner {
    fn drop(&mut self) {
        lock(&self.shared.state).stopped = true;
        self.shared.work.notify_all();
        self.shared.done.notify_all();
    }
}

impl State {
    /// Installs `next` as the current snapshot with a new generation.
    fn install(&mut self, mut next: ScanSnapshot) -> Arc<ScanSnapshot> {
        repowatch_core::sort_by_attention(&mut next.repos);
        next.attention_count =
            u32::try_from(repowatch_core::needs_attention_count(&next.repos)).unwrap_or(u32::MAX);
        self.generation += 1;
        next.generation = self.generation;
        let next = Arc::new(next);
        self.snapshot = Some(Arc::clone(&next));
        next
    }

    /// Lost-commit counts are found on demand; a re-read keeps the last one.
    fn keep_lost_count(&self, summary: &mut RepoSummary) {
        let previous = self.snapshot.as_ref().and_then(|snapshot| {
            snapshot
                .repos
                .iter()
                .find(|repo| repo.path == summary.path)
                .and_then(|repo| repo.lost_commits)
        });
        if let Some(count) = previous {
            summary.set_lost_commits(count);
        }
    }
}

/// Marks the scanner stopped when its worker ends, also by a panic, so
/// [`Scanner::wait`] never waits for a worker that is gone.
struct StopOnExit<'a>(&'a Shared);

impl Drop for StopOnExit<'_> {
    fn drop(&mut self) {
        lock(&self.0.state).stopped = true;
        self.0.done.notify_all();
    }
}

impl Shared {
    fn run(&self) {
        let _stop = StopOnExit(self);
        while let Some(job) = self.next_job() {
            match job {
                Job::Full { target, config } => self.full_scan(target, &config),
                Job::Refresh(repos) => self.refresh(&repos),
            }
        }
    }

    fn next_job(&self) -> Option<Job> {
        let mut state = lock(&self.state);
        loop {
            if state.stopped {
                return None;
            }
            if state.requested > state.completed {
                // The full scan reads every repository, so earlier refresh
                // requests are covered.
                state.refresh.clear();
                return Some(Job::Full {
                    target: state.requested,
                    config: state.config.clone(),
                });
            }
            if !state.refresh.is_empty() {
                let keys = std::mem::take(&mut state.refresh);
                let repos: Vec<DiscoveredRepo> = keys
                    .iter()
                    .filter_map(|key| state.repos.get(key).cloned())
                    .collect();
                if !repos.is_empty() {
                    return Some(Job::Refresh(repos));
                }
                continue;
            }
            state = self
                .work
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    fn full_scan(&self, target: u64, config: &ScanConfig) {
        (self.listener)(ScanEvent::Started);
        let started = Instant::now();
        let options = DiscoveryOptions {
            excluded: config.excluded.clone(),
            ..DiscoveryOptions::default()
        };
        let discovery = self.backend.discover(&config.roots, &options);
        let (repos, issues) = accepted_repos(discovery);
        let list: Vec<DiscoveredRepo> = repos.values().cloned().collect();
        let mut summaries = summarize_all(self.backend.as_ref(), &list);
        let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

        self.publish(|state| {
            for summary in &mut summaries {
                state.keep_lost_count(summary);
            }
            let snapshot = state.install(ScanSnapshot {
                generation: 0,
                scanned_at: now_ms(),
                duration_ms,
                roots: config
                    .roots
                    .iter()
                    .map(|root| root.to_string_lossy().into_owned())
                    .collect(),
                repos: summaries,
                issues,
                attention_count: 0,
            });
            state.repos = Arc::new(repos);
            state.completed = state.completed.max(target);
            self.done.notify_all();
            Some(ScanEvent::Finished(snapshot, Arc::clone(&state.repos)))
        });
    }

    fn refresh(&self, repos: &[DiscoveredRepo]) {
        let summaries = summarize_all(self.backend.as_ref(), repos);
        self.publish(|state| {
            let current = state.snapshot.clone()?;
            let mut next = (*current).clone();
            for mut summary in summaries {
                state.keep_lost_count(&mut summary);
                if let Some(slot) = next.repos.iter_mut().find(|repo| repo.path == summary.path) {
                    *slot = summary;
                }
            }
            Some(ScanEvent::Updated(state.install(next)))
        });
    }

    /// Applies `change` to the state and gives its event to the listener.
    /// Lock order: `announcing`, then `state`; the state is unlocked before
    /// the listener runs, so it may call the scanner.
    fn publish(&self, change: impl FnOnce(&mut State) -> Option<ScanEvent>) {
        let _order = lock(&self.announcing);
        let event = change(&mut lock(&self.state));
        if let Some(event) = event {
            (self.listener)(event);
        }
    }
}

/// Repositories whose path is valid Unicode, keyed by path. Others cannot be
/// named by the frontend, so they are reported as issues instead.
fn accepted_repos(discovery: Discovery) -> (RepoMap, Vec<DiscoveryIssue>) {
    let mut issues: Vec<DiscoveryIssue> = discovery
        .issues
        .into_iter()
        .map(|issue| DiscoveryIssue {
            path: lossy(&issue.path),
            message: issue.message,
        })
        .collect();
    let mut repos = RepoMap::new();
    for mut repo in discovery.repos {
        match repo.path.to_str().map(str::to_string) {
            Some(key) => {
                repo.git_dir = lossy(&repo.git_dir);
                if let RepoKind::LinkedWorktree {
                    common_dir,
                    main_path,
                } = &mut repo.kind
                {
                    *common_dir = lossy(common_dir);
                    *main_path = main_path.as_deref().map(lossy);
                }
                repos.insert(key, repo);
            }
            None => issues.push(DiscoveryIssue {
                path: lossy(&repo.path),
                message: "skipped: the path is not valid Unicode".into(),
            }),
        }
    }
    (repos, issues)
}

/// Summaries of `repos` in their order, read in parallel. Paths inside a
/// summary are made valid Unicode so it always serializes.
fn summarize_all(backend: &dyn ScanBackend, repos: &[DiscoveredRepo]) -> Vec<RepoSummary> {
    let workers = thread::available_parallelism()
        .map_or(4, |count| count.get())
        .clamp(1, MAX_SCAN_THREADS)
        .min(repos.len());
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<Option<RepoSummary>>> = Mutex::new(vec![None; repos.len()]);
    thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(repo) = repos.get(index) else { break };
                    let mut summary = backend.summarize(repo);
                    for worktree in &mut summary.worktrees {
                        worktree.path = lossy(&worktree.path);
                    }
                    summary.kind = repo.kind.clone();
                    lock(&results)[index] = Some(summary);
                }
            });
        }
    });
    results
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .into_iter()
        .flatten()
        .collect()
}

/// The key of a repository path, as the frontend sends it back.
pub fn repo_key(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn lossy(path: &Path) -> PathBuf {
    match path.to_str() {
        Some(_) => path.to_path_buf(),
        None => PathBuf::from(path.to_string_lossy().into_owned()),
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

/// Locks a mutex, recovering the data if a thread panicked while holding it.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{FakeBackend, commit_repo, git_backend, temp_dir};
    use repowatch_core::AttentionLevel;
    use std::sync::mpsc;
    use std::time::Duration;

    fn collecting() -> (
        impl Fn(ScanEvent) + Send + Sync,
        mpsc::Receiver<(String, u64)>,
    ) {
        let (sender, receiver) = mpsc::channel();
        let sender = Mutex::new(sender);
        let listener = move |event: ScanEvent| {
            let entry = match event {
                ScanEvent::Started => ("started".to_string(), 0),
                ScanEvent::Finished(snapshot, _) => ("finished".to_string(), snapshot.generation),
                ScanEvent::Updated(snapshot) => ("updated".to_string(), snapshot.generation),
            };
            let _ = lock(&sender).send(entry);
        };
        (listener, receiver)
    }

    #[test]
    fn overlapping_scan_requests_coalesce_into_one_follow_up_scan() {
        let backend = FakeBackend::new(&["a", "b"]);
        let gate = backend.gate();
        let (listener, _events) = collecting();
        let scanner = Arc::new(Scanner::start(backend.clone(), listener));

        let first = scanner.request_scan();
        backend.wait_until_discovering(1);
        // Five callers ask while the first scan is blocked in discovery.
        let callers: Vec<_> = (0..5)
            .map(|_| {
                let scanner = Arc::clone(&scanner);
                let ticket = scanner.request_scan();
                thread::spawn(move || scanner.wait(ticket).unwrap().generation)
            })
            .collect();
        gate.open();
        let first = scanner.wait(first).unwrap();
        let generations: Vec<u64> = callers.into_iter().map(|c| c.join().unwrap()).collect();

        assert_eq!(backend.discover_calls(), 2, "one scan plus one follow-up");
        assert_eq!(first.generation, 1);
        // Every caller that asked during the first scan got the second one.
        assert!(generations.iter().all(|generation| *generation >= 2));
        assert_eq!(scanner.snapshot().unwrap().repos.len(), 2);
    }

    /// Discovers like [`FakeBackend`] but panics while reading a repository.
    struct PanickingBackend(FakeBackend);

    impl ScanBackend for PanickingBackend {
        fn discover(&self, roots: &[PathBuf], options: &DiscoveryOptions) -> Discovery {
            self.0.discover(roots, options)
        }

        fn summarize(&self, _repo: &DiscoveredRepo) -> RepoSummary {
            panic!("summary failed");
        }
    }

    #[test]
    fn a_panicking_worker_does_not_leave_scan_callers_waiting() {
        let (listener, _events) = collecting();
        let scanner = Arc::new(Scanner::start(
            PanickingBackend(FakeBackend::new(&["a"])),
            listener,
        ));
        // Each call returns instead of waiting for a worker that is gone.
        let (done, finished) = mpsc::channel();
        let caller = Arc::clone(&scanner);
        thread::spawn(move || {
            let results = [caller.scan(), caller.scan()];
            let _ = done.send(results);
        });
        let results = finished
            .recv_timeout(Duration::from_secs(10))
            .expect("scan callers must not block after the worker panicked");
        for result in results {
            assert_eq!(result.unwrap_err(), CommandError::NotScanned);
        }
    }

    #[test]
    fn a_failing_repository_does_not_fail_the_scan() {
        let root = temp_dir("scan-failure");
        let good = root.join("good");
        let broken = root.join("broken");
        commit_repo(&good);
        commit_repo(&broken);
        // A config git cannot parse makes every git command in it fail.
        std::fs::write(broken.join(".git/config"), "[core\nbroken").unwrap();

        let (listener, _events) = collecting();
        let scanner = Scanner::start(git_backend(), listener);
        scanner.configure(ScanConfig {
            roots: vec![root.clone()],
            excluded: vec![],
        });
        let snapshot = scanner.scan().unwrap();
        assert_eq!(snapshot.repos.len(), 2);
        let by_name = |name: &str| snapshot.repos.iter().find(|r| r.name == name).unwrap();
        assert!(by_name("broken").error.is_some());
        assert_eq!(by_name("broken").attention.level, AttentionLevel::Risk);
        assert!(by_name("good").error.is_none());
        // The broken repository is sorted first: it needs attention most.
        assert_eq!(snapshot.repos[0].name, "broken");
    }

    #[test]
    fn refresh_reads_only_known_repositories_and_raises_the_generation() {
        let backend = FakeBackend::new(&["a", "b"]);
        let (listener, events) = collecting();
        let scanner = Scanner::start(backend.clone(), listener);
        let first = scanner.scan().unwrap();
        let a = first
            .repos
            .iter()
            .find(|r| r.name == "a")
            .unwrap()
            .path
            .clone();
        backend.set_staged("a", 3);

        scanner.request_refresh([repo_key(&a), "C:\\not\\discovered".to_string()]);
        let updated = wait_for(&events, "updated");
        let snapshot = scanner.snapshot().unwrap();
        assert_eq!(snapshot.generation, updated);
        assert!(updated > first.generation);
        assert_eq!(snapshot.repos[0].name, "a", "a needs attention now");
        assert_eq!(snapshot.repos[0].counts.staged, 3);
        assert_eq!(snapshot.attention_count, 1);
        assert_eq!(backend.summarize_calls("b"), 1, "b was not read again");
        assert_eq!(backend.discover_calls(), 1, "a refresh is not a scan");
    }

    #[test]
    fn listeners_see_every_generation_in_order() {
        let backend = FakeBackend::new(&["a"]);
        let (listener, events) = collecting();
        let scanner = Arc::new(Scanner::start(backend, listener));
        let snapshot = scanner.scan().unwrap();
        let key = repo_key(&snapshot.repos[0].path);
        let threads: Vec<_> = (0..4)
            .map(|i| {
                let scanner = Arc::clone(&scanner);
                let key = key.clone();
                thread::spawn(move || {
                    scanner.request_refresh([key.clone()]);
                    scanner.record_lost_commits(&key, i + 1);
                    scanner.scan().unwrap();
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let generations: Vec<u64> = events
            .try_iter()
            .filter(|(kind, _)| kind != "started")
            .map(|(_, generation)| generation)
            .collect();
        // None skipped (a full scan's event must reach the watcher), none
        // out of order.
        let expected: Vec<u64> = (1..=generations.len() as u64).collect();
        assert_eq!(generations, expected);
        assert!(generations.len() >= 5, "{generations:?}");
    }

    #[test]
    fn lost_commit_counts_survive_a_refresh_and_a_rescan() {
        let backend = FakeBackend::new(&["a"]);
        let (listener, events) = collecting();
        let scanner = Scanner::start(backend, listener);
        let key = repo_key(&scanner.scan().unwrap().repos[0].path);
        scanner.record_lost_commits(&key, 2);
        let summary = &scanner.snapshot().unwrap().repos[0];
        assert_eq!(summary.lost_commits, Some(2));
        assert_eq!(summary.attention.level, AttentionLevel::Risk);

        scanner.request_refresh([key.clone()]);
        wait_for(&events, "updated");
        assert_eq!(scanner.scan().unwrap().repos[0].lost_commits, Some(2));
    }

    #[test]
    fn only_paths_of_the_last_scan_resolve() {
        let backend = FakeBackend::new(&["a", "b"]);
        let (listener, _events) = collecting();
        let scanner = Scanner::start(backend.clone(), listener);
        assert!(matches!(
            scanner.resolve("anything"),
            Err(CommandError::UnknownRepo { .. })
        ));
        let snapshot = scanner.scan().unwrap();
        let a = repo_key(&snapshot.repos.iter().find(|r| r.name == "a").unwrap().path);
        assert_eq!(scanner.resolve(&a).unwrap().path, PathBuf::from(&a));

        let refused = [
            String::new(),
            format!("{a}\\sub"),
            format!("{a}/sub"),
            format!("{a}\\..\\b\\..\\a"),
            format!("{a}\\"),
            a.to_uppercase(),
            format!(" {a}"),
            backend.root().to_string_lossy().into_owned(),
            "\\\\server\\share\\repo".into(),
            "x".repeat(10_000),
        ];
        for path in &refused {
            match scanner.resolve(path) {
                Err(CommandError::UnknownRepo { path: echoed }) => {
                    assert!(echoed.chars().count() <= MAX_ECHOED_PATH_CHARS)
                }
                other => panic!("{path:.60} resolved: {other:?}"),
            }
        }

        // A repository removed from the scan is no longer accepted.
        backend.remove("a");
        scanner.scan().unwrap();
        assert!(scanner.resolve(&a).is_err());
    }

    #[test]
    fn dropping_the_scanner_releases_waiters() {
        let backend = FakeBackend::new(&["a"]);
        let gate = backend.gate();
        let (listener, _events) = collecting();
        let scanner = Scanner::start(backend.clone(), listener);
        let ticket = scanner.request_scan();
        backend.wait_until_discovering(1);
        // A second handle on the same worker waits for a scan that is never
        // requested; only stopping can release it.
        let shared = Arc::clone(&scanner.shared);
        let waiter = thread::spawn(move || Scanner { shared }.wait(ticket + 10).map(|_| ()));
        thread::sleep(Duration::from_millis(50));
        drop(scanner);
        gate.open();
        let _ = waiter.join().expect("the waiter returned");
    }

    fn wait_for(events: &mpsc::Receiver<(String, u64)>, kind: &str) -> u64 {
        loop {
            let (event, generation) = events
                .recv_timeout(Duration::from_secs(10))
                .expect("no scanner event");
            if event == kind {
                return generation;
            }
        }
    }
}
