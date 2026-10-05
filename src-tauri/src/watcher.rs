//! Cheap change watching: file-system events on each discovered repository,
//! debounced into one refresh of the repositories that changed.
//!
//! Each working tree is watched recursively (ReadDirectoryChangesW on
//! Windows, the OS notification API elsewhere). Events in dependency and
//! build folders (`node_modules`, `target`, ... the discovery skip list) and
//! in git's object store, logs and lock files are dropped, so a build or a
//! large install does not cause refreshes. Repowatch's own reads never write
//! to a repository, so they cause no events.
//!
//! Events are collected until the repository has been quiet for
//! [`Debounce::quiet`] (or [`Debounce::max_wait`] has passed during constant
//! changes); then the sink gets the keys of the repositories to read again.
//! New repositories are found by the periodic and on-demand full scans.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use repowatch_core::discovery::DEFAULT_SKIP_DIRS;

use crate::scanner::RepoMap;

#[derive(Debug, Clone, Copy)]
pub struct Debounce {
    /// Quiet time after the last event before a refresh.
    pub quiet: Duration,
    /// Longest wait from the first event, even if events keep coming.
    pub max_wait: Duration,
}

impl Default for Debounce {
    fn default() -> Self {
        Self {
            quiet: Duration::from_millis(800),
            max_wait: Duration::from_secs(5),
        }
    }
}

/// Watches the repositories of one scan; dropping it stops watching.
pub struct RepoWatcher {
    _watcher: Option<RecommendedWatcher>,
    watched: usize,
}

impl RepoWatcher {
    /// Watches nothing.
    pub fn idle() -> Self {
        Self {
            _watcher: None,
            watched: 0,
        }
    }

    /// Starts watching `repos`; `sink` receives the keys of changed
    /// repositories. A folder that cannot be watched is skipped.
    pub fn start(
        repos: &RepoMap,
        debounce: Debounce,
        sink: impl Fn(Vec<String>) + Send + 'static,
    ) -> Self {
        if repos.is_empty() {
            return Self::idle();
        }
        let matcher = Matcher::new(repos);
        let (sender, receiver) = mpsc::channel::<String>();
        let handler = EventHandler { matcher, sender };
        let mut watcher = match notify::recommended_watcher(handler) {
            Ok(watcher) => watcher,
            Err(_) => return Self::idle(),
        };
        let mut watched = 0;
        let mut watched_paths: Vec<PathBuf> = Vec::new();
        for repo in repos.values() {
            if watcher.watch(&repo.path, RecursiveMode::Recursive).is_ok() {
                watched += 1;
                watched_paths.push(repo.path.clone());
            }
        }
        // A linked worktree's git folder lives in its main repository; watch
        // it when that repository is not watched already.
        for repo in repos.values() {
            if !watched_paths
                .iter()
                .any(|path| repo.git_dir.starts_with(path))
            {
                let _ = watcher.watch(&repo.git_dir, RecursiveMode::Recursive);
            }
        }
        thread::Builder::new()
            .name("repowatch-watch-debounce".into())
            .spawn(move || debounce_loop(&receiver, debounce, sink))
            .expect("cannot start the watcher thread");
        Self {
            _watcher: Some(watcher),
            watched,
        }
    }

    /// Number of working trees being watched.
    pub fn watched(&self) -> usize {
        self.watched
    }
}

struct EventHandler {
    matcher: Matcher,
    sender: Sender<String>,
}

impl notify::EventHandler for EventHandler {
    fn handle_event(&mut self, event: notify::Result<notify::Event>) {
        let Ok(event) = event else { return };
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        for path in &event.paths {
            for key in self.matcher.keys_for(path) {
                let _ = self.sender.send(key);
            }
        }
    }
}

/// Maps a changed path to the repositories it affects.
struct Matcher {
    work_trees: Vec<(PathBuf, String)>,
    git_dirs: Vec<(PathBuf, String)>,
}

impl Matcher {
    fn new(repos: &RepoMap) -> Self {
        Self {
            work_trees: repos
                .iter()
                .map(|(key, repo)| (repo.path.clone(), key.clone()))
                .collect(),
            git_dirs: repos
                .iter()
                .map(|(key, repo)| (repo.git_dir.clone(), key.clone()))
                .collect(),
        }
    }

