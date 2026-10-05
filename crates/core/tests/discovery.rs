//! Discovery against the generated fixture tree.

mod common;

use std::fs;
use std::path::{Path, PathBuf};

use common::fixtures;
use repowatch_core::{DiscoveryOptions, RepoKind, discover};

fn sorted(mut paths: Vec<PathBuf>) -> Vec<PathBuf> {
    paths.sort();
    paths
}

fn found_paths(roots: &[PathBuf], options: &DiscoveryOptions) -> Vec<PathBuf> {
    sorted(
        discover(roots, options)
            .repos
            .into_iter()
            .map(|repo| repo.path)
            .collect(),
    )
}

fn excluding_area() -> DiscoveryOptions {
    DiscoveryOptions {
        excluded: vec![fixtures().root.join("excluded-area")],
        ..DiscoveryOptions::default()
    }
}

#[test]
fn finds_exactly_the_expected_repositories_and_worktrees() {
    let fixtures = fixtures();
    let discovery = discover(std::slice::from_ref(&fixtures.root), &excluding_area());
    assert!(discovery.issues.is_empty(), "{:?}", discovery.issues);
    let found: Vec<PathBuf> = discovery
        .repos
        .iter()
        .map(|repo| repo.path.clone())
        .collect();
    assert_eq!(
        sorted(found),
        sorted(fixtures.manifest_paths("expectedDiscovered"))
    );
}

#[test]
fn skipped_folders_bare_remotes_and_nested_repositories_are_not_listed() {
    let fixtures = fixtures();
    let found = found_paths(std::slice::from_ref(&fixtures.root), &excluding_area());
    let hidden = fixtures.manifest_paths("hidden");
    assert!(
        hidden
            .iter()
            .any(|p| p.ends_with("node_modules/some-package"))
    );
    assert!(
        hidden
            .iter()
            .any(|p| p.ends_with("nested-outer/inner-repo"))
    );
    assert!(
        hidden
            .iter()
            .any(|p| p.extension().is_some_and(|e| e == "git")),
        "bare remotes are hidden"
    );
    for path in &hidden {
        assert!(
            !found.contains(path),
            "{} must not be discovered",
            path.display()
        );
    }
}

#[test]
fn user_exclusions_are_honoured() {
    let fixtures = fixtures();
    let excluded_repo = fixtures.root.join("excluded-area/excluded-repo");
    assert!(
        found_paths(
            std::slice::from_ref(&fixtures.root),
            &DiscoveryOptions::default()
        )
        .contains(&excluded_repo)
    );
    assert!(
        !found_paths(std::slice::from_ref(&fixtures.root), &excluding_area())
            .contains(&excluded_repo)
    );

    // Excluding a worktree path also hides it when it is found through its
    // main repository.
    let options = DiscoveryOptions {
        excluded: vec![fixtures.root.join("worktrees-main/.worktrees")],
        ..DiscoveryOptions::default()
    };
    let found = found_paths(std::slice::from_ref(&fixtures.root), &options);
    assert!(!found.contains(&fixtures.repo("worktrees-main/.worktrees/inner")));
    assert!(found.contains(&fixtures.repo("worktrees-main")));
}

#[test]
fn linked_worktrees_point_to_their_main_repository() {
    let fixtures = fixtures();
    let discovery = discover(
        &[fixtures.repo("worktrees-main")],
        &DiscoveryOptions::default(),
    );
    let main = fixtures.repo("worktrees-main");
    // The root is the main repository; its linked worktrees (one outside the
    // root, one inside it) come from its worktree registry. The deleted one
    // is ignored.
    let paths: Vec<&Path> = discovery
        .repos
        .iter()
        .map(|repo| repo.path.as_path())
        .collect();
    assert_eq!(
        sorted(paths.iter().map(|p| p.to_path_buf()).collect()),
        sorted(vec![
            main.clone(),
            fixtures.repo("worktrees-linked"),
            main.join(".worktrees").join("inner")
        ])
    );
    for repo in &discovery.repos {
        if repo.path == main {
            assert_eq!(repo.kind, RepoKind::Main);
            assert_eq!(repo.git_dir, main.join(".git"));
        } else {
            match &repo.kind {
                RepoKind::LinkedWorktree {
                    common_dir,
                    main_path,
                } => {
                    assert_eq!(common_dir, &main.join(".git"));
                    assert_eq!(main_path.as_ref(), Some(&main));
                }
                other => panic!(
                    "{} should be a linked worktree, got {other:?}",
                    repo.path.display()
                ),
            }
        }
    }
}

