//! User settings, persisted as JSON in the per-user config folder.
//!
//! The folder is `<config dir>/io.github.nunomarques97.repowatch` (the
//! Tauri app config folder), or the folder named by `REPOWATCH_CONFIG_DIR`.
//! Tests and the end-to-end run set that variable to a temporary folder;
//! with an overridden folder the default roots are empty, so a test run
//! never scans the user's real repositories unless it names them.
//!
//! Every value from the frontend or from the file is validated; a file that
//! cannot be read is kept aside as `settings.invalid.json` and the defaults
//! are used, so a bad file is never silently overwritten.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::CommandError;

/// Environment variable that replaces the config folder.
pub const CONFIG_DIR_ENV: &str = "REPOWATCH_CONFIG_DIR";
/// Folder name under the OS config folder (the bundle identifier).
pub const APP_DIR_NAME: &str = "io.github.nunomarques97.repowatch";
const FILE_NAME: &str = "settings.json";
const INVALID_FILE_NAME: &str = "settings.invalid.json";

pub const MAX_PATHS: usize = 64;
pub const MAX_PATH_CHARS: usize = 1024;
pub const MIN_FETCH_INTERVAL_MINUTES: u32 = 5;
pub const MAX_FETCH_INTERVAL_MINUTES: u32 = 24 * 60;
pub const DEFAULT_FETCH_INTERVAL_MINUTES: u32 = 30;
pub const MIN_LOST_WINDOW_DAYS: u32 = 1;
pub const MAX_LOST_WINDOW_DAYS: u32 = 365;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    /// Follow the OS light/dark setting.
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Density {
    #[default]
    Compact,
    Comfortable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BackgroundFetch {
    /// Off by default: the app only fetches when the user asks.
    pub enabled: bool,
    pub interval_minutes: u32,
}

impl Default for BackgroundFetch {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_minutes: DEFAULT_FETCH_INTERVAL_MINUTES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Folders searched for repositories.
    pub roots: Vec<String>,
    /// Folders skipped with everything below them.
    pub excluded: Vec<String>,
    pub theme: Theme,
    pub density: Density,
    pub background_fetch: BackgroundFetch,
    /// Age limit of the commits shown as lost.
    pub lost_commit_window_days: u32,
    /// Closing the window keeps the app running in the tray.
    pub close_to_tray: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            roots: Vec::new(),
            excluded: Vec::new(),
            theme: Theme::default(),
            density: Density::default(),
            background_fetch: BackgroundFetch::default(),
            lost_commit_window_days: repowatch_core::lost::DEFAULT_WINDOW_DAYS,
            close_to_tray: true,
        }
    }
}

impl Settings {
    /// Defaults with the user's Desktop and Documents folders as roots, when
    /// they exist.
    pub fn with_default_roots(candidates: &[Option<PathBuf>]) -> Self {
        let mut roots: Vec<String> = Vec::new();
        for path in candidates.iter().flatten().filter(|path| path.is_dir()) {
            let Some(text) = path.to_str() else { continue };
            if !roots.iter().any(|root| same_path(root, text)) {
                roots.push(text.to_string());
            }
        }
        Self {
            roots,
            ..Self::default()
        }
    }

    /// Checks every value and returns the normalized settings: paths
    /// trimmed, duplicates removed (ignoring case on Windows).
    pub fn validated(mut self) -> Result<Self, CommandError> {
        self.roots = validated_paths("roots", self.roots)?;
        self.excluded = validated_paths("excluded", self.excluded)?;
        let interval = self.background_fetch.interval_minutes;
        if !(MIN_FETCH_INTERVAL_MINUTES..=MAX_FETCH_INTERVAL_MINUTES).contains(&interval) {
            return Err(invalid(
                "backgroundFetch.intervalMinutes",
                format!(
                    "must be between {MIN_FETCH_INTERVAL_MINUTES} and {MAX_FETCH_INTERVAL_MINUTES}"
                ),
            ));
        }
        let days = self.lost_commit_window_days;
        if !(MIN_LOST_WINDOW_DAYS..=MAX_LOST_WINDOW_DAYS).contains(&days) {
            return Err(invalid(
                "lostCommitWindowDays",
                format!("must be between {MIN_LOST_WINDOW_DAYS} and {MAX_LOST_WINDOW_DAYS}"),
            ));
        }
        Ok(self)
    }

    pub fn root_paths(&self) -> Vec<PathBuf> {
        self.roots.iter().map(PathBuf::from).collect()
    }

    pub fn excluded_paths(&self) -> Vec<PathBuf> {
        self.excluded.iter().map(PathBuf::from).collect()
    }
}

fn invalid(field: &str, reason: impl Into<String>) -> CommandError {
    CommandError::InvalidSettings {
        field: field.to_string(),
        reason: reason.into(),
    }
}

