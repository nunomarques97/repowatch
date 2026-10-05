//! The app's state and the work behind every command, kept free of Tauri
//! types so it can be tested directly.
//!
//! Every repository command first resolves its `repo` argument with
//! [`Scanner::resolve`]: only a path reported by the last scan is accepted.
//! Write actions on one working tree do not overlap (a second one gets
//! [`CommandError::Busy`]), and after each action, failed or not, the
//! repository and its other worktrees are read again.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use repowatch_core::{
    BranchReport, DiffSide, DiscoveredRepo, FileDiff, Git, GitError, LostCommitOptions,
    LostCommits, RepoKind, RepoStatus, Stash, Worktree,
};
use serde::Serialize;

use crate::background::BackgroundFetch;
use crate::error::CommandError;
use crate::open::{self, OpenTarget};
use crate::scanner::{ScanConfig, ScanSnapshot, Scanner, lock, now_ms};
use crate::settings::{Settings, SettingsStore};

/// Everything the detail view shows, read fresh.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDetail {
    pub path: PathBuf,
    pub name: String,
    pub kind: RepoKind,
    pub status: RepoStatus,
    pub branches: BranchReport,
    pub stashes: Vec<Stash>,
    pub worktrees: Vec<Worktree>,
}

/// Background activity shown in the status bar.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub scanning: bool,
    /// Working trees watched for changes.
    pub watched_repos: u32,
    pub background_fetch_running: bool,
    /// Milliseconds since the Unix epoch.
    pub last_background_fetch_at: Option<u64>,
}

/// The current [`AppStatus`], announcing each change.
pub struct StatusBoard {
    status: Mutex<AppStatus>,
    announce: Box<dyn Fn(&AppStatus) + Send + Sync>,
}

impl StatusBoard {
    pub fn new(announce: impl Fn(&AppStatus) + Send + Sync + 'static) -> Self {
        Self {
            status: Mutex::new(AppStatus::default()),
            announce: Box::new(announce),
        }
    }

    pub fn get(&self) -> AppStatus {
        lock(&self.status).clone()
    }

    pub fn update(&self, change: impl FnOnce(&mut AppStatus)) {
        let mut status = lock(&self.status);
        let before = status.clone();
        change(&mut status);
        if *status != before {
            (self.announce)(&status);
        }
    }

    pub fn background_fetch_finished(&self) {
        self.update(|status| {
            status.background_fetch_running = false;
            status.last_background_fetch_at = Some(now_ms());
        });
    }
}

pub struct AppState {
    git: Git,
    store: SettingsStore,
    settings: Mutex<Settings>,
    scanner: Arc<Scanner>,
    background: Option<BackgroundFetch>,
    status: Arc<StatusBoard>,
    /// Announces saved settings; called with the settings lock held so
    /// announcements arrive in the order the settings were saved.
    announce: Box<dyn Fn(&Settings) + Send + Sync>,
    busy: Mutex<HashSet<String>>,
}

/// Marks a working tree busy until dropped.
struct BusyGuard<'a> {
    busy: &'a Mutex<HashSet<String>>,
    key: String,
}

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        lock(self.busy).remove(&self.key);
    }
}

impl AppState {
    pub fn new(
        git: Git,
        store: SettingsStore,
        settings: Settings,
        scanner: Arc<Scanner>,
        background: Option<BackgroundFetch>,
        status: Arc<StatusBoard>,
        announce: impl Fn(&Settings) + Send + Sync + 'static,
    ) -> Self {
        let state = Self {
            git,
            store,
            settings: Mutex::new(settings.clone()),
            scanner,
            background,
            status,
            announce: Box::new(announce),
            busy: Mutex::new(HashSet::new()),
        };
        state.apply(&settings);
        state
    }

    pub fn scanner(&self) -> &Arc<Scanner> {
        &self.scanner
    }

    pub fn settings(&self) -> Settings {
        lock(&self.settings).clone()
    }

    pub fn config_dir(&self) -> PathBuf {
        self.store.dir().to_path_buf()
    }

    pub fn status(&self) -> AppStatus {
        self.status.get()
    }

    /// Validates, saves, applies and announces new settings. Changed roots or
    /// exclusions start a scan.
    ///
    /// Everything happens under the settings lock, so overlapping updates
    /// are applied and announced in the order they were saved: the scanner,
    /// the background fetch and the last announcement always match the
    /// saved settings.
    pub fn update_settings(&self, next: Settings) -> Result<Settings, CommandError> {
        let next = next.validated()?;
        let mut current = lock(&self.settings);
        self.store.save(&next)?;
        let rescan = current.roots != next.roots || current.excluded != next.excluded;
        *current = next.clone();
        self.apply(&next);
        (self.announce)(&next);
        if rescan {
            self.scanner.request_scan();
        }
        Ok(next)
    }

