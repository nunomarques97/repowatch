//! Branch analysis, stashes, worktrees, lost commits and repository
//! summaries against the generated fixture repositories.

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use common::fixtures;
use repowatch_core::{
    AttentionLevel, BranchReport, DefaultBranch, DefaultBranchSource, DiscoveredRepo,
    DiscoveryOptions, GitError, Head, LostCommitOptions, LostCommits, LostOrigin, MergeState,
    Reason, RepoKind, RepoSummary, attention_order, discover, find_lost_commits, list_stashes,
    list_worktrees, needs_attention_count, read_branches, sort_by_attention, summarize,
};

fn branches(name: &str) -> BranchReport {
    let fixtures = fixtures();
    read_branches(&fixtures.git, &fixtures.repo(name))
        .unwrap_or_else(|error| panic!("{name}: {error}"))
}

fn lost(name: &str) -> LostCommits {
    lost_with(name, &LostCommitOptions::default())
}

fn lost_with(name: &str, options: &LostCommitOptions) -> LostCommits {
    let fixtures = fixtures();
    find_lost_commits(&fixtures.git, &fixtures.repo(name), options)
        .unwrap_or_else(|error| panic!("{name}: {error}"))
}

fn discovered() -> &'static [DiscoveredRepo] {
    static REPOS: OnceLock<Vec<DiscoveredRepo>> = OnceLock::new();
    REPOS.get_or_init(|| {
        let fixtures = fixtures();
        let options = DiscoveryOptions {
            excluded: vec![fixtures.root.join("excluded-area")],
            ..DiscoveryOptions::default()
        };
        discover(std::slice::from_ref(&fixtures.root), &options).repos
    })
}

fn summary(name: &str) -> RepoSummary {
    let fixtures = fixtures();
    let path = fixtures.repo(name);
    let repo = discovered()
        .iter()
        .find(|repo| repo.path == path)
        .unwrap_or_else(|| panic!("{name} was not discovered"));
    summarize(&fixtures.git, repo)
}

fn reasons(summary: &RepoSummary) -> Vec<Reason> {
    summary
        .attention
        .reasons
        .iter()
        .map(|reason| reason.reason.clone())
        .collect()
}

fn unmerged(report: &BranchReport) -> Vec<(&str, u32)> {
    report
        .unmerged()
        .map(|branch| (branch.name.as_str(), branch.merge.unwrap().ahead))
        .collect()
}

/// Every file under the repository's git folder with its content, to prove
/// a read changed nothing.
fn snapshot(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut files = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                files.push((path.clone(), fs::read(&path).unwrap()));
            }
        }
    }
    files.sort();
    files
}

// --- Default branch and merge analysis -------------------------------------

#[test]
fn default_branch_follows_origin_head_before_main() {
    let report = branches("origin-head");
    assert_eq!(
        report.default_branch,
        Some(DefaultBranch {
            name: "trunk".into(),
            source: DefaultBranchSource::OriginHead,
            local: true,
            remote: Some("origin/trunk".into()),
        })
    );
    // `main` is an ordinary branch here, with one commit of its own.
    assert_eq!(unmerged(&report), [("main", 1)]);
    // feature/done is merged into origin/trunk but not into the local trunk
    // (not pulled yet): merged on either side counts as merged.
    let done = report
        .branches
        .iter()
        .find(|b| b.name == "feature/done")
        .unwrap();
    assert_eq!(
        done.merge,
        Some(MergeState {
            ahead: 0,
            behind: 0
        })
    );
    let trunk = report.head().unwrap();
    assert_eq!(trunk.name, "trunk");
    assert!(trunk.is_default);
    assert_eq!(trunk.merge, None);
    assert_eq!(trunk.upstream.as_deref(), Some("origin/trunk"));
}

