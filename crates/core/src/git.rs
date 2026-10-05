//! Runs the git CLI.
//!
//! Every command is spawned directly with an argument vector (never through a
//! shell). Read commands are shaped so that reading a repository cannot
//! change it:
//!
//! - `--no-optional-locks` (and `GIT_OPTIONAL_LOCKS=0`) stops `git status`
//!   from refreshing and rewriting the index;
//! - `-c core.fsmonitor=false` stops a repository's own config from starting
//!   a file-system monitor command;
//! - `GIT_NO_LAZY_FETCH=1` stops partial clones from fetching missing objects,
//!   so a read never touches the network;
//! - `GIT_CEILING_DIRECTORIES` is the repository's parent, so git never walks
//!   up into an enclosing repository when the path is not a repository itself;
//! - inherited variables that redirect git to another repository or inject
//!   config (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_CONFIG_PARAMETERS`, ...) are
//!   removed.
//!
//! Only allow-listed subcommands in read-only forms can run (see
//! [`check_read_args`]).
//!
//! Write commands (the user's git actions, see [`crate::actions`]) share the
//! same isolation and pass through their own allow-list,
//! [`check_write_args`]: every subcommand has a fixed set of permitted
//! options, so no force, `-D`, `reset --hard`, rebase or amend form can be
//! built, and operands can never be read as options.

use std::ffi::OsString;
use std::fmt;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

/// Longest stderr kept in an error, in characters.
const MAX_STDERR_CHARS: usize = 2000;

/// Inherited variables that would point git at another repository, index or
/// object store, or inject config that overrides the read-only options.
const REDIRECTING_ENV_VARS: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
    "GIT_QUARANTINE_PATH",
    "GIT_INTERNAL_SUPER_PREFIX",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
];

/// Global options placed before every read subcommand.
const READ_GLOBAL_ARGS: &[&str] = &["--no-optional-locks", "-c", "core.fsmonitor=false"];

/// Global options placed before every write subcommand.
const WRITE_GLOBAL_ARGS: &[&str] = &["-c", "core.fsmonitor=false"];

/// Windows `CREATE_NO_WINDOW`: no console window flashes for each git run.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Why a git command could not produce a result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GitError {
    /// The git executable was not found.
    NotInstalled,
    /// The path is not absolute or not an existing folder.
    InvalidPath { path: PathBuf, reason: String },
    /// The folder is not a git repository.
    NotARepository { path: PathBuf },
    /// git refuses the repository because another user owns it
    /// (`safe.directory`). Repowatch never changes that setting.
    DubiousOwnership { path: PathBuf },
    /// The command is not an allowed command (read-only on the read path,
    /// non-destructive on the write path).
    Refused { command: String },
    /// A value supplied by the caller (branch name, path, object id, ...) is
    /// not acceptable. Nothing was run.
    InvalidInput { field: String, reason: String },
    /// The current branch cannot be fast-forwarded to its upstream: the two
    /// have diverged. Nothing was changed.
    NotFastForward,
    /// The remote refused the push, usually because it has commits the local
    /// branch lacks. Repowatch never force-pushes.
    PushRejected { stderr: String },
    /// The branch has commits that are not merged, so it was not deleted.
    BranchNotMerged { branch: String },
    /// A branch with this name already exists.
    BranchExists { branch: String },
    /// HEAD is detached, so there is no current branch to push or pull.
    DetachedHead,
    /// The current branch has no upstream to pull from.
    NoUpstream { branch: String },
    /// The repository has no remote to push to.
    NoRemote,
    /// Nothing is staged.
    NothingToCommit,
    /// The repository changed since the caller read it (for example a hunk or
    /// a stash no longer matches). Nothing was changed; read it again.
    Stale { what: String },
    /// git could not be started or its output could not be read.
    Io { message: String },
    /// git ran and failed.
    Failed { code: Option<i32>, stderr: String },
    /// git succeeded but its output was not in the expected format.
    Parse { message: String },
}