    /// Announces the current settings (at start-up).
    pub fn announce_settings(&self) {
        let current = lock(&self.settings);
        (self.announce)(&current);
    }

    fn apply(&self, settings: &Settings) {
        self.scanner.configure(ScanConfig {
            roots: settings.root_paths(),
            excluded: settings.excluded_paths(),
        });
        if let Some(background) = &self.background {
            background.configure(
                settings.background_fetch.enabled,
                Duration::from_secs(u64::from(settings.background_fetch.interval_minutes) * 60),
            );
        }
    }

    pub fn scan(&self) -> Result<Arc<ScanSnapshot>, CommandError> {
        self.scanner.scan()
    }

    pub fn snapshot(&self) -> Option<Arc<ScanSnapshot>> {
        self.scanner.snapshot()
    }

    fn repo(&self, path: &str) -> Result<DiscoveredRepo, CommandError> {
        self.scanner.resolve(path)
    }

    pub fn repo_detail(&self, path: &str) -> Result<RepoDetail, CommandError> {
        let repo = self.repo(path)?;
        let status = repowatch_core::read_status(&self.git, &repo.path)?;
        let branches = repowatch_core::read_branches(&self.git, &repo.path)?;
        let stashes = repowatch_core::list_stashes(&self.git, &repo.path)?;
        let worktrees = repowatch_core::list_worktrees(&self.git, &repo.path)?;
        Ok(RepoDetail {
            name: repo
                .path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.to_string()),
            path: repo.path,
            kind: repo.kind,
            status,
            branches,
            stashes,
            worktrees,
        })
    }

    pub fn file_diff(
        &self,
        path: &str,
        file: &str,
        side: DiffSide,
    ) -> Result<FileDiff, CommandError> {
        let repo = self.repo(path)?;
        Ok(repowatch_core::read_file_diff(
            &self.git, &repo.path, file, side,
        )?)
    }

    /// Finds the lost commits in the configured window and records their
    /// count in the dashboard.
    pub fn lost_commits(&self, path: &str) -> Result<LostCommits, CommandError> {
        let repo = self.repo(path)?;
        let options = LostCommitOptions {
            window_days: self.settings().lost_commit_window_days,
            ..LostCommitOptions::default()
        };
        let lost = repowatch_core::find_lost_commits(&self.git, &repo.path, &options)?;
        self.scanner
            .record_lost_commits(path, u32::try_from(lost.commits.len()).unwrap_or(u32::MAX));
        Ok(lost)
    }

    /// Runs a write action on a discovered repository, one at a time per
    /// working tree, then reads it again.
    pub fn act(
        &self,
        path: &str,
        action: impl FnOnce(&Git, &std::path::Path) -> Result<(), GitError>,
    ) -> Result<(), CommandError> {
        let repo = self.repo(path)?;
        let _guard = self.claim(path)?;
        let result = action(&self.git, &repo.path);
        self.scanner.request_refresh(self.related(&repo));
        Ok(result?)
    }

    fn claim(&self, path: &str) -> Result<BusyGuard<'_>, CommandError> {
        if !lock(&self.busy).insert(path.to_string()) {
            return Err(CommandError::Busy {
                path: path.to_string(),
            });
        }
        Ok(BusyGuard {
            busy: &self.busy,
            key: path.to_string(),
        })
    }

    /// Discovered working trees that share `repo`'s git folder.
    fn related(&self, repo: &DiscoveredRepo) -> Vec<String> {
        let common = |candidate: &DiscoveredRepo| match &candidate.kind {
            RepoKind::Main => candidate.git_dir.clone(),
            RepoKind::LinkedWorktree { common_dir, .. } => common_dir.clone(),
        };
        let own = common(repo);
        self.scanner
            .repos()
            .iter()
            .filter(|(_, candidate)| common(candidate) == own || candidate.path == repo.path)
            .map(|(key, _)| key.clone())
            .collect()
    }

    pub fn open(&self, path: &str, target: OpenTarget) -> Result<(), CommandError> {
        let repo = self.repo(path)?;
        let launch = open::plan(target, &repo.path, &open::find_on_path)?;
        open::spawn(target, &launch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scanner::{GitBackend, ScanEvent};
    use crate::test_support::{commit_repo, git, isolated_git, repo_with_remote, temp_dir};
    use repowatch_core::{AttentionLevel, LineKind};
    use std::fs;

    struct Fixture {
        root: PathBuf,
        state: AppState,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let root = temp_dir(name);
            let config = temp_dir(&format!("{name}-config"));
            let scanner = Arc::new(Scanner::start(
                GitBackend(isolated_git()),
                |_: ScanEvent| {},
            ));
            let settings = Settings {
                roots: vec![root.join("repos").to_string_lossy().into_owned()],
                ..Settings::default()
            };
            fs::create_dir_all(root.join("repos")).unwrap();
            let state = AppState::new(
                isolated_git(),
                SettingsStore::overridden(config),
                settings,
                scanner,
                None,
                Arc::new(StatusBoard::new(|_| {})),
                |_: &Settings| {},
            );
            Self { root, state }
        }

        fn repos(&self) -> PathBuf {
            self.root.join("repos")
        }

        fn key(&self, name: &str) -> String {
            self.repos().join(name).to_string_lossy().into_owned()
        }
    }

    #[test]
    fn commands_refuse_paths_that_were_not_discovered() {
        let fx = Fixture::new("refuse");
        commit_repo(&fx.repos().join("known"));
        // A real repository outside the roots.
        let outside = fx.root.join("outside");
        commit_repo(&outside);
        fx.state.scan().unwrap();
        let known = fx.key("known");
        fs::write(fx.repos().join("known/README.md"), "changed\n").unwrap();

        let refused = [
            outside.to_string_lossy().into_owned(),
            fx.repos().to_string_lossy().into_owned(),
            format!("{known}\\.git"),
            format!("{known}/sub"),
            format!("{known}\\..\\known"),
            known.to_uppercase(),
            "known".into(),
            String::new(),
        ];
        let is_unknown = |result: Result<(), CommandError>| {
            matches!(result, Err(CommandError::UnknownRepo { .. }))
        };
        for path in &refused {
            assert!(is_unknown(fx.state.repo_detail(path).map(drop)), "{path}");
            assert!(is_unknown(
                fx.state
                    .file_diff(path, "README.md", DiffSide::Unstaged)
                    .map(drop)
            ));
            assert!(is_unknown(fx.state.lost_commits(path).map(drop)));
            assert!(is_unknown(fx.state.act(path, |git, repo| {
                repowatch_core::stage_file(git, repo, "README.md")
            })));
            assert!(is_unknown(fx.state.open(path, OpenTarget::FileManager)));
        }
        // Nothing was staged in the repository outside the roots.
        assert!(git(&outside, &["diff", "--cached", "--name-only"]).is_empty());
        // The same action on the discovered path works.
        fx.state
            .act(&known, |git, repo| {
                repowatch_core::stage_file(git, repo, "README.md")
            })
            .unwrap();
        assert_eq!(
            git(
                &fx.repos().join("known"),
                &["diff", "--cached", "--name-only"]
            ),
            "README.md\n"
        );
    }

    #[test]
    fn detail_diff_and_actions_work_on_a_discovered_repository() {
        let fx = Fixture::new("detail");
        let dir = fx.repos();
        let (clone, remote) = repo_with_remote(&dir);
        // Only the clone is a working tree; seed is a repository too.
        fx.state.scan().unwrap();
        let key = clone.to_string_lossy().into_owned();

        fs::write(clone.join("README.md"), "hello\nworld\n").unwrap();
        let detail = fx.state.repo_detail(&key).unwrap();
        assert_eq!(detail.name, "clone");
        assert_eq!(detail.status.report.counts.unstaged, 1);
        assert_eq!(
            detail.branches.default_branch.as_ref().unwrap().name,
            "main"
        );
        let diff = fx
            .state
            .file_diff(&key, "README.md", DiffSide::Unstaged)
            .unwrap();
        assert!(
            diff.hunks[0]
                .lines
                .iter()
                .any(|line| line.kind == LineKind::Added && line.text == "world")
        );

        fx.state
            .act(&key, |git, repo| {
                repowatch_core::stage_file(git, repo, "README.md")
            })
            .unwrap();
        fx.state
            .act(&key, |git, repo| {
                repowatch_core::commit(git, repo, "Add world")
            })
            .unwrap();
        fx.state.act(&key, repowatch_core::push).unwrap();
        assert_eq!(
            git(&remote, &["log", "-1", "--format=%s", "main"]).trim(),
            "Add world"
        );

        // Failures come back as typed git errors and nothing is left busy.
        let error = fx
            .state
            .act(&key, |git, repo| {
                repowatch_core::commit(git, repo, "nothing")
            })
            .unwrap_err();
        assert_eq!(
            error,
            CommandError::Git {
                error: GitError::NothingToCommit
            }
        );
        let error = fx
            .state
            .act(&key, |git, repo| {
                repowatch_core::delete_merged_branch(git, repo, "main")
            })
            .unwrap_err();
        assert!(matches!(
            error,
            CommandError::Git {
                error: GitError::InvalidInput { .. }
            }
        ));
        fx.state
            .act(&key, |git, repo| repowatch_core::fetch(git, repo, None))
            .unwrap();
    }

    #[test]
    fn a_second_action_on_the_same_repository_is_refused_while_one_runs() {
        let fx = Fixture::new("busy");
        commit_repo(&fx.repos().join("a"));
        commit_repo(&fx.repos().join("b"));
        fx.state.scan().unwrap();
        let (a, b) = (fx.key("a"), fx.key("b"));
        let (entered, release) = (std::sync::Barrier::new(2), std::sync::Barrier::new(2));
        std::thread::scope(|scope| {
            let first = scope.spawn(|| {
                fx.state.act(&a, |_, _| {
                    entered.wait();
                    release.wait();
                    Ok(())
                })
            });
            entered.wait();
            let second = fx.state.act(&a, |_, _| panic!("must not run"));
            assert!(matches!(second, Err(CommandError::Busy { .. })));
            // Another repository is not blocked.
            fx.state.act(&b, |_, _| Ok(())).unwrap();
            release.wait();
            first.join().unwrap().unwrap();
        });
        // Released after the first action, success or failure.
        fx.state
            .act(&a, |_, _| Err(GitError::NothingToCommit))
            .unwrap_err();
        fx.state.act(&a, |_, _| Ok(())).unwrap();
    }

    #[test]
    fn lost_commits_use_the_window_and_update_the_dashboard() {
        let fx = Fixture::new("lost");
        let repo = fx.repos().join("r");
        commit_repo(&repo);
        git(&repo, &["switch", "--quiet", "-c", "doomed"]);
        fs::write(repo.join("doomed.txt"), "x\n").unwrap();
        git(&repo, &["add", "doomed.txt"]);
        git(&repo, &["commit", "--quiet", "-m", "doomed work"]);
        git(&repo, &["switch", "--quiet", "main"]);
        git(&repo, &["branch", "--quiet", "-D", "doomed"]);
        fx.state.scan().unwrap();
        let key = fx.key("r");

        let lost = fx.state.lost_commits(&key).unwrap();
        assert_eq!(lost.window_days, 30);
        assert_eq!(lost.commits.len(), 1);
        assert_eq!(lost.commits[0].subject, "doomed work");
        let summary = fx.state.snapshot().unwrap().repos[0].clone();
        assert_eq!(summary.lost_commits, Some(1));
        assert_eq!(summary.attention.level, AttentionLevel::Risk);

        let oid = lost.commits[0].oid.clone();
        fx.state
            .act(&key, |git, path| {
                repowatch_core::recover_commit(git, path, &oid, "recovered")
            })
            .unwrap();
        assert_eq!(git(&repo, &["rev-parse", "recovered"]).trim(), oid);
    }

    #[test]
    fn settings_are_validated_saved_and_trigger_a_scan_when_roots_change() {
        let fx = Fixture::new("settings");
        commit_repo(&fx.repos().join("a"));
        let other = fx.root.join("other");
        commit_repo(&other.join("b"));
        assert_eq!(fx.state.scan().unwrap().repos.len(), 1);

        let invalid = Settings {
            lost_commit_window_days: 0,
            ..fx.state.settings()
        };
        assert!(matches!(
            fx.state.update_settings(invalid),
            Err(CommandError::InvalidSettings { .. })
        ));
        assert!(
            !SettingsStore::overridden(fx.state.config_dir())
                .file()
                .exists()
        );

        let next = Settings {
            roots: vec![other.to_string_lossy().into_owned()],
            ..fx.state.settings()
        };
        let before = fx.state.snapshot().unwrap().generation;
        fx.state.update_settings(next.clone()).unwrap();
        assert_eq!(
            SettingsStore::overridden(fx.state.config_dir()).load(),
            next
        );
        // The scan requested by the change finishes with the new root.
        let snapshot = loop {
            let snapshot = fx.state.snapshot().unwrap();
            if snapshot.generation > before {
                break snapshot;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(snapshot.repos.len(), 1);
        assert_eq!(snapshot.repos[0].name, "b");
        // The old repository is no longer accepted.
        assert!(fx.state.repo_detail(&fx.key("a")).is_err());
    }

    struct NoFetch;

    impl crate::background::Fetcher for NoFetch {
        fn fetch(&self, _repo: &std::path::Path) -> Result<(), GitError> {
            Ok(())
        }
    }

    #[test]
    fn overlapping_settings_updates_are_applied_and_announced_in_save_order() {
        use crate::background::BackgroundFetch;
        use std::sync::{OnceLock, Weak};

        let root = temp_dir("settings-order");
        let config = temp_dir("settings-order-config");
        let scanner = Arc::new(Scanner::start(
            GitBackend(isolated_git()),
            |_: ScanEvent| {},
        ));
        // Never fetches: the first round would be an hour away.
        let background =
            BackgroundFetch::start(NoFetch, Duration::from_secs(3600), Vec::new, |_| {});
        // Each announcement records the background fetch configuration at
        // that moment.
        // Also whether the settings lock was held, so no other update could
        // come between saving, applying and announcing.
        type Seen = (Settings, (bool, Duration), bool);
        let owner: Arc<OnceLock<Weak<AppState>>> = Arc::new(OnceLock::new());
        let announced: Arc<Mutex<Vec<Seen>>> = Arc::default();
        let state = {
            let owner = Arc::clone(&owner);
            let announced = Arc::clone(&announced);
            Arc::new(AppState::new(
                isolated_git(),
                SettingsStore::overridden(config.clone()),
                Settings {
                    roots: vec![root.to_string_lossy().into_owned()],
                    ..Settings::default()
                },
                scanner,
                Some(background),
                Arc::new(StatusBoard::new(|_| {})),
                move |settings: &Settings| {
                    let Some(state) = owner.get().and_then(Weak::upgrade) else {
                        return;
                    };
                    let applied = state.background.as_ref().unwrap().config();
                    let held = state.settings.try_lock().is_err();
                    lock(&announced).push((settings.clone(), applied, held));
                },
            ))
        };
        owner.set(Arc::downgrade(&state)).unwrap();
        let base = state.settings();
        // One update alone is announced under the lock, with its own
        // configuration applied.
        let mut first = base.clone();
        first.background_fetch.enabled = true;
        state.update_settings(first.clone()).unwrap();
        assert_eq!(
            lock(&announced).as_slice(),
            &[(first, (true, Duration::from_secs(30 * 60)), true)]
        );
        lock(&announced).clear();

        // Eight callers toggle background fetch at once, each with its own
        // interval, as a fast double toggle in the UI would.
        const CALLERS: u32 = 8;
        const UPDATES: u32 = 50;
        std::thread::scope(|scope| {
            for caller in 0..CALLERS {
                let (state, base) = (&state, &base);
                scope.spawn(move || {
                    for update in 0..UPDATES {
                        let mut next = base.clone();
                        next.background_fetch.enabled = (caller + update) % 2 == 0;
                        next.background_fetch.interval_minutes = 5 + caller;
                        state.update_settings(next).unwrap();
                    }
                });
            }
        });

        let seen = lock(&announced).clone();
        assert_eq!(seen.len(), (CALLERS * UPDATES) as usize);
        let interval = |settings: &Settings| {
            Duration::from_secs(u64::from(settings.background_fetch.interval_minutes) * 60)
        };
        // Every announcement matches what was applied when it was made...
        for (settings, applied, held) in &seen {
            assert!(held);
            assert_eq!(
                *applied,
                (settings.background_fetch.enabled, interval(settings))
            );
        }
        // ...and the last one is what is saved, held and applied now.
        let current = state.settings();
        assert_eq!(seen.last().unwrap().0, current);
        assert_eq!(SettingsStore::overridden(config).load(), current);
        assert_eq!(
            state.background.as_ref().unwrap().config(),
            (current.background_fetch.enabled, interval(&current))
        );
        // The start-up announcement repeats the current settings.
        state.announce_settings();
        assert_eq!(lock(&announced).last().unwrap().0, current);
    }

    #[test]
    fn status_board_announces_only_changes() {
        let count = Arc::new(Mutex::new(0));
        let seen = Arc::clone(&count);
        let board = StatusBoard::new(move |_| *lock(&seen) += 1);
        board.update(|status| status.scanning = true);
        board.update(|status| status.scanning = true);
        board.update(|status| status.watched_repos = 3);
        assert_eq!(*lock(&count), 2);
        board.background_fetch_finished();
        assert!(board.get().last_background_fetch_at.is_some());
    }
}
