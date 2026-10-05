//! Working-tree and branch status from `git status --porcelain=v2 -z`.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::git::{Git, GitError};

/// Arguments of the status read. `--ahead-behind` and
/// `--untracked-files=normal` override user config so every repository is
/// reported the same way.
const STATUS_ARGS: &[&str] = &[
    "status",
    "--porcelain=v2",
    "-z",
    "--branch",
    "--show-stash",
    "--ahead-behind",
    "--untracked-files=normal",
];

/// What HEAD points at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Head {
    /// On a branch with at least one commit.
    Branch { name: String },
    /// On a branch that has no commits yet (a new repository).
    Unborn { name: String },
    /// Detached HEAD.
    Detached,
}

impl Head {
    /// The current branch name, if HEAD is on a branch.
    pub fn branch(&self) -> Option<&str> {
        match self {
            Self::Branch { name } | Self::Unborn { name } => Some(name),
            Self::Detached => None,
        }
    }
}

/// The upstream of the current branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Upstream {
    /// For example `origin/main`.
    pub name: String,
    /// Local commits not on the upstream (unpushed).
    pub ahead: u32,
    /// Upstream commits not merged locally, as of the last fetch.
    pub behind: u32,
    /// The upstream is configured but its ref no longer exists (for example
    /// the remote branch was deleted). Ahead and behind are then 0.
    pub gone: bool,
}

/// State of one side (index or working tree) of a changed file, from the
/// porcelain `XY` letters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileChange {
    Unmodified,
    Modified,
    TypeChanged,
    Added,
    Deleted,
    Renamed,
    Copied,
    Unmerged,
}

impl FileChange {
    fn from_letter(letter: u8) -> Option<Self> {
        Some(match letter {
            b'.' => Self::Unmodified,
            b'M' => Self::Modified,
            b'T' => Self::TypeChanged,
            b'A' => Self::Added,
            b'D' => Self::Deleted,
            b'R' => Self::Renamed,
            b'C' => Self::Copied,
            b'U' => Self::Unmerged,
            _ => return None,
        })
    }
}

/// Kind of status entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    /// A tracked file with staged and/or unstaged changes.
    Changed,
    /// A staged rename or copy (`original_path` is set).
    Renamed,
    /// A merge conflict.
    Conflicted,
    /// An untracked file, or an untracked folder (path ends with `/`).
    Untracked,
}

/// One changed path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub kind: EntryKind,
    /// Path relative to the repository root, with `/` separators. Names that
    /// are not valid UTF-8 are converted lossily.
    pub path: String,
    /// The source path of a rename or copy.
    pub original_path: Option<String>,
    /// Change in the index (staged side).
    pub index: FileChange,
    /// Change in the working tree (unstaged side).
    pub worktree: FileChange,
}

/// Counts of changed paths. A file with both staged and unstaged changes is
/// counted in both.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeCounts {
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub conflicted: u32,
}

impl ChangeCounts {
    /// True when nothing is staged, modified, untracked or conflicted.
    pub fn is_clean(&self) -> bool {
        *self == Self::default()
    }
}

/// Parsed `git status --porcelain=v2 -z --branch --show-stash` output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusReport {
    /// HEAD commit, `None` before the first commit.
    pub oid: Option<String>,
    pub head: Head,
    pub upstream: Option<Upstream>,
    pub stash_count: u32,
    pub counts: ChangeCounts,
    pub entries: Vec<StatusEntry>,
}

/// Status of one repository or worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub path: PathBuf,
    /// Configured remote names; empty when the repository has no remote.
    pub remotes: Vec<String>,
    #[serde(flatten)]
    pub report: StatusReport,
}

impl RepoStatus {
    pub fn has_remote(&self) -> bool {
        !self.remotes.is_empty()
    }
}

