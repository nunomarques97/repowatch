//! IPC contract check: serializes one value of every type the commands and
//! events exchange (covering every enum variant) into
//! `src/ipc/contract.generated.ts`, typed with the TypeScript types of
//! `src/ipc/types.ts`. `npm run typecheck` then fails if the Rust output and
//! the TypeScript types disagree (a missing, extra or renamed field or
//! variant).
//!
//! The test fails when the file is out of date; regenerate it with
//! `REPOWATCH_UPDATE_CONTRACT=1 npm run test:rust`.

use std::path::{Path, PathBuf};

use repowatch_core::*;
use serde::Serialize;

use crate::commands::AppInfo;
use crate::error::CommandError;
use crate::open::OpenTarget;
use crate::scanner::ScanSnapshot;
use crate::settings::{BackgroundFetch, Density, Settings, Theme};
use crate::state::{AppStatus, RepoDetail};

const OID: &str = "4f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39";
const OID2: &str = "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a291807";
const TIME: i64 = 1_791_100_000;

fn path(text: &str) -> PathBuf {
    PathBuf::from(text)
}

fn branch(name: &str, merge: Option<MergeState>) -> Branch {
    Branch {
        name: name.into(),
        oid: OID.into(),
        is_head: name == "main",
        is_default: name == "main",
        upstream: Some(format!("origin/{name}")),
        upstream_gone: name == "feature/gone",
        commit_time: TIME,
        subject: format!("Work on {name}"),
        merge,
    }
}

fn default_branch() -> DefaultBranch {
    DefaultBranch {
        name: "main".into(),
        source: DefaultBranchSource::OriginHead,
        local: true,
        remote: Some("origin/main".into()),
    }
}

fn worktrees() -> Vec<Worktree> {
    vec![
        Worktree {
            path: path("C:\\Users\\dev\\repos\\app"),
            oid: Some(OID.into()),
            branch: Some("main".into()),
            detached: false,
            bare: false,
            locked: false,
            prunable: false,
            is_main: true,
        },
        Worktree {
            path: path("C:\\Users\\dev\\repos\\app-hotfix"),
            oid: None,
            branch: None,
            detached: true,
            bare: false,
            locked: true,
            prunable: true,
            is_main: false,
        },
    ]
}

fn every_reason() -> Vec<Reason> {
    vec![
        Reason::ScanError {
            message: "fatal: bad config line 1".into(),
        },
        Reason::Conflicts { count: 1 },
        Reason::DetachedHead,
        Reason::LostCommits { count: 2 },
        Reason::Staged { count: 3 },
        Reason::Unstaged { count: 4 },
        Reason::Untracked { count: 5 },
        Reason::Ahead { count: 6 },
        Reason::Behind { count: 7 },
        Reason::NoUpstream,
        Reason::UpstreamGone,
        Reason::NoRemote,
        Reason::UnmergedBranches { count: 8 },
        Reason::Stashes { count: 9 },
    ]
}

