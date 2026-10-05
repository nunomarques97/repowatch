//! Per-file diffs for the detail view, and the patches behind hunk staging.
//!
//! Staged and unstaged diffs come from `git diff` on the read path (no
//! colour, no external diff or textconv drivers, fixed `a/` `b/` prefixes,
//! no rename detection). An untracked file has no diff in git, so its
//! content is read directly and shown as one added hunk.
//!
//! Every hunk carries an `id`, a hash of its exact bytes. Staging or
//! unstaging a hunk names it by id: the diff is read again and the hunk is
//! applied only when an identical hunk is still there, so a file that
//! changed since it was shown can never get the wrong lines staged.

use std::fs;
use std::io::Read as _;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::git::{Git, GitError};
use crate::status::lossy;
use crate::validate;

/// Most diff lines returned for display; the rest is cut at a hunk boundary
/// and `truncated` is set.
pub const MAX_DISPLAY_LINES: usize = 20_000;
/// Most bytes of an untracked file read for display.
pub const MAX_UNTRACKED_BYTES: u64 = 2 * 1024 * 1024;
/// Bytes inspected for a NUL to call content binary, as git does.
const BINARY_PROBE_BYTES: usize = 8000;

/// Which side of a file's changes to show.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffSide {
    /// Working tree against the index.
    Unstaged,
    /// Index against HEAD.
    Staged,
    /// An untracked file, shown as entirely added.
    Untracked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LineKind {
    Context,
    Added,
    Removed,
    /// `\ No newline at end of file`, about the line before it.
    NoNewline,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: LineKind,
    /// The line without its sign, line ending or carriage return. Bytes
    /// that are not valid UTF-8 are converted lossily.
    pub text: String,
    /// Line number on the old side (context and removed lines).
    pub old_line: Option<u32>,
    /// Line number on the new side (context and added lines).
    pub new_line: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    /// Identifies this exact hunk for [`crate::actions::stage_hunk`] and
    /// [`crate::actions::unstage_hunk`].
    pub id: String,
    /// The `@@ -a,b +c,d @@ section` line.
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub side: DiffSide,
    /// Binary content: no hunks are shown and only the whole file can be
    /// staged.
    pub binary: bool,
    /// Empty when the file has no change on this side.
    pub hunks: Vec<Hunk>,
    /// Hunks were left out because the diff is very long.
    pub truncated: bool,
}

/// A parsed `git diff` of one file, with the bytes needed to rebuild a patch.
pub(crate) struct Patch {
    /// Everything before the first hunk (`diff --git`, mode, `index`,
    /// `---`, `+++` lines).
    pub header: Vec<u8>,
    pub binary: bool,
    pub hunks: Vec<RawHunk>,
}

pub(crate) struct RawHunk {
    pub hunk: Hunk,
    pub bytes: Vec<u8>,
}

impl Patch {
    /// The patch applying only `hunk`.
    pub fn single(&self, hunk: &RawHunk) -> Vec<u8> {
        let mut patch = self.header.clone();
        patch.extend_from_slice(&hunk.bytes);
        patch
    }
}

/// The diff of one changed file on one side. `path` is relative to the
/// repository root with `/` separators, as in [`crate::StatusEntry::path`].
pub fn read_file_diff(
    git: &Git,
    repo: &Path,
    path: &str,
    side: DiffSide,
) -> Result<FileDiff, GitError> {
    let pathspec = validate::repo_path(path)?;
    let (binary, hunks) = match side {
        DiffSide::Untracked => untracked_hunks(repo, path)?,
        DiffSide::Staged | DiffSide::Unstaged => {
            let patch = read_patch(git, repo, &pathspec, side)?;
            (
                patch.binary,
                patch.hunks.into_iter().map(|raw| raw.hunk).collect(),
            )
        }
    };
    let (hunks, truncated) = limit_lines(hunks);
    Ok(FileDiff {
        path: path.to_string(),
        side,
        binary,
        hunks,
        truncated,
    })
}

/// Runs `git diff` for one pathspec and parses it.
pub(crate) fn read_patch(
    git: &Git,
    repo: &Path,
    pathspec: &str,
    side: DiffSide,
) -> Result<Patch, GitError> {
    let mut args = vec!["diff"];
    if side == DiffSide::Staged {
        args.push("--cached");
    }
    args.extend([
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--unified=3",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--",
        pathspec,
    ]);
    parse_patch(&git.read(repo, &args)?)
}