/// Reads the status of the repository or worktree at `repo` (an absolute
/// path to its root). Never fetches and never writes to the repository.
pub fn read_status(git: &Git, repo: &Path) -> Result<RepoStatus, GitError> {
    let report = parse_status(&git.read(repo, STATUS_ARGS)?)?;
    let remotes = parse_remotes(&git.read(repo, &["remote"])?);
    Ok(RepoStatus {
        path: repo.to_path_buf(),
        remotes,
        report,
    })
}

fn parse_remotes(output: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(output)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

/// Parses `git status --porcelain=v2 -z --branch` output. Unknown header
/// lines are ignored so newer git versions keep working.
pub fn parse_status(output: &[u8]) -> Result<StatusReport, GitError> {
    let mut oid = None;
    let mut head_name: Option<String> = None;
    let mut upstream_name: Option<String> = None;
    let mut ahead_behind: Option<(u32, u32)> = None;
    let mut stash_count = 0;
    let mut counts = ChangeCounts::default();
    let mut entries = Vec::new();

    let mut records = output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());
    while let Some(record) = records.next() {
        match record {
            [b'#', b' ', header @ ..] => {
                let header = String::from_utf8_lossy(header);
                let (key, value) = header.split_once(' ').unwrap_or((&header, ""));
                match key {
                    "branch.oid" => oid = (value != "(initial)").then(|| value.to_string()),
                    "branch.head" => head_name = Some(value.to_string()),
                    "branch.upstream" => upstream_name = Some(value.to_string()),
                    "branch.ab" => ahead_behind = Some(parse_ahead_behind(value)?),
                    "stash" => stash_count = parse_number(value)?,
                    _ => {}
                }
            }
            [b'1', b' ', rest @ ..] => {
                let fields = split_fields(rest, 8, record)?;
                let (index, worktree) = parse_xy(fields[0])?;
                entries.push(changed_entry(
                    EntryKind::Changed,
                    index,
                    worktree,
                    fields[7],
                    None,
                ));
            }
            [b'2', b' ', rest @ ..] => {
                let fields = split_fields(rest, 9, record)?;
                let (index, worktree) = parse_xy(fields[0])?;
                let original = records
                    .next()
                    .ok_or_else(|| parse_error("rename without original path"))?;
                entries.push(changed_entry(
                    EntryKind::Renamed,
                    index,
                    worktree,
                    fields[8],
                    Some(original),
                ));
            }
            [b'u', b' ', rest @ ..] => {
                let fields = split_fields(rest, 10, record)?;
                let (index, worktree) = parse_xy(fields[0])?;
                entries.push(changed_entry(
                    EntryKind::Conflicted,
                    index,
                    worktree,
                    fields[9],
                    None,
                ));
            }
            [b'?', b' ', path @ ..] => entries.push(StatusEntry {
                kind: EntryKind::Untracked,
                path: lossy(path),
                original_path: None,
                index: FileChange::Unmodified,
                worktree: FileChange::Unmodified,
            }),
            // Ignored files are only listed with --ignored, which is not used.
            [b'!', b' ', ..] => {}
            _ => return Err(parse_error(format!("unknown record {:?}", lossy(record)))),
        }
    }

    for entry in &entries {
        match entry.kind {
            EntryKind::Changed | EntryKind::Renamed => {
                counts.staged += u32::from(entry.index != FileChange::Unmodified);
                counts.unstaged += u32::from(entry.worktree != FileChange::Unmodified);
            }
            EntryKind::Conflicted => counts.conflicted += 1,
            EntryKind::Untracked => counts.untracked += 1,
        }
    }

    let head_name = head_name.ok_or_else(|| parse_error("missing branch.head header"))?;
    let head = if head_name == "(detached)" {
        Head::Detached
    } else if oid.is_none() {
        Head::Unborn { name: head_name }
    } else {
        Head::Branch { name: head_name }
    };
    let upstream = upstream_name.map(|name| {
        let (ahead, behind) = ahead_behind.unwrap_or((0, 0));
        Upstream {
            name,
            ahead,
            behind,
            gone: ahead_behind.is_none(),
        }
    });
    Ok(StatusReport {
        oid,
        head,
        upstream,
        stash_count,
        counts,
        entries,
    })
}