#[test]
fn default_branch_falls_back_to_main_then_master() {
    let clean = branches("clean");
    assert_eq!(
        clean.default_branch,
        Some(DefaultBranch {
            name: "main".into(),
            source: DefaultBranchSource::Conventional,
            local: true,
            remote: Some("origin/main".into()),
        })
    );
    let master = branches("master-default");
    assert_eq!(master.default_branch.as_ref().unwrap().name, "master");
    let no_remote = branches("no-remote");
    assert_eq!(no_remote.default_branch.as_ref().unwrap().remote, None);
    assert!(no_remote.default_branch.as_ref().unwrap().local);
}

#[test]
fn unmerged_branches_are_listed_with_commit_counts() {
    let report = branches("unmerged-branches");
    assert_eq!(unmerged(&report), [("feature/a", 2), ("feature/b", 1)]);
    let names: Vec<&str> = report.branches.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names, ["feature/a", "feature/b", "main", "merged"]);
    let merged = report.branches.iter().find(|b| b.name == "merged").unwrap();
    assert!(!merged.is_unmerged());
    // main moved on after feature/a branched off.
    let feature_a = report
        .branches
        .iter()
        .find(|b| b.name == "feature/a")
        .unwrap();
    assert_eq!(feature_a.merge.unwrap().behind, 1);
    assert_eq!(feature_a.subject, "Feature A 2");
    assert!(feature_a.commit_time > 1_700_000_000);
}

#[test]
fn per_branch_counting_for_old_git_gives_the_same_result() {
    let fixtures = fixtures();
    for name in [
        "unmerged-branches",
        "origin-head",
        "no-default-branch",
        "conflict",
        "empty",
    ] {
        let fallback = repowatch_core::analysis::read_branches_counting_per_branch(
            &fixtures.git,
            &fixtures.repo(name),
        )
        .unwrap();
        assert_eq!(fallback, branches(name), "{name}");
    }
}

#[test]
fn repository_without_default_branch() {
    let report = branches("no-default-branch");
    assert_eq!(report.default_branch, None);
    let names: Vec<&str> = report.branches.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names, ["develop", "trunk"]);
    assert!(report.branches.iter().all(|b| b.merge.is_none()));
    assert_eq!(report.unmerged().count(), 0);

    let s = summary("no-default-branch");
    assert_eq!(s.default_branch, None);
    assert!(s.unmerged_branches.is_empty());
    assert_eq!(s.branch_count, 2);
    assert_eq!(reasons(&s), [Reason::NoRemote]);
}

#[test]
fn deleted_unmerged_branch_is_gone_from_the_branch_list() {
    let report = branches("lost-deleted-branch");
    let names: Vec<&str> = report.branches.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names, ["main"]);
    assert_eq!(report.unmerged().count(), 0);
}

#[test]
fn empty_repository_has_no_branches_and_nothing_to_do() {
    let report = branches("empty");
    assert_eq!(report, BranchReport::default());

    let s = summary("empty");
    assert_eq!(
        s.head,
        Some(Head::Unborn {
            name: "main".into()
        })
    );
    assert_eq!(s.oid, None);
    assert_eq!(s.last_commit, None);
    assert!(s.remotes.is_empty());
    assert_eq!(s.error, None);
    // No commits: nothing to push, so no "no remote" reason.
    assert_eq!(s.attention.level, AttentionLevel::Clean);
    assert!(s.attention.reasons.is_empty());
    assert!(lost("empty").commits.is_empty());
}

// --- Stashes and worktrees -------------------------------------------------

