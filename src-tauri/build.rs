// The app's commands are declared in an ACL manifest, so each one needs an
// explicit `allow-<command>` permission in `capabilities/`. Keep this list
// in sync with `commands::COMMANDS` (a unit test checks it).
const COMMANDS: &[&str] = &[
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

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run the Tauri build script");
}
