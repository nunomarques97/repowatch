//! Finds git repositories and linked worktrees under root folders.
//!
//! Discovery reads the file system only; it never runs git. It does not
//! descend into a repository it found (nested repositories and submodules
//! belong to their parent), skips tool and build folders by name, skips
//! user-excluded paths, does not follow symbolic links or junctions, and
//! records unreadable folders as issues instead of failing.
//!
//! Linked worktrees are found two ways: as folders under a root (their `.git`
//! is a file pointing into the main repository), and from the
//! `.git/worktrees/*/gitdir` entries of every main repository found, so a
//! worktree inside its main repository or outside the roots is listed too.
//! Worktrees whose folder no longer exists are ignored.

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

/// Folder names skipped by default: dependency, cache and build output
/// folders, and tool caches that hold git checkouts the user does not own.
pub const DEFAULT_SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".cache",
    "target",
    "build",
    "dist",
    ".next",
    ".nuxt",
    ".venv",
    "venv",
    "__pycache__",
    ".gradle",
    ".tox",
    ".cargo",
    ".rustup",
    ".npm",
    ".nuget",
    "$RECYCLE.BIN",
    "System Volume Information",
];

/// Default limit of folder levels below a root.
pub const DEFAULT_MAX_DEPTH: usize = 12;

/// Largest `.git` or `gitdir` file read; real ones are one short line.
const MAX_POINTER_FILE_BYTES: u64 = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveryOptions {
    /// Paths skipped with everything below them.
    pub excluded: Vec<PathBuf>,
    /// Folder names skipped anywhere (compared ignoring ASCII case).
    pub skip_dir_names: Vec<String>,
    /// Folder levels below a root that are searched.
    pub max_depth: usize,
}

impl Default for DiscoveryOptions {
    fn default() -> Self {
        Self {
            excluded: Vec::new(),
            skip_dir_names: DEFAULT_SKIP_DIRS
                .iter()
                .map(|name| name.to_string())
                .collect(),
            max_depth: DEFAULT_MAX_DEPTH,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RepoKind {
    /// A repository's main working tree.
    Main,
    /// A linked worktree (`git worktree add`).
    #[serde(rename_all = "camelCase")]
    LinkedWorktree {
        /// The shared git folder of the main repository.
        common_dir: PathBuf,
        /// The main working tree, when the common folder is a `.git` folder.
        main_path: Option<PathBuf>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredRepo {
    /// Root of the working tree.
    pub path: PathBuf,
    /// The git folder of this working tree.
    pub git_dir: PathBuf,
    #[serde(flatten)]
    pub kind: RepoKind,
}

/// A folder that could not be read; discovery continued without it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryIssue {
    pub path: PathBuf,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    /// Found repositories and worktrees, sorted by path.
    pub repos: Vec<DiscoveredRepo>,
    pub issues: Vec<DiscoveryIssue>,
}

/// Finds repositories and linked worktrees under `roots`.
pub fn discover(roots: &[PathBuf], options: &DiscoveryOptions) -> Discovery {
    let mut walker = Walker {
        excluded: options
            .excluded
            .iter()
            .filter_map(|path| std::path::absolute(path).ok())
            .map(|p| key(&p))
            .collect(),
        options,
        seen: HashSet::new(),
        result: Discovery::default(),
    };
    for root in roots {
        walker.walk_root(root);
    }
    walker.add_linked_worktrees();
    let mut result = walker.result;
    result.repos.sort_by_cached_key(|repo| key(&repo.path));
    result.issues.sort_by_cached_key(|issue| key(&issue.path));
    result
}

struct Walker<'a> {
    options: &'a DiscoveryOptions,
    excluded: Vec<String>,
    seen: HashSet<String>,
    result: Discovery,
}

enum Probe {
    Repo(DiscoveredRepo),
    /// A bare repository, or a `.git` entry that is not a valid repository:
    /// neither listed nor searched.
    Skip,
    /// An ordinary folder.
    Folder,
}

impl Walker<'_> {
    fn walk_root(&mut self, root: &Path) {
        let root = match std::path::absolute(root) {
            Ok(root) => root,
            Err(error) => return self.issue(root, format!("invalid root: {error}")),
        };
        if self.is_excluded(&root) {
            return;
        }
        match fs::metadata(&root) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => return self.issue(&root, "root is not a folder".into()),
            Err(error) => return self.issue(&root, format!("cannot open root: {error}")),
        }

        let mut stack = vec![(root, 0usize)];
        while let Some((dir, depth)) = stack.pop() {
            match probe(&dir) {
                Probe::Repo(repo) => {
                    self.add(repo);
                    continue;
                }
                Probe::Skip => continue,
                Probe::Folder => {}
            }
            if depth >= self.options.max_depth {
                continue;
            }
            let entries = match fs::read_dir(&dir) {
                Ok(entries) => entries,
                Err(error) => {
                    self.issue(&dir, format!("cannot read folder: {error}"));
                    continue;
                }
            };
            for entry in entries {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(error) => {
                        self.issue(&dir, format!("cannot read folder entry: {error}"));
                        continue;
                    }
                };
                // file_type does not follow links: symbolic links and
                // junctions are neither directories here nor followed.
                let Ok(file_type) = entry.file_type() else {
                    continue;
                };
                if !file_type.is_dir() || file_type.is_symlink() {
                    continue;
                }
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name == ".git"
                    || self
                        .options
                        .skip_dir_names
                        .iter()
                        .any(|skip| skip.eq_ignore_ascii_case(&name))
                {
                    continue;
                }
                let path = entry.path();
                if !self.is_excluded(&path) {
                    stack.push((path, depth + 1));
                }
            }
        }
    }