impl fmt::Display for GitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotInstalled => write!(
                f,
                "git was not found; install git and make sure it is on PATH"
            ),
            Self::InvalidPath { path, reason } => write!(f, "{}: {reason}", path.display()),
            Self::NotARepository { path } => {
                write!(f, "{} is not a git repository", path.display())
            }
            Self::DubiousOwnership { path } => write!(
                f,
                "git refuses {} because it is owned by another user (safe.directory)",
                path.display()
            ),
            Self::Refused { command } => {
                write!(f, "refused to run `git {command}`: not an allowed command")
            }
            Self::InvalidInput { field, reason } => write!(f, "invalid {field}: {reason}"),
            Self::NotFastForward => write!(
                f,
                "the branch has diverged from its upstream and cannot be fast-forwarded"
            ),
            Self::PushRejected { stderr } => write!(f, "the remote rejected the push: {stderr}"),
            Self::BranchNotMerged { branch } => {
                write!(f, "branch {branch} has commits that are not merged")
            }
            Self::BranchExists { branch } => write!(f, "branch {branch} already exists"),
            Self::DetachedHead => write!(f, "HEAD is detached; switch to a branch first"),
            Self::NoUpstream { branch } => write!(f, "branch {branch} has no upstream"),
            Self::NoRemote => write!(f, "the repository has no remote"),
            Self::NothingToCommit => write!(f, "nothing is staged"),
            Self::Stale { what } => write!(f, "{what} changed since it was read; refresh"),
            Self::Io { message } => write!(f, "could not run git: {message}"),
            Self::Failed {
                code: Some(code),
                stderr,
            } => write!(f, "git failed with exit code {code}: {stderr}"),
            Self::Failed { code: None, stderr } => write!(f, "git was terminated: {stderr}"),
            Self::Parse { message } => write!(f, "unexpected git output: {message}"),
        }
    }
}

impl std::error::Error for GitError {}

/// The git CLI, with optional extra environment (used by tests to isolate git
/// from the user's global config).
#[derive(Debug, Clone)]
pub struct Git {
    program: OsString,
    env: Vec<(OsString, OsString)>,
}

impl Default for Git {
    fn default() -> Self {
        Self::new()
    }
}

impl Git {
    /// Uses `git` from `PATH`.
    pub fn new() -> Self {
        Self {
            program: OsString::from("git"),
            env: Vec::new(),
        }
    }

    /// Uses another git executable.
    pub fn with_program(mut self, program: impl Into<OsString>) -> Self {
        self.program = program.into();
        self
    }