    fn keys_for(&self, path: &Path) -> Vec<String> {
        let mut keys = Vec::new();
        // Inside a git folder: the repository with the most specific one
        // (a linked worktree's folder is inside its main repository's).
        if let Some((rel, key)) = longest_prefix(&self.git_dirs, path) {
            if git_change_matters(rel) {
                keys.push(key.clone());
            }
            return keys;
        }
        if let Some((rel, key)) = longest_prefix(&self.work_trees, path) {
            if work_tree_change_matters(rel) {
                keys.push(key.clone());
            }
        }
        keys
    }
}

fn longest_prefix<'a, 'p>(
    entries: &'a [(PathBuf, String)],
    path: &'p Path,
) -> Option<(&'p Path, &'a String)> {
    entries
        .iter()
        .filter_map(|(prefix, key)| {
            path.strip_prefix(prefix)
                .ok()
                .map(|rel| (prefix.as_os_str().len(), rel, key))
        })
        .max_by_key(|(len, _, _)| *len)
        .map(|(_, rel, key)| (rel, key))
}

fn names(rel: &Path) -> impl Iterator<Item = String> + '_ {
    rel.components().filter_map(|component| match component {
        Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
        _ => None,
    })
}

/// A change in the working tree outside `.git` and skipped folders.
fn work_tree_change_matters(rel: &Path) -> bool {
    !names(rel).any(|name| {
        name.eq_ignore_ascii_case(".git")
            || DEFAULT_SKIP_DIRS
                .iter()
                .any(|skip| skip.eq_ignore_ascii_case(&name))
    })
}

/// A change in a git folder that can change the status: index, HEAD, refs,
/// config, stash, merge state. Objects, logs, hooks and lock files are
/// noise (a lock file is renamed to the real file, which is seen).
fn git_change_matters(rel: &Path) -> bool {
    let parts: Vec<String> = names(rel).collect();
    let Some(first) = parts.first() else {
        return true;
    };
    let last = parts.last().map(String::as_str).unwrap_or_default();
    if last.ends_with(".lock") {
        return false;
    }
    !matches!(
        first.as_str(),
        "objects"
            | "logs"
            | "hooks"
            | "info"
            | "lfs"
            | "fsmonitor--daemon"
            | "gc.log"
            | "COMMIT_EDITMSG"
            | "description"
    ) && !(first == "worktrees" && parts.get(2).is_some_and(|part| part == "logs"))
}