#[test]
fn a_root_inside_a_repository_tree_and_overlapping_roots() {
    let fixtures = fixtures();
    // The deep repository is four levels down; overlapping roots list it once.
    let roots = [
        fixtures.root.join("deep"),
        fixtures.root.join("deep/level-1"),
        fixtures.root.clone(),
    ];
    let found = found_paths(&roots, &excluding_area());
    let deep = fixtures.repo("deep/level-1/level-2/level-3/deep-repo");
    assert_eq!(found.iter().filter(|p| **p == deep).count(), 1);
    // A depth limit stops the walk.
    let shallow = DiscoveryOptions {
        max_depth: 2,
        ..DiscoveryOptions::default()
    };
    assert!(!found_paths(&[fixtures.root.join("deep")], &shallow).contains(&deep));
}

#[test]
fn missing_roots_are_reported_and_do_not_stop_the_scan() {
    let fixtures = fixtures();
    let missing = fixtures.root.join("no-such-root");
    let discovery = discover(
        &[missing.clone(), fixtures.repo("clean")],
        &DiscoveryOptions::default(),
    );
    assert_eq!(discovery.repos.len(), 1);
    assert_eq!(discovery.issues.len(), 1);
    assert_eq!(discovery.issues[0].path, missing);
}

/// A folder the current user cannot list.
struct LockedFolder {
    path: PathBuf,
}

impl LockedFolder {
    fn new(path: PathBuf) -> Self {
        fs::create_dir_all(&path).unwrap();
        lock(&path, true);
        Self { path }
    }
}

impl Drop for LockedFolder {
    fn drop(&mut self) {
        lock(&self.path, false);
    }
}

#[cfg(windows)]
fn lock(path: &Path, deny: bool) {
    // Deny (or restore) "list folder" for Everyone (S-1-1-0).
    let mut command = std::process::Command::new("icacls");
    command.arg(path);
    if deny {
        command.args(["/deny", "*S-1-1-0:(RD)"]);
    } else {
        command.args(["/remove:d", "*S-1-1-0"]);
    }
    let output = command.output().expect("icacls");
    assert!(
        output.status.success(),
        "icacls failed: {}",
        String::from_utf8_lossy(&output.stdout)
    );
}

#[cfg(unix)]
fn lock(path: &Path, deny: bool) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(
        path,
        fs::Permissions::from_mode(if deny { 0o000 } else { 0o755 }),
    )
    .unwrap();
}

#[test]
fn unreadable_folders_are_reported_and_skipped() {
    let base =
        std::env::temp_dir().join(format!("repowatch-core-unreadable-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let readable_repo = base.join("ok");
    fs::create_dir_all(readable_repo.join(".git")).unwrap();
    fs::write(readable_repo.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    let locked_path = base.join("locked");
    let hidden_repo = locked_path.join("inner");
    fs::create_dir_all(hidden_repo.join(".git")).unwrap();
    fs::write(hidden_repo.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();

    let locked = LockedFolder::new(locked_path.clone());
    let actually_locked = fs::read_dir(&locked.path).is_err();
    let discovery = discover(std::slice::from_ref(&base), &DiscoveryOptions::default());
    drop(locked);
    fs::remove_dir_all(&base).unwrap();

    let paths: Vec<PathBuf> = discovery
        .repos
        .iter()
        .map(|repo| repo.path.clone())
        .collect();
    assert!(paths.contains(&readable_repo), "{paths:?}");
    // Elevated users can list anything; then there is nothing to report.
    if actually_locked {
        assert_eq!(paths, [readable_repo]);
        assert_eq!(discovery.issues.len(), 1, "{:?}", discovery.issues);
        assert_eq!(discovery.issues[0].path, locked_path);
    }
}

#[test]
fn discovery_serializes_for_the_app() {
    let fixtures = fixtures();
    let discovery = discover(
        &[fixtures.repo("worktrees-main")],
        &DiscoveryOptions::default(),
    );
    let json = serde_json::to_value(&discovery).unwrap();
    let kinds: Vec<&str> = json["repos"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["kind"].as_str().unwrap())
        .collect();
    assert!(
        kinds.contains(&"main") && kinds.contains(&"linkedWorktree"),
        "{kinds:?}"
    );
    assert!(json["repos"][0]["gitDir"].is_string());
}