/// Parses the `git diff` output of a single file.
pub(crate) fn parse_patch(output: &[u8]) -> Result<Patch, GitError> {
    let mut patch = Patch {
        header: Vec::new(),
        binary: false,
        hunks: Vec::new(),
    };
    let mut files = 0;
    let mut current: Option<RawHunk> = None;
    let mut old_line = 0;
    let mut new_line = 0;
    for line in output.split_inclusive(|byte| *byte == b'\n') {
        if line.starts_with(b"diff --git ") {
            files += 1;
            if files > 1 {
                return Err(GitError::InvalidInput {
                    field: "path".into(),
                    reason: "matches more than one file".into(),
                });
            }
        }
        if line.starts_with(b"@@ ") {
            patch.hunks.extend(current.take().map(finish));
            let hunk = parse_hunk_header(line)?;
            old_line = hunk.old_start;
            new_line = hunk.new_start;
            current = Some(RawHunk {
                hunk,
                bytes: line.to_vec(),
            });
            continue;
        }
        let Some(raw) = current.as_mut() else {
            if line.starts_with(b"Binary files ") || line.starts_with(b"GIT binary patch") {
                patch.binary = true;
            }
            patch.header.extend_from_slice(line);
            continue;
        };
        let (kind, old, new) = match line.first() {
            // `diff.suppressBlankEmpty` prints blank context lines as empty.
            Some(b' ' | b'\n' | b'\r') => (LineKind::Context, Some(old_line), Some(new_line)),
            Some(b'-') => (LineKind::Removed, Some(old_line), None),
            Some(b'+') => (LineKind::Added, None, Some(new_line)),
            Some(b'\\') => (LineKind::NoNewline, None, None),
            _ => {
                return Err(crate::status::parse_error(format!(
                    "unexpected diff line {:?}",
                    lossy(line)
                )));
            }
        };
        old_line += u32::from(old.is_some());
        new_line += u32::from(new.is_some());
        let text = match line.first() {
            _ if kind == LineKind::NoNewline => "No newline at end of file".to_string(),
            Some(b' ' | b'-' | b'+') => display_text(&line[1..]),
            _ => String::new(),
        };
        raw.hunk.lines.push(DiffLine {
            kind,
            text,
            old_line: old,
            new_line: new,
        });
        raw.bytes.extend_from_slice(line);
    }
    patch.hunks.extend(current.take().map(finish));
    Ok(patch)
}

/// Sets the hunk id once all of its bytes are known.
fn finish(mut raw: RawHunk) -> RawHunk {
    raw.hunk.id = hunk_id(&raw.bytes);
    raw
}

/// Parses `@@ -a[,b] +c[,d] @@[ section]`.
fn parse_hunk_header(line: &[u8]) -> Result<Hunk, GitError> {
    let text = display_text(line);
    let malformed = || crate::status::parse_error(format!("malformed hunk header {text:?}"));
    let ranges = text
        .strip_prefix("@@ ")
        .and_then(|rest| rest.split_once(" @@"))
        .map(|(ranges, _)| ranges)
        .ok_or_else(malformed)?;
    let (old, new) = ranges.split_once(' ').ok_or_else(malformed)?;
    let range = |value: Option<&str>| -> Result<(u32, u32), GitError> {
        let value = value.ok_or_else(malformed)?;
        let (start, count) = value.split_once(',').unwrap_or((value, "1"));
        Ok((
            start.parse().map_err(|_| malformed())?,
            count.parse().map_err(|_| malformed())?,
        ))
    };
    let (old_start, old_lines) = range(old.strip_prefix('-'))?;
    let (new_start, new_lines) = range(new.strip_prefix('+'))?;
    Ok(Hunk {
        id: String::new(),
        header: text,
        old_start,
        old_lines,
        new_start,
        new_lines,
        lines: Vec::new(),
    })
}