fn debounce_loop(receiver: &Receiver<String>, debounce: Debounce, sink: impl Fn(Vec<String>)) {
    while let Ok(first) = receiver.recv() {
        let mut keys = BTreeSet::from([first]);
        let started = Instant::now();
        loop {
            let left = debounce.max_wait.saturating_sub(started.elapsed());
            if left.is_zero() {
                break;
            }
            match receiver.recv_timeout(debounce.quiet.min(left)) {
                Ok(key) => {
                    keys.insert(key);
                }
                Err(RecvTimeoutError::Timeout) => break,
                // The watcher was replaced: the next scan reads everything.
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        sink(keys.into_iter().collect());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{commit_repo, temp_dir};
    use repowatch_core::{DiscoveredRepo, RepoKind};
    use std::sync::Mutex;

    fn map(entries: &[(&Path, &Path, bool)]) -> RepoMap {
        entries
            .iter()
            .map(|(path, git_dir, linked)| {
                let kind = if *linked {
                    RepoKind::LinkedWorktree {
                        common_dir: PathBuf::new(),
                        main_path: None,
                    }
                } else {
                    RepoKind::Main
                };
                (
                    path.to_string_lossy().into_owned(),
                    DiscoveredRepo {
                        path: path.to_path_buf(),
                        git_dir: git_dir.to_path_buf(),
                        kind,
                    },
                )
            })
            .collect()
    }

    #[test]
    fn changes_map_to_the_repository_that_owns_them() {
        let root = std::env::temp_dir().join("matcher");
        let main = root.join("main");
        let wt = root.join("wt");
        let inner_wt = main.join("inner-wt");
        let repos = map(&[
            (&main, &main.join(".git"), false),
            (&wt, &main.join(".git/worktrees/wt"), true),
            (&inner_wt, &main.join(".git/worktrees/inner-wt"), true),
        ]);
        let matcher = Matcher::new(&repos);
        let key = |path: &Path| path.to_string_lossy().into_owned();
        let keys = |path: PathBuf| matcher.keys_for(&path);

        assert_eq!(keys(main.join("src/lib.rs")), vec![key(&main)]);
        assert_eq!(keys(main.join(".git/index")), vec![key(&main)]);
        assert_eq!(keys(main.join(".git/refs/heads/feature")), vec![key(&main)]);
        assert_eq!(keys(main.join(".git/HEAD")), vec![key(&main)]);
        assert_eq!(keys(wt.join("file.txt")), vec![key(&wt)]);
        assert_eq!(keys(main.join(".git/worktrees/wt/index")), vec![key(&wt)]);
        assert_eq!(keys(inner_wt.join("a.txt")), vec![key(&inner_wt)]);
        assert!(keys(root.join("elsewhere/file")).is_empty());
    }

    #[test]
    fn noise_is_ignored() {
        let main = std::env::temp_dir().join("noise").join("main");
        let repos = map(&[(&main, &main.join(".git"), false)]);
        let matcher = Matcher::new(&repos);
        for noise in [
            "node_modules/pkg/index.js",
            "web/node_modules/x",
            "target/debug/app.exe",
            "NODE_MODULES/x",
            ".git/objects/ab/cdef",
            ".git/index.lock",
            ".git/refs/heads/main.lock",
            ".git/logs/HEAD",
            ".git/hooks/pre-commit",
            ".git/worktrees/wt/logs/HEAD",
        ] {
            assert!(matcher.keys_for(&main.join(noise)).is_empty(), "{noise}");
        }
    }

    #[test]
    fn bursts_are_debounced_into_one_refresh() {
        let (sender, receiver) = mpsc::channel();
        let batches = std::sync::Arc::new(Mutex::new(Vec::new()));
        let sink_batches = std::sync::Arc::clone(&batches);
        let debounce = Debounce {
            quiet: Duration::from_millis(100),
            max_wait: Duration::from_secs(5),
        };
        let thread = thread::spawn(move || {
            debounce_loop(&receiver, debounce, move |keys| {
                sink_batches.lock().unwrap().push(keys)
            })
        });
        for key in ["b", "a", "b", "a"] {
            sender.send(key.to_string()).unwrap();
            thread::sleep(Duration::from_millis(10));
        }
        thread::sleep(Duration::from_millis(400));
        sender.send("c".into()).unwrap();
        thread::sleep(Duration::from_millis(400));
        drop(sender);
        thread.join().unwrap();
        let batches = batches.lock().unwrap();
        assert_eq!(
            *batches,
            vec![
                vec!["a".to_string(), "b".to_string()],
                vec!["c".to_string()]
            ]
        );
    }

    #[test]
    fn constant_changes_still_refresh_after_max_wait() {
        let (sender, receiver) = mpsc::channel();
        let (out, results) = mpsc::channel();
        let debounce = Debounce {
            quiet: Duration::from_millis(200),
            max_wait: Duration::from_millis(300),
        };
        thread::spawn(move || {
            debounce_loop(&receiver, debounce, move |keys| out.send(keys).unwrap())
        });
        let started = Instant::now();
        while started.elapsed() < Duration::from_millis(1000) {
            if sender.send("a".into()).is_err() {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert!(results.recv_timeout(Duration::from_millis(10)).is_ok());
    }

    #[test]
    fn file_events_on_a_real_repository_reach_the_sink() {
        let root = temp_dir("watch");
        let repo = root.join("repo");
        commit_repo(&repo);
        std::fs::create_dir_all(repo.join("node_modules")).unwrap();
        let repos = map(&[(&repo, &repo.join(".git"), false)]);
        let (out, results) = mpsc::channel();
        let watcher = RepoWatcher::start(
            &repos,
            Debounce {
                quiet: Duration::from_millis(150),
                max_wait: Duration::from_secs(2),
            },
            move |keys| {
                let _ = out.send(keys);
            },
        );
        assert_eq!(watcher.watched(), 1);
        thread::sleep(Duration::from_millis(200));

        // Dependency folders are noise.
        std::fs::write(repo.join("node_modules/dep.js"), "x").unwrap();
        assert!(results.recv_timeout(Duration::from_millis(800)).is_err());

        std::fs::write(repo.join("new.txt"), "x").unwrap();
        let keys = results
            .recv_timeout(Duration::from_secs(10))
            .expect("a refresh for the change");
        assert_eq!(keys, vec![repo.to_string_lossy().into_owned()]);

        // After the watcher is dropped, changes are not reported.
        drop(watcher);
        thread::sleep(Duration::from_millis(100));
        std::fs::write(repo.join("later.txt"), "x").unwrap();
        assert!(results.recv_timeout(Duration::from_millis(600)).is_err());
    }
}