fn summaries() -> Vec<RepoSummary> {
    let main = RepoSummary {
        path: path("C:\\Users\\dev\\repos\\app"),
        name: "app".into(),
        kind: RepoKind::Main,
        head: Some(Head::Branch {
            name: "main".into(),
        }),
        oid: Some(OID.into()),
        upstream: Some(Upstream {
            name: "origin/main".into(),
            ahead: 2,
            behind: 1,
            gone: false,
        }),
        remotes: vec!["origin".into()],
        counts: ChangeCounts {
            staged: 1,
            unstaged: 2,
            untracked: 3,
            conflicted: 0,
        },
        stash_count: 1,
        last_commit: Some(LastCommit {
            oid: OID.into(),
            time: TIME,
            subject: "Add the dashboard".into(),
        }),
        default_branch: Some(default_branch()),
        branch_count: 3,
        unmerged_branches: vec![branch(
            "feature/ledger",
            Some(MergeState {
                ahead: 3,
                behind: 1,
            }),
        )],
        worktrees: worktrees(),
        lost_commits: Some(2),
        error: None,
        attention: Attention::from_reasons(every_reason()),
    };
    let worktree = RepoSummary {
        path: path("C:\\Users\\dev\\repos\\app-hotfix"),
        name: "app-hotfix".into(),
        kind: RepoKind::LinkedWorktree {
            common_dir: path("C:\\Users\\dev\\repos\\app\\.git"),
            main_path: Some(path("C:\\Users\\dev\\repos\\app")),
        },
        head: Some(Head::Detached),
        oid: Some(OID2.into()),
        upstream: None,
        remotes: vec![],
        counts: ChangeCounts::default(),
        stash_count: 0,
        last_commit: None,
        default_branch: None,
        branch_count: 0,
        unmerged_branches: vec![],
        worktrees: vec![],
        lost_commits: None,
        error: None,
        attention: Attention::from_reasons(vec![Reason::DetachedHead]),
    };
    let broken = RepoSummary {
        path: path("C:\\Users\\dev\\repos\\broken"),
        name: "broken".into(),
        kind: RepoKind::LinkedWorktree {
            common_dir: path("D:\\bare\\shared.git"),
            main_path: None,
        },
        head: None,
        oid: None,
        upstream: None,
        remotes: vec![],
        counts: ChangeCounts::default(),
        stash_count: 0,
        last_commit: None,
        default_branch: None,
        branch_count: 0,
        unmerged_branches: vec![],
        worktrees: vec![],
        lost_commits: Some(0),
        error: Some(GitError::Failed {
            code: Some(128),
            stderr: "fatal: bad config line 1".into(),
        }),
        attention: Attention::from_reasons(vec![Reason::ScanError {
            message: "fatal: bad config line 1".into(),
        }]),
    };
    let new_repo = RepoSummary {
        path: path("C:\\Users\\dev\\repos\\new"),
        name: "new".into(),
        kind: RepoKind::Main,
        head: Some(Head::Unborn {
            name: "main".into(),
        }),
        oid: None,
        upstream: None,
        remotes: vec![],
        counts: ChangeCounts::default(),
        stash_count: 0,
        last_commit: None,
        default_branch: Some(DefaultBranch {
            name: "master".into(),
            source: DefaultBranchSource::Conventional,
            local: false,
            remote: None,
        }),
        branch_count: 0,
        unmerged_branches: vec![],
        worktrees: vec![],
        lost_commits: None,
        error: None,
        attention: Attention::from_reasons(vec![]),
    };
    vec![main, worktree, broken, new_repo]
}

fn snapshot() -> ScanSnapshot {
    ScanSnapshot {
        generation: 3,
        scanned_at: 1_791_100_000_000,
        duration_ms: 412,
        roots: vec!["C:\\Users\\dev\\repos".into()],
        repos: summaries(),
        issues: vec![DiscoveryIssue {
            path: path("C:\\Users\\dev\\repos\\locked"),
            message: "cannot read folder: Access is denied. (os error 5)".into(),
        }],
        attention_count: 3,
    }
}

fn entry(kind: EntryKind, path: &str, index: FileChange, worktree: FileChange) -> StatusEntry {
    StatusEntry {
        kind,
        path: path.into(),
        original_path: (kind == EntryKind::Renamed).then(|| "old/name.ts".into()),
        index,
        worktree,
    }
}