    /// Sets an extra environment variable for every command.
    pub fn with_env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }

    /// Builds the command for a read-only git invocation in `repo`.
    pub(crate) fn read_command(&self, repo: &Path, args: &[&str]) -> Result<Command, GitError> {
        check_read_args(args)?;
        let mut command = self.base_command(repo, READ_GLOBAL_ARGS)?;
        command.args(args);
        command
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_NO_LAZY_FETCH", "1");
        Ok(command)
    }

    /// Builds the command for a write action in `repo`. Standard input is
    /// piped when `stdin` is true and empty otherwise.
    pub(crate) fn write_command(
        &self,
        repo: &Path,
        args: &[&str],
        stdin: bool,
    ) -> Result<Command, GitError> {
        check_write_args(args)?;
        let mut command = self.base_command(repo, WRITE_GLOBAL_ARGS)?;
        command.args(args);
        // An editor would wait for a window nobody sees; messages are always
        // passed on standard input instead.
        command.env("GIT_EDITOR", ":");
        if stdin {
            command.stdin(Stdio::piped());
        }
        Ok(command)
    }

    /// The isolated command shared by reads and writes: git run directly in
    /// `repo` (absolute, existing), with redirecting variables removed.
    fn base_command(&self, repo: &Path, global_args: &[&str]) -> Result<Command, GitError> {
        if !repo.is_absolute() {
            return Err(GitError::InvalidPath {
                path: repo.to_path_buf(),
                reason: "path is not absolute".into(),
            });
        }
        if !repo.is_dir() {
            return Err(GitError::InvalidPath {
                path: repo.to_path_buf(),
                reason: "folder does not exist".into(),
            });
        }

        let mut command = Command::new(&self.program);
        command.args(global_args).arg("-C").arg(repo);
        for key in REDIRECTING_ENV_VARS {
            command.env_remove(key);
        }
        for (key, value) in &self.env {
            command.env(key, value);
        }
        command.env("GIT_TERMINAL_PROMPT", "0").env("LC_ALL", "C");
        if let Some(parent) = repo.parent() {
            command.env("GIT_CEILING_DIRECTORIES", parent);
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        Ok(command)
    }

    /// Runs a read-only git command in `repo` and returns its stdout.
    pub(crate) fn read(&self, repo: &Path, args: &[&str]) -> Result<Vec<u8>, GitError> {
        let output = self
            .read_command(repo, args)?
            .output()
            .map_err(spawn_error)?;
        if output.status.success() {
            return Ok(output.stdout);
        }
        Err(classify_failure(repo, output.status.code(), &output.stderr))
    }

    /// Runs a write action in `repo`, feeding `input` on standard input, and
    /// returns its stdout. On failure the error carries stderr followed by
    /// stdout, since some commands (`commit`) explain themselves on stdout.
    pub(crate) fn write(
        &self,
        repo: &Path,
        args: &[&str],
        input: Option<&[u8]>,
    ) -> Result<Vec<u8>, GitError> {
        let mut child = self
            .write_command(repo, args, input.is_some())?
            .spawn()
            .map_err(spawn_error)?;
        let (output, written) = std::thread::scope(|scope| {
            // Stdin is fed on its own thread so a large input cannot deadlock
            // against git filling the output pipes.
            let writer = child.stdin.take().map(|mut stdin| {
                let input = input.unwrap_or_default();
                scope.spawn(move || stdin.write_all(input))
            });
            let output = child.wait_with_output();
            let written = writer.map_or(Ok(()), |writer| {
                writer
                    .join()
                    .unwrap_or_else(|_| Err(io::Error::other("the stdin writer panicked")))
            });
            (output, written)
        });
        let io_error = |error: io::Error| GitError::Io {
            message: error.to_string(),
        };
        let output = output.map_err(io_error)?;
        if output.status.success() {
            // git must have received the whole input for the result to hold.
            written.map_err(io_error)?;
            return Ok(output.stdout);
        }
        // A failing git may close stdin early; its own error explains why.
        let mut text = output.stderr;
        if !output.stdout.is_empty() {
            text.push(b'\n');
            text.extend_from_slice(&output.stdout);
        }
        Err(classify_failure(repo, output.status.code(), &text))
    }
}

fn spawn_error(error: io::Error) -> GitError {
    match error.kind() {
        io::ErrorKind::NotFound => GitError::NotInstalled,
        _ => GitError::Io {
            message: error.to_string(),
        },
    }
}

/// Accepts only subcommands, in forms, that cannot write to the repository or
/// contact a remote.
pub(crate) fn check_read_args(args: &[&str]) -> Result<(), GitError> {
    let refused = || GitError::Refused {
        command: args.join(" "),
    };
    let (subcommand, rest) = args.split_first().ok_or_else(refused)?;
    // `--output` makes `log` and friends write a file; `--lost-found` makes
    // `fsck` write into the repository.
    if rest
        .iter()
        .any(|arg| arg.starts_with("--output") || arg.starts_with("--lost-found"))
    {
        return Err(refused());
    }
    let allowed = match *subcommand {
        "status" | "for-each-ref" | "log" | "rev-list" | "fsck" => true,
        // `--no-index` reads files outside the repository; external diff and
        // textconv drivers run commands from the repository's config.
        "diff" => !rest
            .iter()
            .any(|arg| matches!(*arg, "--no-index" | "--ext-diff" | "--textconv")),
        "rev-parse" => rest == ["--show-object-format"],
        // `git remote` lists names; every other form (add, remove, update,
        // show, prune, ...) writes or contacts the remote.
        "remote" => rest.iter().all(|arg| matches!(*arg, "-v" | "--verbose")),
        // With one name `symbolic-ref` reads a ref; with two it writes one,
        // and `-d` deletes it.
        "symbolic-ref" => {
            let names = rest.iter().filter(|arg| !arg.starts_with('-')).count();
            names == 1
                && rest
                    .iter()
                    .filter(|arg| arg.starts_with('-'))
                    .all(|arg| matches!(*arg, "-q" | "--quiet" | "--short"))
        }
        // Only the listing forms; add, remove, prune, drop, pop, ... write.
        "worktree" | "stash" => rest.first() == Some(&"list"),
        _ => false,
    };
    if allowed { Ok(()) } else { Err(refused()) }
}

