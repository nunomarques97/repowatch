//! Shared fixture set for integration tests.
//!
//! `scripts/make-fixtures.mjs` builds the fixture repositories once per test
//! binary in a fresh folder inside the OS temp folder. Tests read them with a
//! [`Git`] isolated from the user's system and global config.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

use repowatch_core::Git;

const PREFIX: &str = "repowatch-core-tests-";

pub struct Fixtures {
    /// The folder the script created.
    pub out: PathBuf,
    /// The discovery root (`<out>/repos`).
    pub root: PathBuf,
    pub manifest: serde_json::Value,
    pub git: Git,
}

impl Fixtures {
    pub fn repo(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    pub fn manifest_paths(&self, field: &str) -> Vec<PathBuf> {
        self.manifest[field]
            .as_array()
            .unwrap_or_else(|| panic!("manifest has no {field}"))
            .iter()
            .map(|value| PathBuf::from(value.as_str().unwrap()))
            .collect()
    }
}

pub fn fixtures() -> &'static Fixtures {
    static FIXTURES: OnceLock<Fixtures> = OnceLock::new();
    FIXTURES.get_or_init(build)
}

pub fn script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/make-fixtures.mjs")
}

/// A git isolated from the user's config, as the fixture script uses.
pub fn isolated_git(out: &Path) -> Git {
    let env_dir = out.join("git-env");
    Git::new()
        .with_env("GIT_CONFIG_NOSYSTEM", "1")
        .with_env("GIT_CONFIG_GLOBAL", env_dir.join("gitconfig"))
        .with_env("HOME", env_dir.join("home"))
        .with_env("XDG_CONFIG_HOME", env_dir.join("xdg"))
}

fn build() -> Fixtures {
    let temp = std::env::temp_dir();
    remove_stale(&temp);
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    let out = temp.join(format!("{PREFIX}{}-{nanos}", std::process::id()));
    let output = Command::new("node")
        .arg(script())
        .arg("--out")
        .arg(&out)
        .arg("--quiet")
        .output()
        .expect("node must be installed to build the fixtures");
    assert!(
        output.status.success(),
        "make-fixtures failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let manifest_path = PathBuf::from(String::from_utf8(output.stdout).unwrap().trim());
    let manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&manifest_path).unwrap()).unwrap();
    // The script resolves the real path of the temp folder.
    let root = PathBuf::from(manifest["root"].as_str().unwrap());
    let out = root.parent().unwrap().to_path_buf();
    let git = isolated_git(&out);
    Fixtures {
        out,
        root,
        manifest,
        git,
    }
}

/// Removes fixture folders of earlier test runs (older than an hour and
/// carrying the script's marker file).
fn remove_stale(temp: &Path) {
    let Ok(entries) = std::fs::read_dir(temp) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_old = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > Duration::from_secs(3600));
        if entry.file_name().to_string_lossy().starts_with(PREFIX)
            && is_old
            && path.join(".repowatch-fixtures").is_file()
        {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}