    /// Adds the existing linked worktrees registered in each main repository.
    fn add_linked_worktrees(&mut self) {
        let mains: Vec<PathBuf> = self
            .result
            .repos
            .iter()
            .filter(|repo| repo.kind == RepoKind::Main)
            .map(|repo| repo.git_dir.clone())
            .collect();
        for git_dir in mains {
            let Ok(entries) = fs::read_dir(git_dir.join("worktrees")) else {
                continue;
            };
            for entry in entries.flatten() {
                let admin = entry.path();
                let Some(dot_git) = read_pointer_file(&admin.join("gitdir")) else {
                    continue;
                };
                let dot_git = resolve(&admin, &dot_git);
                let Some(worktree) = dot_git
                    .parent()
                    .and_then(|parent| std::path::absolute(parent).ok())
                else {
                    continue;
                };
                if self.is_excluded(&worktree) || self.seen.contains(&key(&worktree)) {
                    continue;
                }
                if let Probe::Repo(repo) = probe(&worktree) {
                    if matches!(repo.kind, RepoKind::LinkedWorktree { .. }) {
                        self.add(repo);
                    }
                }
            }
        }
    }

    fn add(&mut self, repo: DiscoveredRepo) {
        if self.seen.insert(key(&repo.path)) {
            self.result.repos.push(repo);
        }
    }

    fn issue(&mut self, path: &Path, message: String) {
        self.result.issues.push(DiscoveryIssue {
            path: path.to_path_buf(),
            message,
        });
    }

    fn is_excluded(&self, path: &Path) -> bool {
        let path = key(path);
        self.excluded
            .iter()
            .any(|excluded| is_same_or_inside(&path, excluded))
    }
}

/// Classifies a folder without running git.
fn probe(dir: &Path) -> Probe {
    let dot_git = dir.join(".git");
    match fs::metadata(&dot_git) {
        Ok(metadata) if metadata.is_dir() => {
            if dot_git.join("HEAD").is_file() {
                Probe::Repo(DiscoveredRepo {
                    path: dir.to_path_buf(),
                    git_dir: dot_git,
                    kind: RepoKind::Main,
                })
            } else {
                Probe::Skip
            }
        }
        Ok(_) => probe_git_file(dir, &dot_git),
        Err(_) if is_bare_repository(dir) => Probe::Skip,
        Err(_) => Probe::Folder,
    }
}