fn detail() -> RepoDetail {
    use FileChange::*;
    RepoDetail {
        path: path("C:\\Users\\dev\\repos\\app"),
        name: "app".into(),
        kind: RepoKind::Main,
        status: RepoStatus {
            path: path("C:\\Users\\dev\\repos\\app"),
            remotes: vec!["origin".into()],
            report: StatusReport {
                oid: Some(OID.into()),
                head: Head::Branch {
                    name: "main".into(),
                },
                upstream: Some(Upstream {
                    name: "origin/main".into(),
                    ahead: 2,
                    behind: 0,
                    gone: false,
                }),
                stash_count: 1,
                counts: ChangeCounts {
                    staged: 3,
                    unstaged: 3,
                    untracked: 1,
                    conflicted: 1,
                },
                entries: vec![
                    entry(EntryKind::Changed, "src/a.ts", Modified, Unmodified),
                    entry(EntryKind::Changed, "src/b.ts", Unmodified, Deleted),
                    entry(EntryKind::Changed, "src/c.ts", Added, TypeChanged),
                    entry(EntryKind::Renamed, "src/new-name.ts", Renamed, Modified),
                    entry(EntryKind::Renamed, "src/copy.ts", Copied, Unmodified),
                    entry(EntryKind::Conflicted, "src/conflict.ts", Unmerged, Unmerged),
                    entry(EntryKind::Untracked, "notes/", Unmodified, Unmodified),
                ],
            },
        },
        branches: BranchReport {
            default_branch: Some(default_branch()),
            branches: vec![
                branch(
                    "feature/gone",
                    Some(MergeState {
                        ahead: 0,
                        behind: 4,
                    }),
                ),
                branch("main", None),
            ],
        },
        stashes: vec![Stash {
            index: 0,
            oid: OID2.into(),
            time: TIME,
            message: "On main: try the lanes layout".into(),
            parents: vec![OID.into(), OID2.into()],
        }],
        worktrees: worktrees(),
    }
}

fn file_diff() -> FileDiff {
    let line = |kind: LineKind, text: &str, old: Option<u32>, new: Option<u32>| DiffLine {
        kind,
        text: text.into(),
        old_line: old,
        new_line: new,
    };
    FileDiff {
        path: "src/a.ts".into(),
        side: DiffSide::Unstaged,
        binary: false,
        hunks: vec![Hunk {
            id: "1a2b3c4d5e6f7a8b".into(),
            header: "@@ -1,3 +1,3 @@ export function a()".into(),
            old_start: 1,
            old_lines: 3,
            new_start: 1,
            new_lines: 3,
            lines: vec![
                line(LineKind::Context, "export function a() {", Some(1), Some(1)),
                line(LineKind::Removed, "  return 1;", Some(2), None),
                line(LineKind::Added, "  return 2;", None, Some(2)),
                line(LineKind::Context, "}", Some(3), Some(3)),
                line(
                    LineKind::NoNewline,
                    "\\ No newline at end of file",
                    None,
                    None,
                ),
            ],
        }],
        truncated: false,
    }
}

fn lost_commits() -> LostCommits {
    LostCommits {
        commits: vec![
            LostCommit {
                oid: OID.into(),
                parents: vec![OID2.into()],
                time: TIME,
                author: "Dev <dev@example.invalid>".into(),
                subject: "Spike: tray badge".into(),
                origin: LostOrigin::Reflog,
            },
            LostCommit {
                oid: OID2.into(),
                parents: vec![],
                time: TIME - 86_400,
                author: "Dev <dev@example.invalid>".into(),
                subject: "WIP on main".into(),
                origin: LostOrigin::Dangling,
            },
        ],
        window_days: 30,
        truncated: true,
    }
}

fn git_errors() -> Vec<GitError> {
    vec![
        GitError::NotInstalled,
        GitError::InvalidPath {
            path: path("relative"),
            reason: "not absolute".into(),
        },
        GitError::NotARepository {
            path: path("C:\\x"),
        },
        GitError::DubiousOwnership {
            path: path("C:\\x"),
        },
        GitError::Refused {
            command: "git push --force".into(),
        },
        GitError::InvalidInput {
            field: "branch name".into(),
            reason: "must not start with -".into(),
        },
        GitError::NotFastForward,
        GitError::PushRejected {
            stderr: "! [rejected] main -> main (fetch first)".into(),
        },
        GitError::BranchNotMerged {
            branch: "feature/a".into(),
        },
        GitError::BranchExists {
            branch: "feature/a".into(),
        },
        GitError::DetachedHead,
        GitError::NoUpstream {
            branch: "feature/a".into(),
        },
        GitError::NoRemote,
        GitError::NothingToCommit,
        GitError::Stale {
            what: "the stash list".into(),
        },
        GitError::Io {
            message: "pipe closed".into(),
        },
        GitError::Failed {
            code: None,
            stderr: "killed".into(),
        },
        GitError::Parse {
            message: "malformed status".into(),
        },
    ]
}