#[test]
fn stashes_are_listed_newest_first() {
    let fixtures = fixtures();
    let stashes = list_stashes(&fixtures.git, &fixtures.repo("stashes")).unwrap();
    let listed: Vec<(u32, &str)> = stashes
        .iter()
        .map(|s| (s.index, s.message.as_str()))
        .collect();
    assert_eq!(
        listed,
        [(0, "On main: second stash"), (1, "On main: first stash")]
    );
    assert!(
        stashes
            .iter()
            .all(|s| s.oid.len() == 40 && s.parents.len() == 2)
    );
    assert!(
        list_stashes(&fixtures.git, &fixtures.repo("clean"))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn worktrees_are_listed_with_the_main_one_first() {
    let fixtures = fixtures();
    let worktrees = list_worktrees(&fixtures.git, &fixtures.repo("worktrees-main")).unwrap();
    let listed: Vec<(PathBuf, Option<&str>, bool, bool)> = worktrees
        .iter()
        .map(|w| (w.path.clone(), w.branch.as_deref(), w.is_main, w.prunable))
        .collect();
    assert_eq!(
        listed,
        [
            (fixtures.repo("worktrees-main"), Some("main"), true, false),
            (
                fixtures.repo("worktrees-linked"),
                Some("linked-branch"),
                false,
                false
            ),
            (
                fixtures.repo("worktrees-main/.worktrees/inner"),
                Some("inner-branch"),
                false,
                false
            ),
            (
                fixtures.repo("worktrees-pruned"),
                Some("pruned-branch"),
                false,
                true
            ),
        ]
    );

    // The summary of the main repository and of a linked worktree list the
    // same working trees; a repository without worktrees lists none.
    let main = summary("worktrees-main");
    assert_eq!(main.worktrees, worktrees);
    let linked = summary("worktrees-linked");
    assert!(matches!(linked.kind, RepoKind::LinkedWorktree { .. }));
    assert_eq!(linked.worktrees, worktrees);
    assert!(summary("clean").worktrees.is_empty());

    let detached = list_worktrees(&fixtures.git, &fixtures.repo("detached")).unwrap();
    assert!(detached[0].detached && detached[0].branch.is_none());
    let empty = list_worktrees(&fixtures.git, &fixtures.repo("empty")).unwrap();
    assert_eq!(empty[0].oid, None);
}

// --- Lost commits ----------------------------------------------------------

#[test]
fn commit_of_a_deleted_unmerged_branch_is_lost() {
    let found = lost("lost-deleted-branch");
    assert!(!found.truncated);
    assert_eq!(found.window_days, 30);
    let subjects: Vec<(&str, LostOrigin)> = found
        .commits
        .iter()
        .map(|c| (c.subject.as_str(), c.origin))
        .collect();
    assert_eq!(
        subjects,
        [("Lost work on a deleted branch", LostOrigin::Reflog)]
    );
    let commit = &found.commits[0];
    assert_eq!(commit.oid.len(), 40);
    assert_eq!(commit.author, "Repowatch Fixtures");
    assert_eq!(commit.parents.len(), 1);
    assert!(commit.time > 1_700_000_000);
}

#[test]
fn commit_removed_by_a_hard_reset_is_lost() {
    let found = lost("lost-hard-reset");
    let subjects: Vec<(&str, LostOrigin)> = found
        .commits
        .iter()
        .map(|c| (c.subject.as_str(), c.origin))
        .collect();
    assert_eq!(
        subjects,
        [("Lost work before a hard reset", LostOrigin::Reflog)]
    );
}

#[test]
fn dropped_stash_is_one_dangling_commit() {
    let found = lost("lost-dangling");
    let subjects: Vec<(&str, LostOrigin)> = found
        .commits
        .iter()
        .map(|c| (c.subject.as_str(), c.origin))
        .collect();
    // The stash's "index on main" commit is part of the stash, not listed.
    assert_eq!(subjects, [("On main: dropped stash", LostOrigin::Dangling)]);
}

#[test]
fn live_stashes_and_healthy_repositories_have_no_lost_commits() {
    // The older stash is reachable only through the stash reflog.
    for name in [
        "stashes",
        "clean",
        "unmerged-branches",
        "no-default-branch",
        "worktrees-main",
        "origin-head",
    ] {
        assert_eq!(lost(name).commits, [], "{name}");
    }
}

#[test]
fn lost_commits_older_than_the_window_are_left_out() {
    assert!(lost("lost-old").commits.is_empty());
    let wide = lost_with(
        "lost-old",
        &LostCommitOptions {
            window_days: 90,
            ..LostCommitOptions::default()
        },
    );
    assert_eq!(wide.window_days, 90);
    let subjects: Vec<&str> = wide.commits.iter().map(|c| c.subject.as_str()).collect();
    assert_eq!(subjects, ["Old lost work"]);
}

#[test]
fn lost_commit_limit_reports_truncation() {
    let none = lost_with(
        "lost-deleted-branch",
        &LostCommitOptions {
            limit: 0,
            ..LostCommitOptions::default()
        },
    );
    assert!(none.commits.is_empty());
    assert!(none.truncated);
}

#[test]
fn finding_lost_commits_changes_nothing_in_the_repository() {
    let fixtures = fixtures();
    let git_dir = fixtures.repo("lost-hard-reset").join(".git");
    let before = snapshot(&git_dir);
    assert_eq!(lost("lost-hard-reset").commits.len(), 1);
    assert_eq!(snapshot(&git_dir), before);
    assert!(!git_dir.join("lost-found").exists());
}

#[test]
fn lost_commits_of_a_broken_repository_fail_with_a_git_error() {
    let fixtures = fixtures();
    let result = find_lost_commits(
        &fixtures.git,
        &fixtures.repo("broken"),
        &LostCommitOptions::default(),
    );
    assert!(matches!(result, Err(GitError::Failed { .. })), "{result:?}");
}

// --- Summaries and attention -----------------------------------------------

#[test]
fn clean_repository_needs_no_attention() {
    let s = summary("clean");
    assert_eq!(s.name, "clean");
    assert_eq!(s.kind, RepoKind::Main);
    assert_eq!(s.attention.level, AttentionLevel::Clean);
    assert!(!s.attention.needs_attention);
    assert_eq!(s.lost_commits, None);
    let last = s.last_commit.as_ref().unwrap();
    assert_eq!(last.subject, "Add changelog");
    assert_eq!(Some(&last.oid), s.oid.as_ref());
    assert_eq!(s.default_branch.as_ref().unwrap().name, "main");
}

#[test]
fn reasons_and_levels_for_every_state() {
    let cases: Vec<(&str, AttentionLevel, Vec<Reason>)> = vec![
        (
            "mixed",
            AttentionLevel::Change,
            vec![
                Reason::Staged { count: 2 },
                Reason::Unstaged { count: 2 },
                Reason::Untracked { count: 1 },
            ],
        ),
        (
            "conflict",
            AttentionLevel::Risk,
            vec![
                Reason::Conflicts { count: 1 },
                Reason::Staged { count: 1 },
                Reason::NoRemote,
                Reason::UnmergedBranches { count: 1 },
            ],
        ),
        ("detached", AttentionLevel::Risk, vec![Reason::DetachedHead]),
        (
            "ahead",
            AttentionLevel::Sync,
            vec![Reason::Ahead { count: 2 }],
        ),
        (
            "diverged",
            AttentionLevel::Sync,
            vec![Reason::Ahead { count: 1 }, Reason::Behind { count: 2 }],
        ),
        (
            "no-upstream",
            AttentionLevel::Sync,
            vec![Reason::NoUpstream, Reason::UnmergedBranches { count: 1 }],
        ),
        (
            "upstream-gone",
            AttentionLevel::Sync,
            vec![Reason::UpstreamGone, Reason::UnmergedBranches { count: 1 }],
        ),
        ("no-remote", AttentionLevel::Sync, vec![Reason::NoRemote]),
        (
            "unmerged-branches",
            AttentionLevel::Branch,
            vec![Reason::UnmergedBranches { count: 2 }],
        ),
        (
            "stashes",
            AttentionLevel::Branch,
            vec![Reason::Stashes { count: 2 }],
        ),
        (
            "origin-head",
            AttentionLevel::Sync,
            vec![
                Reason::Behind { count: 1 },
                Reason::UnmergedBranches { count: 1 },
            ],
        ),
    ];
    for (name, level, expected) in cases {
        let s = summary(name);
        assert_eq!(s.error, None, "{name}");
        assert_eq!(reasons(&s), expected, "{name}");
        assert_eq!(s.attention.level, level, "{name}");
        assert!(s.attention.needs_attention, "{name}");
    }
}

#[test]
fn detached_head_still_reports_its_commit() {
    let s = summary("detached");
    assert_eq!(s.head, Some(Head::Detached));
    let last = s.last_commit.unwrap();
    assert_eq!(last.subject, "Initial commit");
    assert_eq!(Some(last.oid), s.oid);
}

#[test]
fn broken_repository_is_an_at_risk_summary_not_a_failure() {
    let s = summary("broken");
    assert!(matches!(s.error, Some(GitError::Failed { .. })), "{s:?}");
    assert_eq!(s.head, None);
    assert_eq!(s.attention.level, AttentionLevel::Risk);
    assert!(matches!(
        reasons(&s).as_slice(),
        [Reason::ScanError { message }] if message.contains("bad object")
    ));
}

#[test]
fn on_demand_lost_commit_count_raises_the_level() {
    let mut s = summary("lost-hard-reset");
    // The scan does not look for lost commits.
    assert_eq!(s.lost_commits, None);
    assert_eq!(reasons(&s), [Reason::NoRemote]);
    let found = lost("lost-hard-reset").commits.len() as u32;
    s.set_lost_commits(found);
    assert_eq!(s.lost_commits, Some(1));
    assert_eq!(s.attention.level, AttentionLevel::Risk);
    assert_eq!(
        reasons(&s),
        [Reason::LostCommits { count: 1 }, Reason::NoRemote]
    );
    s.set_lost_commits(0);
    assert_eq!(reasons(&s), [Reason::NoRemote]);
}

#[test]
fn scan_sorts_by_attention_and_counts_the_tray_badge() {
    let fixtures = fixtures();
    let mut summaries: Vec<RepoSummary> = discovered()
        .iter()
        .map(|repo| summarize(&fixtures.git, repo))
        .collect();
    sort_by_attention(&mut summaries);
    let levels: Vec<AttentionLevel> = summaries.iter().map(|s| s.attention.level).collect();
    assert!(
        levels.windows(2).all(|pair| pair[0] >= pair[1]),
        "{levels:?}"
    );
    assert_eq!(levels.first(), Some(&AttentionLevel::Risk));
    assert_eq!(levels.last(), Some(&AttentionLevel::Clean));
    assert!(
        summaries
            .windows(2)
            .all(|pair| attention_order(&pair[0], &pair[1]).is_le())
    );

    let expected = summaries
        .iter()
        .filter(|s| s.attention.level != AttentionLevel::Clean)
        .count();
    assert_eq!(needs_attention_count(&summaries), expected);
    let clean: Vec<&str> = summaries
        .iter()
        .filter(|s| !s.attention.needs_attention)
        .map(|s| s.name.as_str())
        .collect();
    for name in ["clean", "empty", "unfetched", "master-default"] {
        assert!(clean.contains(&name), "{name} should be clean: {clean:?}");
    }
    assert!(!clean.contains(&"broken"));
}

#[test]
fn summary_serializes_for_the_app() {
    let json = serde_json::to_value(summary("unmerged-branches")).unwrap();
    assert_eq!(json["name"], "unmerged-branches");
    assert_eq!(json["kind"], serde_json::json!({ "kind": "main" }));
    assert_eq!(json["head"]["name"], "main");
    assert_eq!(json["defaultBranch"]["source"], "conventional");
    assert_eq!(json["unmergedBranches"][0]["name"], "feature/a");
    assert_eq!(json["unmergedBranches"][0]["merge"]["ahead"], 2);
    assert_eq!(json["branchCount"], 4);
    assert_eq!(json["lostCommits"], serde_json::Value::Null);
    assert_eq!(json["attention"]["level"], "branch");
    assert_eq!(json["attention"]["needsAttention"], true);
    assert_eq!(
        json["attention"]["reasons"][0],
        serde_json::json!({ "level": "branch", "kind": "unmergedBranches", "count": 2 })
    );

    let lost = serde_json::to_value(lost("lost-dangling")).unwrap();
    assert_eq!(lost["windowDays"], 30);
    assert_eq!(lost["commits"][0]["origin"], "dangling");
}
