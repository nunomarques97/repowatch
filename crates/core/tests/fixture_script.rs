//! Safety of `scripts/make-fixtures.mjs`: it writes only inside the OS temp
//! folder and only into folders it owns.

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn run_script(out: &Path) -> Output {
    Command::new("node")
        .arg(common::script())
        .arg("--out")
        .arg(out)
        .arg("--quiet")
        .output()
        .expect("node")
}

fn temp_dir(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("repowatch-script-{name}-{}", std::process::id()))
}

#[test]
fn refuses_targets_outside_the_temp_folder() {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let inside_project = repo_root.join("fixture-target-must-not-exist");
    let temp = std::env::temp_dir();
    let escaping = temp.join("..").join("repowatch-escape-must-not-exist");
    for target in [
        inside_project.clone(),
        escaping.clone(),
        temp.clone(),
        PathBuf::from("relative-target"),
    ] {
        let output = run_script(&target);
        assert!(
            !output.status.success(),
            "{} was accepted",
            target.display()
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("refusing"), "{stderr}");
    }
    assert!(!inside_project.exists());
    assert!(!escaping.exists());
    assert!(!Path::new("relative-target").exists());
}

#[test]
fn refuses_a_non_empty_folder_it_did_not_create() {
    let target = temp_dir("foreign");
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("precious.txt"), "keep me").unwrap();
    let output = run_script(&target);
    assert!(!output.status.success());
    assert_eq!(
        fs::read_to_string(target.join("precious.txt")).unwrap(),
        "keep me"
    );
    assert_eq!(fs::read_dir(&target).unwrap().count(), 1);
    fs::remove_dir_all(&target).unwrap();
}

#[test]
fn rejects_unknown_arguments_and_bad_counts() {
    for args in [
        &["--bogus"][..],
        &["--count", "-1"],
        &["--count", "many"],
        &["--out"],
    ] {
        let output = Command::new("node")
            .arg(common::script())
            .args(args)
            .output()
            .expect("node");
        assert!(!output.status.success(), "{args:?} was accepted");
    }
}

#[test]
fn count_pads_with_bulk_repositories_and_reruns_replace_its_own_folder() {
    let target = temp_dir("count");
    let _ = fs::remove_dir_all(&target);
    let minimum = {
        let output = run_script(&target);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        manifest_discovered(&output).len()
    };
    // A second run replaces the folder (it carries the marker file).
    let output = Command::new("node")
        .arg(common::script())
        .arg("--out")
        .arg(&target)
        .args(["--count", &(minimum + 3).to_string(), "--quiet"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let discovered = manifest_discovered(&output);
    assert_eq!(discovered.len(), minimum + 3);
    assert_eq!(
        discovered
            .iter()
            .filter(|p| p.to_string_lossy().contains("bulk-"))
            .count(),
        3
    );
    for path in &discovered {
        assert!(path.is_dir(), "{} missing", path.display());
    }
    fs::remove_dir_all(&target).unwrap();
}

fn manifest_discovered(output: &Output) -> Vec<PathBuf> {
    let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim().to_string());
    let manifest: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    manifest["expectedDiscovered"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| PathBuf::from(v.as_str().unwrap()))
        .collect()
}