fn command_errors() -> Vec<CommandError> {
    let mut errors: Vec<CommandError> = git_errors().into_iter().map(CommandError::from).collect();
    errors.extend([
        CommandError::UnknownRepo {
            path: "C:\\elsewhere".into(),
        },
        CommandError::Busy {
            path: "C:\\Users\\dev\\repos\\app".into(),
        },
        CommandError::InvalidSettings {
            field: "roots".into(),
            reason: "relative is not an absolute path".into(),
        },
        CommandError::NotScanned,
        CommandError::OpenFailed {
            target: "VS Code".into(),
            message: "VS Code's `code` command is not on PATH".into(),
        },
        CommandError::Io {
            message: "cannot save settings".into(),
        },
    ]);
    errors
}

fn settings() -> Settings {
    Settings {
        roots: vec![
            "C:\\Users\\dev\\Desktop".into(),
            "C:\\Users\\dev\\Documents".into(),
        ],
        excluded: vec!["C:\\Users\\dev\\Documents\\archive".into()],
        theme: Theme::System,
        density: Density::Comfortable,
        background_fetch: BackgroundFetch {
            enabled: false,
            interval_minutes: 30,
        },
        lost_commit_window_days: 30,
        close_to_tray: true,
    }
}

fn export<T: Serialize>(out: &mut String, name: &str, ty: &str, value: &T) {
    let json = serde_json::to_string_pretty(value).expect("serializable");
    out.push_str(&format!("export const {name}: {ty} = {json};\n\n"));
}

fn generate() -> String {
    let mut out = String::from(
        "// Generated by `npm run test:rust` (src-tauri/src/contract.rs) from the Rust\n\
         // types: one value of every IPC type and variant. Do not edit; regenerate with\n\
         // REPOWATCH_UPDATE_CONTRACT=1 npm run test:rust. `npm run typecheck` checks it\n\
         // against ./types.ts.\n\n\
         import type {\n  AppInfo,\n  AppStatus,\n  CommandError,\n  Density,\n  DiffSide,\n  FileDiff,\n  \
         LostCommits,\n  OpenTarget,\n  RepoDetail,\n  ScanSnapshot,\n  Settings,\n  Theme,\n} from './types';\n\n",
    );
    export(&mut out, "settings", "Settings", &settings());
    export(&mut out, "snapshot", "ScanSnapshot", &snapshot());
    export(&mut out, "repoDetail", "RepoDetail", &detail());
    export(&mut out, "fileDiff", "FileDiff", &file_diff());
    export(&mut out, "lostCommits", "LostCommits", &lost_commits());
    export(
        &mut out,
        "commandErrors",
        "CommandError[]",
        &command_errors(),
    );
    export(
        &mut out,
        "appStatus",
        "AppStatus",
        &AppStatus {
            scanning: true,
            watched_repos: 41,
            background_fetch_running: false,
            last_background_fetch_at: Some(1_791_100_000_000),
        },
    );
    export(
        &mut out,
        "appInfo",
        "AppInfo",
        &AppInfo {
            version: "0.1.0".into(),
            core_version: "0.1.0".into(),
            config_dir: "C:\\Users\\dev\\AppData\\Roaming\\io.github.nunomarques97.repowatch"
                .into(),
        },
    );
    export(
        &mut out,
        "diffSides",
        "DiffSide[]",
        &[DiffSide::Unstaged, DiffSide::Staged, DiffSide::Untracked],
    );
    export(
        &mut out,
        "openTargets",
        "OpenTarget[]",
        &[
            OpenTarget::VsCode,
            OpenTarget::Terminal,
            OpenTarget::FileManager,
        ],
    );
    export(
        &mut out,
        "themes",
        "Theme[]",
        &[Theme::System, Theme::Light, Theme::Dark],
    );
    export(
        &mut out,
        "densities",
        "Density[]",
        &[Density::Compact, Density::Comfortable],
    );
    out.truncate(out.trim_end().len());
    out.push('\n');
    out
}

