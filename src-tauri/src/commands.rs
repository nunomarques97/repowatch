//! Tauri commands: thin wrappers that run [`AppState`] work on a blocking
//! thread so git never runs on the UI or async threads.
//!
//! Names and argument names are the IPC contract mirrored in `src/ipc/`
//! (Tauri maps camelCase arguments from JavaScript to these snake_case
//! names). Events: [`EVENT_SNAPSHOT`], [`EVENT_STATUS`], [`EVENT_SETTINGS`].

use std::sync::Arc;

use repowatch_core::{DiffSide, FileDiff, LostCommits};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::CommandError;
use crate::open::OpenTarget;
use crate::scanner::ScanSnapshot;
use crate::settings::Settings;
use crate::state::{AppState, AppStatus, RepoDetail};

/// A new [`ScanSnapshot`] (full scan or refresh).
pub const EVENT_SNAPSHOT: &str = "snapshot";
/// A new [`AppStatus`].
pub const EVENT_STATUS: &str = "status";
/// Settings were saved.
pub const EVENT_SETTINGS: &str = "settings";

pub type Shared<'a> = State<'a, Arc<AppState>>;
type Result<T> = std::result::Result<T, CommandError>;

async fn blocking<T: Send + 'static>(
    state: &Shared<'_>,
    work: impl FnOnce(&AppState) -> Result<T> + Send + 'static,
) -> Result<T> {
    let state = Arc::clone(state);
    tauri::async_runtime::spawn_blocking(move || work(&state))
        .await
        .map_err(|error| CommandError::Io {
            message: format!("the command stopped: {error}"),
        })?
}

/// [`DiffSide`] as a command argument (the core type is output only).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Side {
    Unstaged,
    Staged,
    Untracked,
}