/// A `.git` file (`gitdir: <path>`) marks a linked worktree, a submodule or a
/// repository with a separate git folder.
fn probe_git_file(dir: &Path, dot_git: &Path) -> Probe {
    let Some(target) = read_pointer_file(dot_git) else {
        return Probe::Skip;
    };
    let git_dir = resolve(dir, &target);
    if !git_dir.join("HEAD").is_file() {
        return Probe::Skip;
    }
    let kind = match read_pointer_file(&git_dir.join("commondir")) {
        Some(common) => {
            let common_dir = resolve(&git_dir, &common);
            let main_path = (common_dir.file_name().is_some_and(|name| name == ".git"))
                .then(|| common_dir.parent().map(Path::to_path_buf))
                .flatten();
            RepoKind::LinkedWorktree {
                common_dir,
                main_path,
            }
        }
        None => RepoKind::Main,
    };
    Probe::Repo(DiscoveredRepo {
        path: dir.to_path_buf(),
        git_dir,
        kind,
    })
}

fn is_bare_repository(dir: &Path) -> bool {
    dir.join("HEAD").is_file() && dir.join("objects").is_dir() && dir.join("refs").is_dir()
}

/// Reads a one-line pointer file (`.git`, `gitdir`, `commondir`); a
/// `gitdir: ` prefix is removed.
fn read_pointer_file(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut text = String::new();
    file.take(MAX_POINTER_FILE_BYTES)
        .read_to_string(&mut text)
        .ok()?;
    let line = text.lines().next()?.trim();
    let line = line.strip_prefix("gitdir:").map(str::trim).unwrap_or(line);
    (!line.is_empty()).then(|| line.to_string())
}

/// Resolves a pointer relative to `base` and normalizes it.
fn resolve(base: &Path, target: &str) -> PathBuf {
    let joined = base.join(target);
    std::path::absolute(&joined)
        .map(|path| normalize(&path))
        .unwrap_or(joined)
}

/// Removes `.` and `..` components lexically (`std::path::absolute` keeps
/// them on Unix).
pub(crate) fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// Comparison key of a path: normalized, `/`-separated and, on Windows,
/// case-insensitive.
pub(crate) fn key(path: &Path) -> String {
    let parts: Vec<String> = normalize(path)
        .components()
        .filter_map(|component| match component {
            Component::Prefix(prefix) => Some(prefix.as_os_str().to_string_lossy().into_owned()),
            Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    let joined = parts.join("/");
    if cfg!(windows) {
        joined.to_lowercase()
    } else {
        joined
    }
}

fn is_same_or_inside(path: &str, ancestor: &str) -> bool {
    path == ancestor
        || path
            .strip_prefix(ancestor)
            .is_some_and(|rest| rest.starts_with('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_ignore_separators_dots_and_windows_case() {
        let base = std::env::temp_dir();
        assert_eq!(
            key(&base.join("a").join("..").join("b")),
            key(&base.join("b"))
        );
        assert_eq!(key(&base.join("./c")), key(&base.join("c")));
        if cfg!(windows) {
            assert_eq!(key(Path::new(r"C:\Users\X")), key(Path::new("c:/users/x")));
        }
    }

    #[test]
    fn exclusion_matches_whole_components_only() {
        assert!(is_same_or_inside("c:/work/repo", "c:/work/repo"));
        assert!(is_same_or_inside("c:/work/repo/sub", "c:/work/repo"));
        assert!(!is_same_or_inside("c:/work/repo-2", "c:/work/repo"));
    }

    #[test]
    fn pointer_files_accept_gitdir_prefix_and_plain_paths() {
        let dir = std::env::temp_dir().join(format!("repowatch-pointer-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("pointer");
        fs::write(&file, "gitdir: ../x/.git/worktrees/a\r\n").unwrap();
        assert_eq!(
            read_pointer_file(&file).as_deref(),
            Some("../x/.git/worktrees/a")
        );
        fs::write(&file, "../..\n").unwrap();
        assert_eq!(read_pointer_file(&file).as_deref(), Some("../.."));
        fs::write(&file, "\n").unwrap();
        assert_eq!(read_pointer_file(&file), None);
        fs::remove_dir_all(&dir).unwrap();
    }
}