fn contract_file() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/ipc/contract.generated.ts")
}

#[test]
fn the_typescript_contract_file_is_up_to_date() {
    let expected = generate();
    let file = contract_file();
    let update = std::env::var_os("REPOWATCH_UPDATE_CONTRACT").is_some_and(|v| v == "1");
    if update || !file.exists() {
        std::fs::write(&file, &expected).unwrap();
        return;
    }
    let actual = std::fs::read_to_string(&file)
        .unwrap()
        .replace("\r\n", "\n");
    assert!(
        actual == expected,
        "src/ipc/contract.generated.ts is out of date with the Rust types; \
         run REPOWATCH_UPDATE_CONTRACT=1 npm run test:rust and check `npm run typecheck`"
    );
}

#[test]
fn settings_from_the_frontend_deserialize() {
    // The frontend sends back what it received.
    let json = serde_json::to_string(&settings()).unwrap();
    assert_eq!(serde_json::from_str::<Settings>(&json).unwrap(), settings());
}

#[test]
fn every_command_has_exactly_one_permission() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let capability: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(manifest_dir.join("capabilities/default.json")).unwrap(),
    )
    .unwrap();
    let mut permissions: Vec<String> = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_string())
        .collect();
    permissions.sort();
    let mut expected: Vec<String> = crate::commands::COMMANDS
        .iter()
        .map(|command| format!("allow-{}", command.replace('_', "-")))
        .chain([
            "core:event:allow-listen".into(),
            "core:event:allow-unlisten".into(),
        ])
        .collect();
    expected.sort();
    assert_eq!(
        permissions, expected,
        "only event listening and the app's commands"
    );

    // build.rs declares the same commands in the ACL manifest.
    let build = std::fs::read_to_string(manifest_dir.join("build.rs")).unwrap();
    for command in crate::commands::COMMANDS {
        assert!(
            build.contains(&format!("\"{command}\"")),
            "{command} missing in build.rs"
        );
    }
    // lib.rs registers every command.
    let lib = std::fs::read_to_string(manifest_dir.join("src/lib.rs")).unwrap();
    for command in crate::commands::COMMANDS {
        assert!(
            lib.contains(&format!("commands::{command},")),
            "{command} not registered"
        );
    }
}

#[test]
fn the_content_security_policy_is_strict() {
    let config: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json"))
            .unwrap(),
    )
    .unwrap();
    let security = &config["app"]["security"];
    let csp = security["csp"].as_str().unwrap();
    for directive in [
        "default-src 'self'",
        "script-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "connect-src ipc: http://ipc.localhost",
    ] {
        assert!(csp.contains(directive), "{directive}");
    }
    for loose in ["unsafe-inline", "unsafe-eval", "http:", "https:", "*"] {
        assert!(
            !csp.replace("http://ipc.localhost", "").contains(loose),
            "{loose} in the CSP"
        );
    }
    assert_eq!(security["freezePrototype"], serde_json::Value::Bool(true));
    assert_eq!(config["app"]["withGlobalTauri"], serde_json::Value::Null);
}

#[test]
fn diff_sides_round_trip_as_command_arguments() {
    for side in [DiffSide::Unstaged, DiffSide::Staged, DiffSide::Untracked] {
        let json = serde_json::to_string(&side).unwrap();
        let arg: crate::commands::Side = serde_json::from_str(&json).unwrap();
        assert_eq!(DiffSide::from(arg), side);
    }
    assert!(serde_json::from_str::<crate::commands::Side>("\"both\"").is_err());
}