/// 64-bit FNV-1a of the hunk bytes, in hex: stable across runs and builds.
fn hunk_id(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn display_text(bytes: &[u8]) -> String {
    let bytes = bytes.strip_suffix(b"\n").unwrap_or(bytes);
    let bytes = bytes.strip_suffix(b"\r").unwrap_or(bytes);
    lossy(bytes)
}

/// Keeps whole hunks while the line count stays within
/// [`MAX_DISPLAY_LINES`]: a hunk is never shown in part, so staging it can
/// never stage lines the user did not see.
fn limit_lines(hunks: Vec<Hunk>) -> (Vec<Hunk>, bool) {
    let mut total = 0;
    let mut kept = Vec::new();
    let count = hunks.len();
    for hunk in hunks {
        total += hunk.lines.len();
        if total > MAX_DISPLAY_LINES {
            break;
        }
        kept.push(hunk);
    }
    let truncated = kept.len() < count;
    (kept, truncated)
}

/// An untracked file as one added hunk. The file is read only when it is a
/// regular file whose folder resolves inside the repository; a symbolic
/// link shows its target, as git would store it.
fn untracked_hunks(repo: &Path, path: &str) -> Result<(bool, Vec<Hunk>), GitError> {
    let relative = path.strip_suffix('/').unwrap_or(path);
    let full: PathBuf = relative
        .split('/')
        .fold(repo.to_path_buf(), |full, part| full.join(part));
    let gone = || GitError::Stale {
        what: path.to_string(),
    };
    let invalid = |reason: &str| GitError::InvalidInput {
        field: "path".into(),
        reason: reason.into(),
    };
    let metadata = fs::symlink_metadata(&full).map_err(|_| gone())?;
    let inside = full
        .parent()
        .and_then(|parent| fs::canonicalize(parent).ok())
        .zip(fs::canonicalize(repo).ok())
        .is_some_and(|(parent, root)| parent.starts_with(root));
    if !inside {
        return Err(invalid("is not inside the repository"));
    }
    let content = if metadata.file_type().is_symlink() {
        let target = fs::read_link(&full).map_err(|_| gone())?;
        target.to_string_lossy().replace('\\', "/").into_bytes()
    } else if metadata.is_file() {
        let mut content = Vec::new();
        fs::File::open(&full)
            .and_then(|file| file.take(MAX_UNTRACKED_BYTES).read_to_end(&mut content))
            .map_err(|error| GitError::Io {
                message: format!("{path}: {error}"),
            })?;
        content
    } else {
        return Err(invalid("is a folder; choose a file inside it"));
    };
    let probe = &content[..content.len().min(BINARY_PROBE_BYTES)];
    if probe.contains(&0) {
        return Ok((true, Vec::new()));
    }
    if content.is_empty() {
        return Ok((false, Vec::new()));
    }

    let mut lines = Vec::new();
    for (index, line) in content.split_inclusive(|byte| *byte == b'\n').enumerate() {
        let number = u32::try_from(index + 1).unwrap_or(u32::MAX);
        lines.push(DiffLine {
            kind: LineKind::Added,
            text: display_text(line),
            old_line: None,
            new_line: Some(number),
        });
        if !line.ends_with(b"\n") {
            lines.push(DiffLine {
                kind: LineKind::NoNewline,
                text: "No newline at end of file".into(),
                old_line: None,
                new_line: None,
            });
        }
    }
    let added = u32::try_from(
        lines
            .iter()
            .filter(|line| line.kind == LineKind::Added)
            .count(),
    )
    .unwrap_or(u32::MAX);
    let header = format!("@@ -0,0 +1,{added} @@");
    let mut hashed = header.clone().into_bytes();
    hashed.extend_from_slice(&content);
    Ok((
        false,
        vec![Hunk {
            id: hunk_id(&hashed),
            header,
            old_start: 0,
            old_lines: 0,
            new_start: 1,
            new_lines: added,
            lines,
        }],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIFF: &[u8] = concat!(
        "diff --git a/f.txt b/f.txt\n",
        "index f6c3b87..b80185e 100644\n",
        "--- a/f.txt\n",
        "+++ b/f.txt\n",
        "@@ -1,4 +1,6 @@\n",
        " a\n",
        "+A1\n",
        "+A2\n",
        " b\n",
        " c\n",
        " d\n",
        "@@ -11,3 +13,3 @@ j\n",
        " m\n",
        "-n\r\n",
        "+N\n",
        "\\ No newline at end of file\n",
    )
    .as_bytes();

    #[test]
    fn hunks_lines_and_numbers_are_parsed() {
        let patch = parse_patch(DIFF).unwrap();
        assert!(!patch.binary);
        assert!(patch.header.starts_with(b"diff --git"));
        assert!(patch.header.ends_with(b"+++ b/f.txt\n"));
        assert_eq!(patch.hunks.len(), 2);

        let first = &patch.hunks[0].hunk;
        assert_eq!(
            (
                first.old_start,
                first.old_lines,
                first.new_start,
                first.new_lines
            ),
            (1, 4, 1, 6)
        );
        assert_eq!(first.lines.len(), 6);
        assert_eq!(first.lines[1].kind, LineKind::Added);
        assert_eq!(first.lines[1].new_line, Some(2));
        assert_eq!(first.lines[3].old_line, Some(2));
        assert_eq!(first.lines[3].new_line, Some(4));

        let second = &patch.hunks[1].hunk;
        assert_eq!(second.header, "@@ -11,3 +13,3 @@ j");
        assert_eq!(second.lines[1].kind, LineKind::Removed);
        assert_eq!(second.lines[1].text, "n", "carriage return is not shown");
        assert_eq!(second.lines[1].old_line, Some(12));
        assert_eq!(second.lines[3].kind, LineKind::NoNewline);
        // The raw bytes keep the carriage return for the patch.
        assert!(patch.hunks[1].bytes.windows(3).any(|w| w == b"n\r\n"));
        assert_ne!(first.id, second.id);
        assert_eq!(first.id.len(), 16);
    }

    #[test]
    fn single_hunk_patch_keeps_the_header() {
        let patch = parse_patch(DIFF).unwrap();
        let single = patch.single(&patch.hunks[1]);
        let text = String::from_utf8(single).unwrap();
        assert!(text.starts_with("diff --git a/f.txt b/f.txt\n"));
        assert!(text.contains("+++ b/f.txt\n@@ -11,3 +13,3 @@ j\n"));
        assert!(!text.contains("+A1"));
    }

    #[test]
    fn ids_change_with_content() {
        let a = parse_patch(DIFF).unwrap();
        let changed = String::from_utf8(DIFF.to_vec())
            .unwrap()
            .replace("+A2", "+A3");
        let b = parse_patch(changed.as_bytes()).unwrap();
        assert_ne!(a.hunks[0].hunk.id, b.hunks[0].hunk.id);
        assert_eq!(a.hunks[1].hunk.id, b.hunks[1].hunk.id);
    }

    #[test]
    fn binary_empty_and_multi_file_output() {
        let binary = parse_patch(
            b"diff --git a/x.bin b/x.bin\nindex 1..2 100644\nBinary files a/x.bin and b/x.bin differ\n",
        )
        .unwrap();
        assert!(binary.binary && binary.hunks.is_empty());
        let empty = parse_patch(b"").unwrap();
        assert!(!empty.binary && empty.hunks.is_empty());
        let two = [DIFF, b"diff --git a/g b/g\n"].concat();
        assert!(matches!(
            parse_patch(&two),
            Err(GitError::InvalidInput { .. })
        ));
        assert!(parse_patch(b"diff --git a/x b/x\n@@ -1 +1 @@\n?bad\n").is_err());
        assert!(parse_patch(b"@@ -x +1 @@\n").is_err());
    }

    #[test]
    fn hunk_header_without_counts_defaults_to_one() {
        let hunk = parse_hunk_header(b"@@ -3 +3,0 @@\n").unwrap();
        assert_eq!(
            (
                hunk.old_start,
                hunk.old_lines,
                hunk.new_start,
                hunk.new_lines
            ),
            (3, 1, 3, 0)
        );
    }

    #[test]
    fn long_diffs_are_cut_at_a_hunk_boundary() {
        let hunk = |lines: usize| Hunk {
            id: String::new(),
            header: String::new(),
            old_start: 1,
            old_lines: 0,
            new_start: 1,
            new_lines: 0,
            lines: vec![
                DiffLine {
                    kind: LineKind::Added,
                    text: String::new(),
                    old_line: None,
                    new_line: None,
                };
                lines
            ],
        };
        let (kept, truncated) = limit_lines(vec![hunk(10), hunk(MAX_DISPLAY_LINES), hunk(1)]);
        assert_eq!(kept.len(), 1);
        assert!(truncated);
        let (kept, truncated) = limit_lines(vec![hunk(10), hunk(5)]);
        assert_eq!(kept.len(), 2);
        assert!(!truncated);
    }
}