/// The permitted shape of one write subcommand.
struct WriteRule {
    subcommand: &'static str,
    /// For `stash`: the permitted actions (its first word).
    actions: &'static [&'static str],
    /// Every option the subcommand may carry; any other argument starting
    /// with `-` before `--` is refused.
    options: &'static [&'static str],
    /// Options that must be present because they keep the command safe (for
    /// example `restore --staged` never touches the working tree).
    required: &'static [&'static str],
    /// Operands are paths and must be `:(literal)` pathspecs after `--`.
    pathspecs: bool,
    /// Allowed number of operands.
    min_operands: usize,
    max_operands: usize,
}

/// Prefix of every path operand: matches the path literally, without glob or
/// other pathspec magic.
pub(crate) const LITERAL_PATHSPEC: &str = ":(literal)";

/// The only write commands Repowatch can run. None of them can force,
/// delete an unmerged branch, reset, rebase, amend, discard working-tree
/// changes or delete a remote branch.
const WRITE_RULES: &[WriteRule] = &[
    WriteRule {
        subcommand: "add",
        actions: &[],
        options: &[],
        required: &[],
        pathspecs: true,
        min_operands: 1,
        max_operands: usize::MAX,
    },
    WriteRule {
        subcommand: "restore",
        actions: &[],
        // `--staged` alone never touches the working tree. Before the first
        // commit there is no HEAD to restore from, so the empty tree is the
        // source (SHA-1 and SHA-256 forms).
        options: &[
            "--staged",
            "--source=4b825dc642cb6eb9a060e54bf8d69288fbee4904",
            "--source=6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
        ],
        required: &["--staged"],
        pathspecs: true,
        min_operands: 1,
        max_operands: usize::MAX,
    },
    WriteRule {
        subcommand: "apply",
        actions: &[],
        options: &["--cached", "--reverse", "--whitespace=nowarn", "-"],
        required: &["--cached", "-"],
        pathspecs: false,
        min_operands: 0,
        max_operands: 0,
    },
    WriteRule {
        subcommand: "commit",
        actions: &[],
        options: &["--file=-", "--quiet"],
        required: &["--file=-"],
        pathspecs: false,
        min_operands: 0,
        max_operands: 0,
    },
    WriteRule {
        subcommand: "fetch",
        actions: &[],
        options: &["--all", "--quiet"],
        required: &[],
        pathspecs: false,
        min_operands: 0,
        max_operands: 1,
    },
    WriteRule {
        subcommand: "merge",
        actions: &[],
        options: &["--ff-only", "--no-autostash", "--quiet"],
        required: &["--ff-only"],
        pathspecs: false,
        min_operands: 1,
        max_operands: 1,
    },
    WriteRule {
        subcommand: "push",
        actions: &[],
        options: &["--porcelain", "--set-upstream"],
        required: &[],
        pathspecs: false,
        min_operands: 2,
        max_operands: 2,
    },
    WriteRule {
        subcommand: "branch",
        actions: &[],
        // `-d` (lower case) deletes only a merged branch; see the operand
        // check below.
        options: &["--no-track", "-d"],
        required: &[],
        pathspecs: false,
        min_operands: 1,
        max_operands: 2,
    },
    WriteRule {
        subcommand: "switch",
        actions: &[],
        options: &["--no-guess"],
        required: &["--no-guess"],
        pathspecs: false,
        min_operands: 1,
        max_operands: 1,
    },
    WriteRule {
        subcommand: "stash",
        actions: &["apply", "drop"],
        options: &["--quiet"],
        required: &[],
        pathspecs: false,
        min_operands: 1,
        max_operands: 1,
    },
];

