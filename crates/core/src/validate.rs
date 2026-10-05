//! Validation of the values a caller passes to the write actions.
//!
//! Branch names, remote names, object ids, paths and commit messages come
//! from the user interface. Each is checked before any git command runs, so
//! a value can never become an option (no leading `-`), point outside the
//! repository or carry pathspec magic. The checks are pure; they do not
//! touch the file system.

use crate::git::{GitError, LITERAL_PATHSPEC};

/// Longest branch name accepted, in bytes.
const MAX_BRANCH_BYTES: usize = 255;
/// Longest repository-relative path accepted, in bytes.
const MAX_PATH_BYTES: usize = 4096;
/// Longest commit message accepted, in bytes.
const MAX_MESSAGE_BYTES: usize = 64 * 1024;

fn invalid(field: &str, reason: impl Into<String>) -> GitError {
    GitError::InvalidInput {
        field: field.to_string(),
        reason: reason.into(),
    }
}

/// A local branch name (`feature/a`, not `refs/heads/feature/a`), following
/// `git check-ref-format --branch` and refusing names git would read as an
/// option or a revision expression.
pub fn branch_name(name: &str) -> Result<(), GitError> {
    const FIELD: &str = "branch name";
    if name.is_empty() {
        return Err(invalid(FIELD, "is empty"));
    }
    if name.len() > MAX_BRANCH_BYTES {
        return Err(invalid(FIELD, "is too long"));
    }
    if name.starts_with('-') {
        return Err(invalid(FIELD, "must not start with '-'"));
    }
    if name == "HEAD" || name == "@" {
        return Err(invalid(FIELD, "is reserved"));
    }
    if let Some(bad) = name
        .chars()
        .find(|c| c.is_control() || c.is_whitespace() || "~^:?*[\\".contains(*c))
    {
        return Err(invalid(FIELD, format!("must not contain {bad:?}")));
    }
    if name.contains("..") || name.contains("@{") || name.contains("//") {
        return Err(invalid(FIELD, "must not contain '..', '@{' or '//'"));
    }
    if name.ends_with('/') || name.ends_with('.') {
        return Err(invalid(FIELD, "must not end with '/' or '.'"));
    }
    if name
        .split('/')
        .any(|part| part.is_empty() || part.starts_with('.') || part.ends_with(".lock"))
    {
        return Err(invalid(
            FIELD,
            "parts must not be empty, start with '.' or end with '.lock'",
        ));
    }
    Ok(())
}

/// A remote name as listed by `git remote`.
pub fn remote_name(name: &str) -> Result<(), GitError> {
    const FIELD: &str = "remote name";
    if name.is_empty() || name.starts_with('-') {
        return Err(invalid(FIELD, "is empty or starts with '-'"));
    }
    if name
        .chars()
        .any(|c| c.is_control() || c.is_whitespace() || "~^:?*[\\+".contains(c))
        || name.contains("..")
    {
        return Err(invalid(FIELD, "contains a character git does not allow"));
    }
    Ok(())
}

/// A full hexadecimal object id (SHA-1 or SHA-256). Abbreviations and
/// revision expressions are refused so the value names exactly one object.
pub fn object_id(oid: &str) -> Result<(), GitError> {
    if matches!(oid.len(), 40 | 64) && oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(invalid("object id", "must be a full hexadecimal object id"))
    }
}

/// A path relative to the repository root, with `/` separators, as git
/// prints it (`src/app.txt`; an untracked folder may end with `/`). Returns
/// the `:(literal)` pathspec for it, so `*` or `:` in a name never expand.
///
/// Absolute paths, drive or UNC prefixes, `\`, `.` and `..` parts, empty
/// parts and anything inside `.git` are refused: the path cannot leave the
/// repository or reach its metadata.
pub fn repo_path(path: &str) -> Result<String, GitError> {
    const FIELD: &str = "path";
    if path.is_empty() {
        return Err(invalid(FIELD, "is empty"));
    }
    if path.len() > MAX_PATH_BYTES {
        return Err(invalid(FIELD, "is too long"));
    }
    if path.chars().any(char::is_control) {
        return Err(invalid(FIELD, "contains a control character"));
    }
    if path.contains('\\') {
        return Err(invalid(FIELD, "must use '/' separators"));
    }
    if path.starts_with('/') || has_drive_prefix(path) {
        return Err(invalid(FIELD, "must be relative to the repository"));
    }
    let trimmed = path.strip_suffix('/').unwrap_or(path);
    for part in trimmed.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(invalid(FIELD, "must not contain empty, '.' or '..' parts"));
        }
        // `GIT~1` is the Windows short name of `.git`.
        if part.eq_ignore_ascii_case(".git") || part.eq_ignore_ascii_case("git~1") {
            return Err(invalid(FIELD, "must not point inside .git"));
        }
    }
    Ok(format!("{LITERAL_PATHSPEC}{path}"))
}