fn changed_entry(
    kind: EntryKind,
    index: FileChange,
    worktree: FileChange,
    path: &[u8],
    original: Option<&[u8]>,
) -> StatusEntry {
    StatusEntry {
        kind,
        path: lossy(path),
        original_path: original.map(lossy),
        index,
        worktree,
    }
}

/// Splits `count` space-separated fields; the last one (the path) keeps any
/// spaces it contains.
fn split_fields<'a>(
    rest: &'a [u8],
    count: usize,
    record: &[u8],
) -> Result<Vec<&'a [u8]>, GitError> {
    let fields: Vec<&[u8]> = rest.splitn(count, |byte| *byte == b' ').collect();
    if fields.len() != count || fields[count - 1].is_empty() {
        return Err(parse_error(format!("malformed record {:?}", lossy(record))));
    }
    Ok(fields)
}

fn parse_xy(xy: &[u8]) -> Result<(FileChange, FileChange), GitError> {
    match xy {
        [x, y] => match (FileChange::from_letter(*x), FileChange::from_letter(*y)) {
            (Some(index), Some(worktree)) => Ok((index, worktree)),
            _ => Err(parse_error(format!(
                "unknown status letters {:?}",
                lossy(xy)
            ))),
        },
        _ => Err(parse_error(format!(
            "malformed status letters {:?}",
            lossy(xy)
        ))),
    }
}

fn parse_ahead_behind(value: &str) -> Result<(u32, u32), GitError> {
    let mut parts = value.split(' ');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(ahead), Some(behind), None) => {
            let ahead = ahead
                .strip_prefix('+')
                .ok_or_else(|| parse_error("branch.ab without +"))?;
            let behind = behind
                .strip_prefix('-')
                .ok_or_else(|| parse_error("branch.ab without -"))?;
            Ok((parse_number(ahead)?, parse_number(behind)?))
        }
        _ => Err(parse_error(format!("malformed branch.ab {value:?}"))),
    }
}

fn parse_number(value: &str) -> Result<u32, GitError> {
    value
        .parse()
        .map_err(|_| parse_error(format!("expected a number, got {value:?}")))
}

pub(crate) fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