impl From<Side> for DiffSide {
    fn from(side: Side) -> Self {
        match side {
            Side::Unstaged => Self::Unstaged,
            Side::Staged => Self::Staged,
            Side::Untracked => Self::Untracked,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub core_version: String,
    pub config_dir: String,
}

#[tauri::command]
pub fn app_info(state: Shared<'_>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        core_version: repowatch_core::VERSION.into(),
        config_dir: state.config_dir().to_string_lossy().into_owned(),
    }
}

#[tauri::command]
pub fn get_settings(state: Shared<'_>) -> Settings {
    state.settings()
}

/// Saves settings; [`AppState`] announces them as [`EVENT_SETTINGS`].
#[tauri::command]
pub async fn update_settings(state: Shared<'_>, settings: Settings) -> Result<Settings> {
    blocking(&state, move |state| state.update_settings(settings)).await
}

#[tauri::command]
pub fn get_status(state: Shared<'_>) -> AppStatus {
    state.status()
}

/// The last snapshot, without scanning; `None` before the first scan ends.
#[tauri::command]
pub fn get_snapshot(state: Shared<'_>) -> Option<ScanSnapshot> {
    state.snapshot().map(|snapshot| (*snapshot).clone())
}

/// Scans now (joining a scan that is already queued) and returns the result.
#[tauri::command]
pub async fn scan(state: Shared<'_>) -> Result<ScanSnapshot> {
    blocking(&state, |state| {
        state.scan().map(|snapshot| (*snapshot).clone())
    })
    .await
}

#[tauri::command]
pub async fn repo_detail(state: Shared<'_>, repo: String) -> Result<RepoDetail> {
    blocking(&state, move |state| state.repo_detail(&repo)).await
}

#[tauri::command]
pub async fn file_diff(
    state: Shared<'_>,
    repo: String,
    path: String,
    side: Side,
) -> Result<FileDiff> {
    blocking(&state, move |state| {
        state.file_diff(&repo, &path, side.into())
    })
    .await
}

#[tauri::command]
pub async fn lost_commits(state: Shared<'_>, repo: String) -> Result<LostCommits> {
    blocking(&state, move |state| state.lost_commits(&repo)).await
}

#[tauri::command]
pub async fn stage_file(state: Shared<'_>, repo: String, path: String) -> Result<()> {
    blocking(&state, move |state| {
        state.act(&repo, |git, dir| {
            repowatch_core::stage_file(git, dir, &path)
        })
    })
    .await
}

#[tauri::command]
pub async fn unstage_file(state: Shared<'_>, repo: String, path: String) -> Result<()> {
    blocking(&state, move |state| {
        state.act(&repo, |git, dir| {
            repowatch_core::unstage_file(git, dir, &path)
        })
    })
    .await
}

#[tauri::command]
pub async fn stage_hunk(
    state: Shared<'_>,
    repo: String,
    path: String,
    hunk_id: String,
) -> Result<()> {
    blocking(&state, move |state| {
        state.act(&repo, |git, dir| {
            repowatch_core::stage_hunk(git, dir, &path, &hunk_id)
        })
    })
    .await
}

#[tauri::command]
pub async fn unstage_hunk(
    state: Shared<'_>,
    repo: String,
    path: String,
    hunk_id: String,
) -> Result<()> {
    blocking(&state, move |state| {
        state.act(&repo, |git, dir| {
            repowatch_core::unstage_hunk(git, dir, &path, &hunk_id)
        })
    })
    .await
}

#[tauri::command]
pub async fn commit(state: Shared<'_>, repo: String, message: String) -> Result<()> {
    blocking(&state, move |state| {
        state.act(&repo, |git, dir| repowatch_core::commit(git, dir, &message))
    })
    .await
}

#[tauri::command]
pub async fn fetch(state: Shared<'_>, repo: String) -> Result<()> {
    blocking(&state, move |state| {
        state.act(&repo, |git, dir| repowatch_core::fetch(git, dir, None))
    })
    .await
}

#[tauri::command]
pub async fn pull(state: Shared<'_>, repo: String) -> Result<()> {
    blocking(&state, move |state| state.act(&repo, repowatch_core::pull)).await
}

#[tauri::command]
pub async fn push(state: Shared<'_>, repo: String) -> Result<()> {
    blocking(&state, move |state| state.act(&repo, repowatch_core::push)).await
}

#[tauri::command]
pub async fn create_branch(
    state: Shared<'_>,
    repo: String,
    name: String,
    start: Option<String>,
) -> Result<()> {
    blocking(&state, move |state| {
        state.act(&repo, |git, dir| {
            repowatch_core::create_branch(git, dir, &name, start.as_deref())
        })
    })
    .await
}

#[tauri::command]
pub async fn switch_branch(state: Shared<'_>, repo: String, name: String) -> Result<()> {
    blocking(&state, move |state| {
        state.act(&repo, |git, dir| {
            repowatch_core::switch_branch(git, dir, &name)
        })
    })
    .await
}

#[tauri::command]
pub async fn delete_branch(state: Shared<'_>, repo: String, name: String) -> Result<()> {
    blocking(&state, move |state| {
        state.act(&repo, |git, dir| {
            repowatch_core::delete_merged_branch(git, dir, &name)
        })
    })
    .await
}

#[tauri::command]
pub async fn apply_stash(state: Shared<'_>, repo: String, index: u32, oid: String) -> Result<()> {
    blocking(&state, move |state| {
        state.act(&repo, |git, dir| {
            repowatch_core::apply_stash(git, dir, index, &oid)
        })
    })
    .await
}

#[tauri::command]
pub async fn drop_stash(state: Shared<'_>, repo: String, index: u32, oid: String) -> Result<()> {
    blocking(&state, move |state| {
        state.act(&repo, |git, dir| {
            repowatch_core::drop_stash(git, dir, index, &oid)
        })
    })
    .await
}

#[tauri::command]
pub async fn recover_commit(
    state: Shared<'_>,
    repo: String,
    oid: String,
    branch: String,
) -> Result<()> {
    blocking(&state, move |state| {
        state.act(&repo, |git, dir| {
            repowatch_core::recover_commit(git, dir, &oid, &branch)
        })
    })
    .await
}

#[tauri::command]
pub async fn open_repo(state: Shared<'_>, repo: String, target: OpenTarget) -> Result<()> {
    blocking(&state, move |state| state.open(&repo, target)).await
}

/// Shows the native folder picker (for roots and exclusions); `None` when
/// cancelled.
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Result<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Choose a folder")
            .blocking_pick_folder()
            .and_then(|path| path.into_path().ok())
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| CommandError::Io {
        message: format!("the folder picker stopped: {error}"),
    })
}

/// Every command; tests check it against `lib.rs`, `build.rs` and the
/// capability file.
#[cfg(test)]
pub const COMMANDS: &[&str] = &[
    "app_info",
    "get_settings",
    "update_settings",
    "get_status",
    "get_snapshot",
    "scan",
    "repo_detail",
    "file_diff",
    "lost_commits",
    "stage_file",
    "unstage_file",
    "stage_hunk",
    "unstage_hunk",
    "commit",
    "fetch",
    "pull",
    "push",
    "create_branch",
    "switch_branch",
    "delete_branch",
    "apply_stash",
    "drop_stash",
    "recover_commit",
    "open_repo",
    "pick_folder",
];
