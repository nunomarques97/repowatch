//! Opens a discovered repository in VS Code, a terminal or the file manager.
//!
//! The repository path is the only input and it is always a discovered
//! repository (checked by the caller). No shell is involved: programs are
//! started directly. Where a program would parse the path as options or
//! commands (Windows Terminal splits arguments on `;`), the path is passed as
//! the working folder instead of as an argument.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::error::CommandError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenTarget {
    VsCode,
    Terminal,
    FileManager,
}

impl OpenTarget {
    fn label(self) -> &'static str {
        match self {
            Self::VsCode => "VS Code",
            Self::Terminal => "a terminal",
            Self::FileManager => "the file manager",
        }
    }
}

/// A program start, separated from spawning so it can be tested.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub current_dir: Option<PathBuf>,
    /// Windows: open a new console window for the program.
    pub new_console: bool,
}

/// How to open `repo` in `target`. `find` looks a program up on `PATH`.
pub fn plan(
    target: OpenTarget,
    repo: &Path,
    find: &dyn Fn(&str) -> Option<PathBuf>,
) -> Result<Launch, CommandError> {
    let unavailable = |message: &str| CommandError::OpenFailed {
        target: target.label().into(),
        message: message.into(),
    };
    let launch = |program: PathBuf, args: Vec<OsString>, current_dir: Option<&Path>| Launch {
        program,
        args,
        current_dir: current_dir.map(Path::to_path_buf),
        new_console: false,
    };
    let path_arg = || vec![OsString::from(repo)];
    match target {
        OpenTarget::VsCode => {
            // `code` is a .cmd script on Windows; Rust quotes batch arguments
            // safely or refuses to run. `--` ends option parsing.
            let program = find("code")
                .ok_or_else(|| unavailable("VS Code's `code` command is not on PATH"))?;
            let mut args = vec![OsString::from("--")];
            args.extend(path_arg());
            Ok(launch(program, args, None))
        }
        OpenTarget::Terminal if cfg!(windows) => match find("wt") {
            Some(wt) => Ok(launch(wt, vec!["-d".into(), ".".into()], Some(repo))),
            None => {
                let cmd = find("cmd").ok_or_else(|| unavailable("cmd.exe was not found"))?;
                Ok(Launch {
                    new_console: true,
                    ..launch(cmd, Vec::new(), Some(repo))
                })
            }
        },
        OpenTarget::Terminal if cfg!(target_os = "macos") => Ok(launch(
            PathBuf::from("/usr/bin/open"),
            vec!["-a".into(), "Terminal".into(), repo.into()],
            None,
        )),
        OpenTarget::Terminal => {
            let program = find("x-terminal-emulator")
                .or_else(|| find("gnome-terminal"))
                .or_else(|| find("konsole"))
                .ok_or_else(|| unavailable("no terminal program was found"))?;
            Ok(launch(program, Vec::new(), Some(repo)))
        }
        OpenTarget::FileManager if cfg!(windows) => {
            // An absolute path never starts with `/`, so explorer cannot read
            // it as a switch.
            let explorer =
                find("explorer").ok_or_else(|| unavailable("explorer.exe was not found"))?;
            Ok(launch(explorer, path_arg(), None))
        }
        OpenTarget::FileManager if cfg!(target_os = "macos") => Ok(launch(
            PathBuf::from("/usr/bin/open"),
            vec!["--".into(), repo.into()],
            None,
        )),
        OpenTarget::FileManager => {
            let program = find("xdg-open").ok_or_else(|| unavailable("xdg-open was not found"))?;
            Ok(launch(program, path_arg(), None))
        }
    }
}

/// Starts the program without waiting for it.
pub fn spawn(target: OpenTarget, launch: &Launch) -> Result<(), CommandError> {
    let mut command = Command::new(&launch.program);
    command
        .args(&launch.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(dir) = &launch.current_dir {
        command.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        command.creation_flags(if launch.new_console {
            CREATE_NEW_CONSOLE
        } else {
            CREATE_NO_WINDOW
        });
    }
    command
        .spawn()
        .map(drop)
        .map_err(|error| CommandError::OpenFailed {
            target: target.label().into(),
            message: error.to_string(),
        })
}

/// Finds a program on `PATH` (with the `PATHEXT` extensions on Windows).
pub fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let extensions: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .filter(|ext| !ext.is_empty())
            .map(str::to_lowercase)
            .collect()
    } else {
        vec![String::new()]
    };
    std::env::split_paths(&path)
        .filter(|dir| dir.is_absolute())
        .flat_map(|dir| {
            extensions
                .iter()
                .map(move |ext| dir.join(format!("{name}{ext}")))
        })
        .find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(path: &str) -> impl Fn(&str) -> Option<PathBuf> + '_ {
        move |name| Some(PathBuf::from(format!("{path}/{name}")))
    }

    #[test]
    fn vs_code_gets_the_path_after_end_of_options() {
        let repo = std::env::temp_dir().join("-rf; calc & x");
        let launch = plan(OpenTarget::VsCode, &repo, &found("/bin")).unwrap();
        assert_eq!(launch.program, PathBuf::from("/bin/code"));
        assert_eq!(
            launch.args,
            vec![OsString::from("--"), OsString::from(&repo)]
        );
        assert_eq!(launch.current_dir, None);
    }

    #[test]
    fn missing_programs_are_reported() {
        let repo = std::env::temp_dir();
        for target in [
            OpenTarget::VsCode,
            OpenTarget::Terminal,
            OpenTarget::FileManager,
        ] {
            if cfg!(target_os = "macos") && target != OpenTarget::VsCode {
                continue;
            }
            assert!(matches!(
                plan(target, &repo, &|_| None),
                Err(CommandError::OpenFailed { .. })
            ));
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_terminal_receives_the_path_as_working_folder_only() {
        let repo = PathBuf::from(r"C:\repos\a;new-tab cmd");
        let launch = plan(OpenTarget::Terminal, &repo, &found(r"C:\bin")).unwrap();
        assert_eq!(launch.args, vec![OsString::from("-d"), OsString::from(".")]);
        assert_eq!(launch.current_dir, Some(repo.clone()));
        assert!(
            !launch
                .args
                .iter()
                .any(|arg| arg.to_string_lossy().contains("new-tab"))
        );

        let without_wt =
            |name: &str| (name != "wt").then(|| PathBuf::from(format!(r"C:\bin\{name}")));
        let launch = plan(OpenTarget::Terminal, &repo, &without_wt).unwrap();
        assert!(launch.new_console);
        assert!(launch.args.is_empty());
        assert_eq!(launch.current_dir, Some(repo));
    }

    #[cfg(windows)]
    #[test]
    fn explorer_gets_the_absolute_path() {
        let repo = PathBuf::from(r"C:\repos\a");
        let launch = plan(OpenTarget::FileManager, &repo, &found(r"C:\Windows")).unwrap();
        assert_eq!(launch.args, vec![OsString::from(&repo)]);
    }

    #[test]
    fn targets_deserialize_from_camel_case_only() {
        assert_eq!(
            serde_json::from_str::<OpenTarget>("\"vsCode\"").unwrap(),
            OpenTarget::VsCode
        );
        assert!(serde_json::from_str::<OpenTarget>("\"cmd\"").is_err());
    }
}