/// Accepts only the write commands of [`WRITE_RULES`], in their permitted
/// forms.
pub(crate) fn check_write_args(args: &[&str]) -> Result<(), GitError> {
    let refused = || GitError::Refused {
        command: args.join(" "),
    };
    let (subcommand, mut rest) = args.split_first().ok_or_else(refused)?;
    let rule = WRITE_RULES
        .iter()
        .find(|rule| rule.subcommand == *subcommand)
        .ok_or_else(refused)?;
    if !rule.actions.is_empty() {
        let (action, after) = rest.split_first().ok_or_else(refused)?;
        if !rule.actions.contains(action) {
            return Err(refused());
        }
        rest = after;
    }

    let mut options = Vec::new();
    let mut operands = Vec::new();
    let mut after_separator = false;
    for arg in rest {
        if after_separator {
            operands.push(*arg);
        } else if *arg == "--" {
            after_separator = true;
        } else if arg.starts_with('-') {
            if !rule.options.contains(arg) || options.contains(arg) {
                return Err(refused());
            }
            options.push(*arg);
        } else if rule.pathspecs {
            // Paths only after `--`, where they cannot be options.
            return Err(refused());
        } else {
            operands.push(*arg);
        }
    }
    let operand_ok = |operand: &&str| {
        if rule.pathspecs {
            operand
                .strip_prefix(LITERAL_PATHSPEC)
                .is_some_and(|path| !path.is_empty())
        } else {
            // A leading `+` forces a refspec and a leading `:` deletes the
            // remote ref; `-` would be an option.
            !operand.is_empty() && !operand.starts_with(['-', '+', ':'])
        }
    };
    let deleting = options.contains(&"-d");
    if !rule.required.iter().all(|option| options.contains(option))
        || operands.len() < rule.min_operands
        || operands.len() > rule.max_operands
        || !operands.iter().all(operand_ok)
        || (deleting && (operands.len() != 1 || options.contains(&"--no-track")))
    {
        return Err(refused());
    }
    Ok(())
}

