//! The error every command returns, serialized for the frontend.

use std::fmt;

use repowatch_core::GitError;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CommandError {
    /// A git command failed or was refused; `error` says why.
    Git { error: GitError },
    /// The path is not a repository found by the last scan. Commands act on
    /// discovered repositories only.
    UnknownRepo { path: String },
    /// Another action is still running on this repository.
    Busy { path: String },
    /// A settings value is not acceptable. Nothing was saved.
    InvalidSettings { field: String, reason: String },
    /// No scan has finished yet.
    NotScanned,
    /// An external tool (VS Code, terminal, file manager) could not be
    /// started.
    OpenFailed { target: String, message: String },
    /// A file or thread operation failed.
    Io { message: String },
}

impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Git { error } => error.fmt(f),
            Self::UnknownRepo { path } => write!(f, "{path} is not a discovered repository"),
            Self::Busy { path } => write!(f, "another action is running in {path}"),
            Self::InvalidSettings { field, reason } => write!(f, "{field}: {reason}"),
            Self::NotScanned => write!(f, "no scan has finished yet"),
            Self::OpenFailed { target, message } => write!(f, "cannot open {target}: {message}"),
            Self::Io { message } => f.write_str(message),
        }
    }
}

impl std::error::Error for CommandError {}

impl From<GitError> for CommandError {
    fn from(error: GitError) -> Self {
        Self::Git { error }
    }
}
