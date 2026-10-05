//! Tauri application shell for Repowatch: the IPC commands, settings, scans,
//! change watching, background fetch and the tray icon around
//! `repowatch-core`.

mod background;
mod commands;
mod error;
mod open;
mod scanner;
mod settings;
mod state;
mod tray;
mod watcher;

#[cfg(test)]
mod contract;
#[cfg(test)]
mod test_support;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use repowatch_core::Git;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

use background::{BackgroundFetch, FIRST_FETCH_DELAY, FetchEvent, GitFetcher, fetch_targets};
use commands::{EVENT_SETTINGS, EVENT_SNAPSHOT, EVENT_STATUS};
use scanner::{GitBackend, ScanEvent, Scanner, lock};
use settings::{Settings, SettingsStore};
use state::{AppState, StatusBoard};
use watcher::{Debounce, RepoWatcher};

/// Full rescans also run on this period, to find new repositories.
const RESCAN_INTERVAL: Duration = Duration::from_secs(10 * 60);

/// Builds and runs the Tauri application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            setup(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let close_to_tray = window
                    .try_state::<Arc<AppState>>()
                    .is_some_and(|state| state.settings().close_to_tray);
                if close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::get_settings,
            commands::update_settings,
            commands::get_status,
            commands::get_snapshot,
            commands::scan,
            commands::repo_detail,
            commands::file_diff,
            commands::lost_commits,
            commands::stage_file,
            commands::unstage_file,
            commands::stage_hunk,
            commands::unstage_hunk,
            commands::commit,
            commands::fetch,
            commands::pull,
            commands::push,
            commands::create_branch,
            commands::switch_branch,
            commands::delete_branch,
            commands::apply_stash,
            commands::drop_stash,
            commands::recover_commit,
            commands::open_repo,
            commands::pick_folder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Repowatch application");
}

fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let store = SettingsStore::from_environment()?;
    let settings = store.load();
    let git = Git::new();

    let status = {
        let app = app.clone();
        Arc::new(StatusBoard::new(move |status| {
            let _ = app.emit(EVENT_STATUS, status);
        }))
    };
    let watcher = Arc::new(Mutex::new(RepoWatcher::idle()));

    // The scanner announces snapshots, updates the tray badge, and after a
    // full scan watches the new set of repositories.
    let scanner = Arc::new_cyclic(|weak: &std::sync::Weak<Scanner>| {
        let app = app.clone();
        let status = Arc::clone(&status);
        let watcher = Arc::clone(&watcher);
        let weak = weak.clone();
        Scanner::start(GitBackend(git.clone()), move |event| match event {
            ScanEvent::Started => status.update(|status| status.scanning = true),
            ScanEvent::Finished(snapshot, repos) => {
                let refresh = weak.clone();
                let next = RepoWatcher::start(&repos, Debounce::default(), move |keys| {
                    if let Some(scanner) = refresh.upgrade() {
                        scanner.request_refresh(keys);
                    }
                });
                let watched = u32::try_from(next.watched()).unwrap_or(u32::MAX);
                *lock(&watcher) = next;
                let scanning = weak.upgrade().is_some_and(|scanner| scanner.is_scanning());
                status.update(|status| {
                    status.scanning = scanning;
                    status.watched_repos = watched;
                });
                tray::set_count(&app, snapshot.attention_count);
                let _ = app.emit(EVENT_SNAPSHOT, &*snapshot);
            }
            ScanEvent::Updated(snapshot) => {
                tray::set_count(&app, snapshot.attention_count);
                let _ = app.emit(EVENT_SNAPSHOT, &*snapshot);
            }
        })
    });

    let background = {
        let targets_scanner = Arc::downgrade(&scanner);
        let refresh_scanner = Arc::downgrade(&scanner);
        let status = Arc::clone(&status);
        BackgroundFetch::start(
            GitFetcher::new(git.clone()),
            FIRST_FETCH_DELAY,
            move || {
                targets_scanner
                    .upgrade()
                    .and_then(|scanner| {
                        let snapshot = scanner.snapshot()?;
                        Some(fetch_targets(&scanner.repos(), &snapshot))
                    })
                    .unwrap_or_default()
            },
            move |event| match event {
                FetchEvent::Started => {
                    status.update(|status| status.background_fetch_running = true)
                }
                FetchEvent::Finished(affected) => {
                    status.background_fetch_finished();
                    if let Some(scanner) = refresh_scanner.upgrade() {
                        scanner.request_refresh(affected);
                    }
                }
            },
        )
    };

    let state = Arc::new(AppState::new(
        git,
        store,
        settings,
        Arc::clone(&scanner),
        Some(background),
        status,
        {
            let app = app.clone();
            move |settings: &Settings| {
                let _ = app.emit(EVENT_SETTINGS, settings);
            }
        },
    ));
    app.manage(Arc::clone(&state));

    tray::create(app, |app, id| match id {
        tray::MENU_SHOW => tray::show_main_window(app),
        tray::MENU_RESCAN => {
            if let Some(state) = app.try_state::<Arc<AppState>>() {
                state.scanner().request_scan();
            }
        }
        tray::MENU_QUIT => app.exit(0),
        _ => {}
    })?;

    // First scan at start-up, then a periodic rescan for new repositories.
    scanner.request_scan();
    let periodic = Arc::downgrade(&scanner);
    std::thread::Builder::new()
        .name("repowatch-rescan".into())
        .spawn(move || {
            loop {
                std::thread::sleep(RESCAN_INTERVAL);
                match periodic.upgrade() {
                    Some(scanner) => {
                        scanner.request_scan();
                    }
                    None => break,
                }
            }
        })?;

    // Saved settings are announced so every view can follow them.
    state.announce_settings();
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn core_version_is_linked() {
        assert_eq!(repowatch_core::VERSION, env!("CARGO_PKG_VERSION"));
    }
}