fn classify_failure(repo: &Path, code: Option<i32>, stderr: &[u8]) -> GitError {
    let text = String::from_utf8_lossy(stderr);
    let lower = text.to_lowercase();
    if lower.contains("not a git repository") {
        return GitError::NotARepository {
            path: repo.to_path_buf(),
        };
    }
    if lower.contains("dubious ownership") {
        return GitError::DubiousOwnership {
            path: repo.to_path_buf(),
        };
    }
    let trimmed = text.trim();
    let stderr = match trimmed.char_indices().nth(MAX_STDERR_CHARS) {
        Some((cut, _)) => format!("{}…", &trimmed[..cut]),
        None => trimmed.to_string(),
    };
    GitError::Failed { code, stderr }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    fn temp_repo_dir() -> PathBuf {
        std::env::temp_dir()
    }

    fn args_of(command: &Command) -> Vec<String> {
        command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn read_command_runs_git_directly_with_read_only_options() {
        let repo = temp_repo_dir();
        let command = Git::new()
            .read_command(&repo, &["status", "--porcelain=v2"])
            .unwrap();
        assert_eq!(command.get_program(), OsStr::new("git"));
        let args = args_of(&command);
        assert_eq!(
            args,
            [
                "--no-optional-locks",
                "-c",
                "core.fsmonitor=false",
                "-C",
                &repo.to_string_lossy(),
                "status",
                "--porcelain=v2"
            ]
        );
        assert!(!args.iter().any(|arg| arg.contains("fetch")));
    }

    #[test]
    fn read_command_sets_safety_environment_and_drops_redirections() {
        let repo = temp_repo_dir();
        let command = Git::new()
            .with_env("GIT_CONFIG_NOSYSTEM", "1")
            .read_command(&repo, &["status"])
            .unwrap();
        let envs: Vec<(String, Option<String>)> = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();
        let get = |name: &str| {
            envs.iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.clone())
        };
        assert_eq!(get("GIT_OPTIONAL_LOCKS"), Some(Some("0".into())));
        assert_eq!(get("GIT_NO_LAZY_FETCH"), Some(Some("1".into())));
        assert_eq!(get("GIT_TERMINAL_PROMPT"), Some(Some("0".into())));
        assert_eq!(get("GIT_CONFIG_NOSYSTEM"), Some(Some("1".into())));
        for name in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_CONFIG_PARAMETERS",
        ] {
            assert_eq!(get(name), Some(None), "{name} must be removed");
        }
        let ceiling = get("GIT_CEILING_DIRECTORIES").flatten().unwrap();
        assert_eq!(PathBuf::from(ceiling), repo.parent().unwrap());
    }

    #[test]
    fn write_and_network_commands_are_refused_on_the_read_path() {
        for args in [
            &["fetch"][..],
            &["pull"],
            &["push"],
            &["commit", "-m", "x"],
            &["gc"],
            &["checkout", "main"],
            &["remote", "update"],
            &["remote", "add", "x", "y"],
            &["remote", "show", "origin"],
            &["remote", "prune", "origin"],
            &["symbolic-ref", "HEAD", "refs/heads/x"],
            &["symbolic-ref", "-d", "refs/remotes/origin/HEAD"],
            &["symbolic-ref", "-m", "msg", "HEAD"],
            &["worktree", "prune"],
            &["worktree", "add", "x"],
            &["worktree"],
            &["stash"],
            &["stash", "drop"],
            &["stash", "pop"],
            &["fsck", "--lost-found"],
            &["log", "--output=x.txt"],
            &["log", "--output", "x.txt"],
            &["reflog", "expire"],
            &["update-ref", "refs/heads/x", "HEAD"],
            &["branch", "-D", "x"],
            &[],
        ] {
            let result = Git::new().read_command(&temp_repo_dir(), args);
            assert!(
                matches!(result, Err(GitError::Refused { .. })),
                "{args:?} must be refused"
            );
        }
        assert!(check_read_args(&["status", "--porcelain=v2", "-z"]).is_ok());
        assert!(check_read_args(&["remote"]).is_ok());
        assert!(check_read_args(&["remote", "-v"]).is_ok());
        assert!(check_read_args(&["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]).is_ok());
        assert!(check_read_args(&["worktree", "list", "--porcelain", "-z"]).is_ok());
        assert!(check_read_args(&["stash", "list", "-z"]).is_ok());
        assert!(check_read_args(&["fsck", "--unreachable", "--no-reflogs"]).is_ok());
        assert!(check_read_args(&["for-each-ref", "refs/heads"]).is_ok());
    }

    #[test]
    fn diff_and_object_format_reads_are_allowed_in_safe_forms_only() {
        assert!(
            check_read_args(&["diff", "--cached", "--no-ext-diff", "--", ":(literal)a"]).is_ok()
        );
        assert!(check_read_args(&["rev-parse", "--show-object-format"]).is_ok());
        for args in [
            &["diff", "--no-index", "a", "b"][..],
            &["diff", "--ext-diff"],
            &["diff", "--textconv"],
            &["diff", "--output=x"],
            &["rev-parse"],
            &["rev-parse", "HEAD"],
        ] {
            assert!(check_read_args(args).is_err(), "{args:?} must be refused");
        }
    }

    /// Every form of force, `-D`, `reset --hard`, rebase and amend, plus
    /// other destructive commands, is refused by the write allow-list.
    #[test]
    fn destructive_write_forms_are_refused() {
        for args in [
            // Force pushes and remote deletions.
            &[
                "push",
                "--force",
                "--",
                "origin",
                "refs/heads/a:refs/heads/a",
            ][..],
            &["push", "-f", "--", "origin", "refs/heads/a:refs/heads/a"],
            &[
                "push",
                "--force-with-lease",
                "--",
                "origin",
                "refs/heads/a:refs/heads/a",
            ],
            &[
                "push",
                "--force-if-includes",
                "--",
                "origin",
                "refs/heads/a:refs/heads/a",
            ],
            &["push", "--", "origin", "+refs/heads/a:refs/heads/a"],
            &["push", "--", "origin", ":refs/heads/a"],
            &["push", "--delete", "--", "origin", "refs/heads/a"],
            &["push", "--mirror", "--", "origin", "x"],
            &["push", "--all", "--", "origin", "x"],
            &["push", "--", "--force", "origin"],
            &["push", "origin", "+main"],
            &["push"],
            // Unmerged branch deletion, forced moves and renames.
            &["branch", "-D", "--", "a"],
            &["branch", "--delete", "--force", "--", "a"],
            &["branch", "-d", "-f", "--", "a"],
            &["branch", "-df", "--", "a"],
            &["branch", "-f", "--", "a", "HEAD"],
            &["branch", "--force", "--", "a"],
            &["branch", "-M", "--", "a", "b"],
            &["branch", "-m", "--", "a", "b"],
            &["branch", "-C", "--", "a", "b"],
            &["branch", "-d", "--", "a", "b"],
            &["branch", "-d", "-d", "--", "a"],
            &["branch", "--", "-D"],
            // Resets, rebases, amends and history rewriting.
            &["reset", "--hard"],
            &["reset", "--hard", "HEAD~1"],
            &["reset", "--keep", "HEAD~1"],
            &["reset", "--quiet", "--", ":(literal)a"],
            &["rebase", "main"],
            &["rebase", "--continue"],
            &["pull", "--rebase"],
            &["pull", "--ff-only"],
            &["merge", "main"],
            &["merge", "--ff-only", "--rebase", "--", "main"],
            &["merge", "--no-ff", "--", "main"],
            &["commit", "--amend", "--file=-"],
            &["commit", "--file=-", "--amend"],
            &["commit", "--file=-", "--fixup=HEAD"],
            &["commit", "-m", "x"],
            &["commit", "--file=-", "-a"],
            &["commit", "--file=-", "--", ":(literal)a"],
            &["filter-branch"],
            &["update-ref", "refs/heads/a", "HEAD"],
            &["reflog", "expire", "--all"],
            &["gc", "--prune=now"],
            // Discarding working-tree changes.
            &["checkout", "--", "a"],
            &["checkout", "-f", "main"],
            &["clean", "-fd"],
            &["restore", "--", ":(literal)a"],
            &["restore", "--staged", "--worktree", "--", ":(literal)a"],
            &[
                "restore",
                "--staged",
                "--source=HEAD~3",
                "--",
                ":(literal)a",
            ],
            &["switch", "--no-guess", "--discard-changes", "--", "a"],
            &["switch", "--no-guess", "--force", "--", "a"],
            &["switch", "--no-guess", "-C", "a"],
            &["switch", "--no-guess", "--detach", "--", "a"],
            &["switch", "--", "a"],
            &["rm", "--cached", "--", ":(literal)a"],
            &["stash", "pop"],
            &["stash", "clear"],
            &["stash", "drop", "--", "stash@{0}", "stash@{1}"],
            &["stash", "push"],
            &["stash"],
            // Index-only commands that would touch the working tree.
            &["apply", "-"],
            &["apply", "--index", "-"],
            &["apply", "--cached", "patch.diff"],
            &["apply", "--cached", "-", "--unsafe-paths"],
            // Pathspec magic and paths read as options.
            &["add", "--", "*"],
            &["add", "--", ":(glob)**"],
            &["add", "--", ":(literal)"],
            &["add", ":(literal)a"],
            &["add", "-A"],
            &["add", "--all"],
            &["add", "-f", "--", ":(literal)a"],
            // Fetch forms that delete or rewrite refs.
            &["fetch", "--prune"],
            &["fetch", "--", "origin", "+refs/heads/*:refs/heads/*"],
            &["fetch", "--force"],
            &["fetch", "--upload-pack=x", "--", "origin"],
            &["fetch", "--", "-oProxy"],
            &[],
        ] {
            assert!(
                matches!(check_write_args(args), Err(GitError::Refused { .. })),
                "{args:?} must be refused"
            );
        }
    }

    #[test]
    fn the_action_forms_are_allowed() {
        for args in [
            &["add", "--", ":(literal)src/a.txt", ":(literal)-A"][..],
            &["restore", "--staged", "--", ":(literal)a"],
            &[
                "restore",
                "--staged",
                "--source=4b825dc642cb6eb9a060e54bf8d69288fbee4904",
                "--",
                ":(literal)a",
            ],
            &["apply", "--cached", "--whitespace=nowarn", "-"],
            &["apply", "--cached", "--reverse", "--whitespace=nowarn", "-"],
            &["commit", "--quiet", "--file=-"],
            &["fetch", "--quiet", "--", "origin"],
            &["fetch", "--quiet", "--all"],
            &[
                "merge",
                "--ff-only",
                "--no-autostash",
                "--quiet",
                "--",
                "refs/remotes/origin/main",
            ],
            &[
                "push",
                "--porcelain",
                "--",
                "origin",
                "refs/heads/a:refs/heads/a",
            ],
            &[
                "push",
                "--porcelain",
                "--set-upstream",
                "--",
                "origin",
                "refs/heads/a:refs/heads/a",
            ],
            &["branch", "--no-track", "--", "feature/a"],
            &[
                "branch",
                "--no-track",
                "--",
                "feature/a",
                "1111111111111111111111111111111111111111",
            ],
            &["branch", "-d", "--", "feature/a"],
            &["switch", "--no-guess", "--", "feature/a"],
            &["stash", "apply", "--quiet", "--", "stash@{2}"],
            &["stash", "drop", "--quiet", "--", "stash@{0}"],
        ] {
            assert!(check_write_args(args).is_ok(), "{args:?} must be allowed");
        }
    }

    #[test]
    fn write_command_keeps_the_isolation_and_disables_the_editor() {
        let repo = temp_repo_dir();
        let command = Git::new()
            .write_command(&repo, &["commit", "--quiet", "--file=-"], true)
            .unwrap();
        let args = args_of(&command);
        assert_eq!(
            args,
            [
                "-c",
                "core.fsmonitor=false",
                "-C",
                &repo.to_string_lossy(),
                "commit",
                "--quiet",
                "--file=-"
            ]
        );
        let env = |name: &str| {
            command
                .get_envs()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.map(|v| v.to_string_lossy().into_owned()))
        };
        assert_eq!(env("GIT_EDITOR"), Some(Some(":".into())));
        assert_eq!(env("GIT_TERMINAL_PROMPT"), Some(Some("0".into())));
        assert_eq!(env("GIT_DIR"), Some(None));
        assert_eq!(env("GIT_CONFIG_PARAMETERS"), Some(None));
        assert!(matches!(
            Git::new().write_command(&repo, &["push", "--force"], false),
            Err(GitError::Refused { .. })
        ));
        assert!(matches!(
            Git::new().write_command(Path::new("relative"), &["add", "--", ":(literal)a"], false),
            Err(GitError::InvalidPath { .. })
        ));
    }

    #[test]
    fn relative_and_missing_paths_are_rejected_before_running_git() {
        let relative = Git::new().read_command(Path::new("some/relative"), &["status"]);
        assert!(matches!(relative, Err(GitError::InvalidPath { .. })));
        let missing = Git::new().read_command(
            &temp_repo_dir().join("repowatch-missing-\u{1F680}"),
            &["status"],
        );
        assert!(matches!(missing, Err(GitError::InvalidPath { .. })));
    }

    #[test]
    fn failures_are_classified_and_stderr_is_capped() {
        let repo = Path::new("/r");
        assert!(matches!(
            classify_failure(
                repo,
                Some(128),
                b"fatal: not a git repository (or any of the parent directories): .git"
            ),
            GitError::NotARepository { .. }
        ));
        assert!(matches!(
            classify_failure(
                repo,
                Some(128),
                b"fatal: detected dubious ownership in repository at '/r'"
            ),
            GitError::DubiousOwnership { .. }
        ));
        let long = "é".repeat(MAX_STDERR_CHARS + 10);
        match classify_failure(repo, Some(1), long.as_bytes()) {
            GitError::Failed {
                code: Some(1),
                stderr,
            } => assert_eq!(stderr.chars().count(), MAX_STDERR_CHARS + 1),
            other => panic!("unexpected {other:?}"),
        }
    }
}