/// `C:` style prefixes (also `C:file`, which Windows resolves against the
/// drive's current folder).
fn has_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// A commit message: not blank, at most 64 KiB, no NUL.
pub fn commit_message(message: &str) -> Result<(), GitError> {
    const FIELD: &str = "commit message";
    if message.trim().is_empty() {
        return Err(invalid(FIELD, "is empty"));
    }
    if message.len() > MAX_MESSAGE_BYTES {
        return Err(invalid(FIELD, "is too long"));
    }
    if message.contains('\0') {
        return Err(invalid(FIELD, "contains a NUL character"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_branch_names_are_accepted() {
        for name in [
            "main",
            "feature/a",
            "fix-1.2",
            "user/nuno/x_y",
            "a@b",
            "ünïcode",
        ] {
            assert!(branch_name(name).is_ok(), "{name:?}");
        }
    }

    #[test]
    fn option_like_and_malformed_branch_names_are_refused() {
        let long = "a".repeat(MAX_BRANCH_BYTES + 1);
        for name in [
            "",
            "-D",
            "--force",
            "-",
            "HEAD",
            "@",
            "a b",
            "a\tb",
            "a\nb",
            "a~1",
            "a^",
            "a:b",
            "a?",
            "a*",
            "a[",
            "a\\b",
            "a..b",
            "a@{1}",
            "a//b",
            "a/",
            "a.",
            ".a",
            "a/.b",
            "a.lock",
            "a/b.lock/c",
            &long,
        ] {
            assert!(
                matches!(branch_name(name), Err(GitError::InvalidInput { .. })),
                "{name:?} must be refused"
            );
        }
    }

    #[test]
    fn remote_names_are_checked() {
        assert!(remote_name("origin").is_ok());
        assert!(remote_name("my-fork").is_ok());
        for name in ["", "-o", "--upload-pack=x", "a b", "+x", "a:b", "a..b"] {
            assert!(remote_name(name).is_err(), "{name:?}");
        }
    }

    #[test]
    fn object_ids_must_be_full_hex() {
        assert!(object_id(&"a".repeat(40)).is_ok());
        assert!(object_id(&"0".repeat(64)).is_ok());
        for oid in [
            "",
            "abc1234",
            "--all",
            "HEAD",
            "HEAD~1",
            &"g".repeat(40),
            &format!("-{}", "a".repeat(39)),
            &"a".repeat(41),
        ] {
            assert!(object_id(oid).is_err(), "{oid:?}");
        }
    }

    #[test]
    fn paths_become_literal_pathspecs() {
        assert_eq!(repo_path("src/app.txt").unwrap(), ":(literal)src/app.txt");
        assert_eq!(repo_path("new-dir/").unwrap(), ":(literal)new-dir/");
        // A leading dash or glob character stays a literal file name.
        assert_eq!(repo_path("-A").unwrap(), ":(literal)-A");
        assert_eq!(repo_path("*.txt").unwrap(), ":(literal)*.txt");
        assert_eq!(repo_path(".gitignore").unwrap(), ":(literal).gitignore");
        assert_eq!(repo_path("a/.github/x").unwrap(), ":(literal)a/.github/x");
    }

    #[test]
    fn paths_outside_the_repository_or_in_git_metadata_are_refused() {
        for path in [
            "",
            "/etc/passwd",
            "C:/Windows/win.ini",
            "C:win.ini",
            "\\\\server\\share",
            "src\\app.txt",
            "../outside.txt",
            "a/../../outside.txt",
            "a/./b",
            "./a",
            "a//b",
            "//",
            ".git/config",
            ".GIT/hooks/pre-commit",
            "sub/.git/config",
            "GIT~1/config",
            "a\nb",
            "a\0b",
        ] {
            assert!(
                matches!(repo_path(path), Err(GitError::InvalidInput { .. })),
                "{path:?} must be refused"
            );
        }
    }

    #[test]
    fn commit_messages_are_checked() {
        assert!(commit_message("Fix the thing\n\nBody").is_ok());
        assert!(
            commit_message("--amend").is_ok(),
            "passed on stdin, never as an option"
        );
        for message in ["", "  \n\t", "a\0b"] {
            assert!(commit_message(message).is_err(), "{message:?}");
        }
        assert!(commit_message(&"a".repeat(MAX_MESSAGE_BYTES + 1)).is_err());
    }
}