pub(crate) fn parse_error(message: impl Into<String>) -> GitError {
    GitError::Parse {
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OID: &str = "1111111111111111111111111111111111111111";

    fn branch_headers(extra: &str) -> String {
        format!("# branch.oid {OID}\0# branch.head main\0{extra}")
    }

    #[test]
    fn parses_clean_branch_with_upstream() {
        let report = parse_status(
            branch_headers("# branch.upstream origin/main\0# branch.ab +2 -3\0").as_bytes(),
        )
        .unwrap();
        assert_eq!(
            report.head,
            Head::Branch {
                name: "main".into()
            }
        );
        assert_eq!(report.oid.as_deref(), Some(OID));
        assert_eq!(
            report.upstream,
            Some(Upstream {
                name: "origin/main".into(),
                ahead: 2,
                behind: 3,
                gone: false
            })
        );
        assert!(report.counts.is_clean());
        assert!(report.entries.is_empty());
    }

    #[test]
    fn upstream_without_ahead_behind_is_gone() {
        let report =
            parse_status(branch_headers("# branch.upstream origin/old\0").as_bytes()).unwrap();
        assert_eq!(
            report.upstream,
            Some(Upstream {
                name: "origin/old".into(),
                ahead: 0,
                behind: 0,
                gone: true
            })
        );
    }

    #[test]
    fn parses_detached_and_unborn_heads() {
        let detached =
            parse_status(format!("# branch.oid {OID}\0# branch.head (detached)\0").as_bytes())
                .unwrap();
        assert_eq!(detached.head, Head::Detached);
        assert_eq!(detached.head.branch(), None);
        let unborn = parse_status(b"# branch.oid (initial)\0# branch.head main\0").unwrap();
        assert_eq!(
            unborn.head,
            Head::Unborn {
                name: "main".into()
            }
        );
        assert_eq!(unborn.oid, None);
    }

    #[test]
    fn counts_every_entry_kind_and_keeps_odd_paths() {
        let z = "0000000000000000000000000000000000000000";
        let output = branch_headers(&format!(
            "# stash 3\0\
             1 M. N... 100644 100644 100644 {OID} {OID} a b  c.txt\0\
             1 MM N... 100644 100644 100644 {OID} {OID} -dash\n new\tline.txt\0\
             1 .D N... 100644 100644 000000 {OID} {OID} gone.txt\0\
             2 R. N... 100644 100644 100644 {OID} {OID} R100 to name.txt\0from -> name.txt\0\
             u UU N... 100644 100644 100644 100644 {OID} {OID} {OID} conflict.txt\0\
             1 A. N... 000000 100644 100644 {z} {OID} ação 🚀.txt\0\
             ? untracked dir/\0\
             ? # not a header.txt\0"
        ));
        let report = parse_status(output.as_bytes()).unwrap();
        assert_eq!(report.stash_count, 3);
        assert_eq!(
            report.counts,
            ChangeCounts {
                staged: 4,
                unstaged: 2,
                untracked: 2,
                conflicted: 1
            }
        );
        let paths: Vec<&str> = report.entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "a b  c.txt",
                "-dash\n new\tline.txt",
                "gone.txt",
                "to name.txt",
                "conflict.txt",
                "ação 🚀.txt",
                "untracked dir/",
                "# not a header.txt"
            ]
        );
        let renamed = &report.entries[3];
        assert_eq!(renamed.kind, EntryKind::Renamed);
        assert_eq!(renamed.original_path.as_deref(), Some("from -> name.txt"));
        assert_eq!(report.entries[1].index, FileChange::Modified);
        assert_eq!(report.entries[1].worktree, FileChange::Modified);
        assert_eq!(report.entries[2].worktree, FileChange::Deleted);
        assert_eq!(report.entries[4].kind, EntryKind::Conflicted);
    }

    #[test]
    fn non_utf8_paths_are_kept_lossily() {
        let mut output = branch_headers("? ").into_bytes();
        output.extend_from_slice(b"bad-\xff-name\0");
        let report = parse_status(&output).unwrap();
        assert_eq!(report.entries[0].path, "bad-\u{FFFD}-name");
    }

    #[test]
    fn malformed_output_is_a_parse_error() {
        for output in [
            &b""[..],
            b"# branch.oid x\0",
            b"# branch.head main\0# branch.ab +x -1\0",
            b"# branch.head main\0# branch.ab 1 2\0",
            b"# branch.head main\x001 M.\0",
            b"# branch.head main\x001 ZZ N... 1 1 1 a b c\0",
            b"# branch.head main\x002 R. N... 1 1 1 a b R100 new\0",
            b"# branch.head main\0X what\0",
        ] {
            assert!(
                matches!(parse_status(output), Err(GitError::Parse { .. })),
                "{:?} must fail",
                String::from_utf8_lossy(output)
            );
        }
    }

    #[test]
    fn unknown_headers_are_ignored() {
        let report = parse_status(branch_headers("# branch.future thing\0").as_bytes()).unwrap();
        assert_eq!(
            report.head,
            Head::Branch {
                name: "main".into()
            }
        );
    }

    #[test]
    fn remote_names_are_listed() {
        assert_eq!(parse_remotes(b"origin\nupstream\n"), ["origin", "upstream"]);
        assert!(parse_remotes(b"").is_empty());
    }
}