fn validated_paths(field: &str, paths: Vec<String>) -> Result<Vec<String>, CommandError> {
    if paths.len() > MAX_PATHS {
        return Err(invalid(field, format!("at most {MAX_PATHS} folders")));
    }
    let mut result: Vec<String> = Vec::new();
    for path in paths {
        let path = path.trim().to_string();
        if path.is_empty() {
            return Err(invalid(field, "a folder is empty"));
        }
        if path.chars().count() > MAX_PATH_CHARS {
            return Err(invalid(field, format!("{path:.40}... is too long")));
        }
        if path.chars().any(char::is_control) {
            return Err(invalid(field, "a folder contains control characters"));
        }
        if !Path::new(&path).is_absolute() {
            return Err(invalid(field, format!("{path} is not an absolute path")));
        }
        if !result.iter().any(|known| same_path(known, &path)) {
            result.push(path);
        }
    }
    Ok(result)
}

/// Paths are compared ignoring case and trailing separators on Windows.
fn same_path(a: &str, b: &str) -> bool {
    let trim = |path: &str| path.trim_end_matches(['/', '\\']).to_string();
    if cfg!(windows) {
        trim(a).replace('/', "\\").to_lowercase() == trim(b).replace('/', "\\").to_lowercase()
    } else {
        trim(a) == trim(b)
    }
}

/// Reads and writes the settings file.
#[derive(Debug, Clone)]
pub struct SettingsStore {
    dir: PathBuf,
    /// The folder came from [`CONFIG_DIR_ENV`].
    overridden: bool,
}

impl SettingsStore {
    /// The store named by [`CONFIG_DIR_ENV`], or the per-user config folder.
    pub fn from_environment() -> Result<Self, CommandError> {
        match std::env::var_os(CONFIG_DIR_ENV).filter(|value| !value.is_empty()) {
            Some(dir) => {
                let dir = PathBuf::from(dir);
                if !dir.is_absolute() {
                    return Err(invalid(CONFIG_DIR_ENV, "must be an absolute path"));
                }
                Ok(Self::overridden(dir))
            }
            None => dirs::config_dir()
                .map(|dir| Self {
                    dir: dir.join(APP_DIR_NAME),
                    overridden: false,
                })
                .ok_or_else(|| CommandError::Io {
                    message: "the user config folder is unknown".into(),
                }),
        }
    }

    /// A store in `dir` that behaves like an overridden folder (no default
    /// roots).
    pub fn overridden(dir: PathBuf) -> Self {
        Self {
            dir,
            overridden: true,
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn file(&self) -> PathBuf {
        self.dir.join(FILE_NAME)
    }

    /// The settings for a first run.
    pub fn defaults(&self) -> Settings {
        if self.overridden {
            Settings::default()
        } else {
            Settings::with_default_roots(&[dirs::desktop_dir(), dirs::document_dir()])
        }
    }

    /// Loads the settings. A missing file gives the defaults; an unreadable
    /// or invalid one is moved aside and gives the defaults too.
    pub fn load(&self) -> Settings {
        let file = self.file();
        let text = match fs::read_to_string(&file) {
            Ok(text) => text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return self.defaults(),
            Err(_) => return self.set_aside(&file),
        };
        match serde_json::from_str::<Settings>(&text)
            .ok()
            .and_then(|settings| settings.validated().ok())
        {
            Some(settings) => settings,
            None => self.set_aside(&file),
        }
    }

    fn set_aside(&self, file: &Path) -> Settings {
        // Best effort: if the rename fails, the next save replaces the file.
        let _ = fs::rename(file, self.dir.join(INVALID_FILE_NAME));
        self.defaults()
    }

    /// Writes the settings atomically (temporary file, then rename).
    pub fn save(&self, settings: &Settings) -> Result<(), CommandError> {
        let io_error = |error: io::Error| CommandError::Io {
            message: format!("cannot save settings in {}: {error}", self.dir.display()),
        };
        fs::create_dir_all(&self.dir).map_err(io_error)?;
        let text = serde_json::to_string_pretty(settings).map_err(|error| CommandError::Io {
            message: error.to_string(),
        })?;
        let temp = self.dir.join(format!("{FILE_NAME}.tmp"));
        fs::write(&temp, text).map_err(io_error)?;
        fs::rename(&temp, self.file()).map_err(io_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_dir;

    fn absolute(name: &str) -> String {
        std::env::temp_dir()
            .join(name)
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn defaults_have_background_fetch_off_and_a_30_day_window() {
        let settings = Settings::default();
        assert!(!settings.background_fetch.enabled);
        assert_eq!(settings.background_fetch.interval_minutes, 30);
        assert_eq!(settings.lost_commit_window_days, 30);
        assert_eq!(settings.theme, Theme::System);
        assert_eq!(settings.density, Density::Compact);
        assert!(settings.close_to_tray);
        assert!(settings.roots.is_empty());
    }

    #[test]
    fn default_roots_keep_existing_folders_once() {
        let dir = temp_dir("default-roots");
        let desktop = dir.join("Desktop");
        fs::create_dir_all(&desktop).unwrap();
        let settings = Settings::with_default_roots(&[
            Some(desktop.clone()),
            Some(dir.join("Documents-missing")),
            None,
            Some(desktop.clone()),
        ]);
        assert_eq!(settings.roots, vec![desktop.to_string_lossy().into_owned()]);
    }

    #[test]
    fn overridden_store_has_no_default_roots() {
        let store = SettingsStore::overridden(temp_dir("no-default-roots"));
        assert!(store.load().roots.is_empty());
    }

    #[test]
    fn settings_round_trip_through_the_file() {
        let store = SettingsStore::overridden(temp_dir("round-trip"));
        let settings = Settings {
            roots: vec![absolute("a")],
            excluded: vec![absolute("a/b")],
            theme: Theme::Dark,
            density: Density::Comfortable,
            background_fetch: BackgroundFetch {
                enabled: true,
                interval_minutes: 15,
            },
            lost_commit_window_days: 90,
            close_to_tray: false,
        };
        store.save(&settings).unwrap();
        assert_eq!(store.load(), settings);
        assert!(!store.dir().join("settings.json.tmp").exists());
    }

    #[test]
    fn missing_fields_take_defaults() {
        let store = SettingsStore::overridden(temp_dir("partial"));
        fs::create_dir_all(store.dir()).unwrap();
        fs::write(store.file(), r#"{"theme":"light"}"#).unwrap();
        let settings = store.load();
        assert_eq!(settings.theme, Theme::Light);
        assert!(!settings.background_fetch.enabled);
        assert_eq!(settings.lost_commit_window_days, 30);
    }

    #[test]
    fn an_invalid_file_is_kept_aside_and_defaults_are_used() {
        let store = SettingsStore::overridden(temp_dir("invalid"));
        fs::create_dir_all(store.dir()).unwrap();
        fs::write(store.file(), "{ not json").unwrap();
        assert_eq!(store.load(), Settings::default());
        assert!(!store.file().exists());
        let kept = fs::read_to_string(store.dir().join(INVALID_FILE_NAME)).unwrap();
        assert_eq!(kept, "{ not json");

        // Valid JSON with an out-of-range value is rejected the same way.
        fs::write(store.file(), r#"{"lostCommitWindowDays":0}"#).unwrap();
        assert_eq!(store.load(), Settings::default());
    }

    #[test]
    fn validation_normalizes_paths() {
        let root = absolute("root");
        let settings = Settings {
            roots: vec![format!("  {root}  "), root.clone()],
            ..Settings::default()
        }
        .validated()
        .unwrap();
        assert_eq!(settings.roots, vec![root]);
    }

    #[test]
    fn validation_rejects_bad_values() {
        let field = |settings: Settings| match settings.validated() {
            Err(CommandError::InvalidSettings { field, .. }) => field,
            other => panic!("expected invalid settings, got {other:?}"),
        };
        let with_roots = |roots: Vec<String>| Settings {
            roots,
            ..Settings::default()
        };
        assert_eq!(field(with_roots(vec!["relative/path".into()])), "roots");
        assert_eq!(field(with_roots(vec!["   ".into()])), "roots");
        assert_eq!(field(with_roots(vec![absolute("x\ty")])), "roots");
        assert_eq!(
            field(with_roots(vec![absolute(&"x".repeat(1100))])),
            "roots"
        );
        assert_eq!(
            field(with_roots(vec![absolute("x"); MAX_PATHS + 1])),
            "roots"
        );
        assert_eq!(
            field(Settings {
                excluded: vec!["..".into()],
                ..Settings::default()
            }),
            "excluded"
        );
        for minutes in [0, 4, 24 * 60 + 1] {
            let settings = Settings {
                background_fetch: BackgroundFetch {
                    enabled: true,
                    interval_minutes: minutes,
                },
                ..Settings::default()
            };
            assert_eq!(field(settings), "backgroundFetch.intervalMinutes");
        }
        for days in [0, 366] {
            let settings = Settings {
                lost_commit_window_days: days,
                ..Settings::default()
            };
            assert_eq!(field(settings), "lostCommitWindowDays");
        }
    }

    #[test]
    fn unknown_enum_values_are_rejected_by_deserialization() {
        assert!(serde_json::from_str::<Settings>(r#"{"theme":"neon"}"#).is_err());
        assert!(serde_json::from_str::<Settings>(r#"{"roots":"C:\\"}"#).is_err());
    }
}
