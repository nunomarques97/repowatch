//! The needs-attention model: what is wrong with a repository and how
//! urgent it is.
//!
//! Every issue is a [`Reason`] with a fixed [`AttentionLevel`]. The levels
//! are the categories of DESIGN.md, from most to least severe:
//!
//! | Level | Reasons | Why |
//! | --- | --- | --- |
//! | `risk` | scan error, merge conflicts, detached HEAD, lost commits | work can be lost or the state is unknown |
//! | `change` | staged, unstaged (modified or deleted), untracked files | work exists only in the working tree |
//! | `sync` | commits ahead (to push), behind (to pull), branch without upstream, upstream gone, repository without remote | work exists only on this PC, or the PC is out of date |
//! | `branch` | local branches not merged into the default branch, stashes | loose ends that are easy to forget |
//! | `clean` | none | nothing to do |
//!
//! A repository's level is its most severe reason; it *needs attention*
//! when the level is not `clean`. The tray badge counts repositories that
//! need attention, and the dashboard sorts by level, then by name.
//!
//! Rules that keep the signal honest:
//!
//! - A repository without commits has nothing to push, so it gets no "no
//!   remote" reason; untracked files in it still count as changes.
//! - "No upstream" applies only to a branch with commits in a repository
//!   that has a remote; a detached HEAD gets "detached HEAD" instead.
//! - Lost commits are found on demand (see [`crate::lost`]), so the scan
//!   leaves them unknown and adds no reason until they are counted.

use serde::Serialize;

/// How urgent a repository's issues are. Ordered from least to most
/// severe, so the maximum is the repository's level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AttentionLevel {
    Clean,
    Branch,
    Sync,
    Change,
    Risk,
}

/// One issue of a repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Reason {
    /// Reading the repository failed; the message says why.
    ScanError {
        message: String,
    },
    Conflicts {
        count: u32,
    },
    DetachedHead,
    LostCommits {
        count: u32,
    },
    Staged {
        count: u32,
    },
    Unstaged {
        count: u32,
    },
    Untracked {
        count: u32,
    },
    /// Local commits not on the upstream.
    Ahead {
        count: u32,
    },
    /// Upstream commits not merged locally, as of the last fetch.
    Behind {
        count: u32,
    },
    NoUpstream,
    UpstreamGone,
    NoRemote,
    UnmergedBranches {
        count: u32,
    },
    Stashes {
        count: u32,
    },
}

impl Reason {
    pub fn level(&self) -> AttentionLevel {
        match self {
            Self::ScanError { .. }
            | Self::Conflicts { .. }
            | Self::DetachedHead
            | Self::LostCommits { .. } => AttentionLevel::Risk,
            Self::Staged { .. } | Self::Unstaged { .. } | Self::Untracked { .. } => {
                AttentionLevel::Change
            }
            Self::Ahead { .. }
            | Self::Behind { .. }
            | Self::NoUpstream
            | Self::UpstreamGone
            | Self::NoRemote => AttentionLevel::Sync,
            Self::UnmergedBranches { .. } | Self::Stashes { .. } => AttentionLevel::Branch,
        }
    }
}

/// A reason with its level, as serialized for the app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionReason {
    pub level: AttentionLevel,
    #[serde(flatten)]
    pub reason: Reason,
}

/// A repository's level and the reasons behind it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attention {
    pub level: AttentionLevel,
    pub needs_attention: bool,
    /// Most severe first; reasons of the same level keep the order of
    /// [`Reason`]'s variants.
    pub reasons: Vec<AttentionReason>,
}

impl Attention {
    /// Builds the attention from reasons in [`Reason`] variant order.
    pub fn from_reasons(reasons: Vec<Reason>) -> Self {
        let mut reasons: Vec<AttentionReason> = reasons
            .into_iter()
            .map(|reason| AttentionReason {
                level: reason.level(),
                reason,
            })
            .collect();
        // Stable: equal levels keep their order.
        reasons.sort_by_key(|reason| std::cmp::Reverse(reason.level));
        let level = reasons
            .first()
            .map_or(AttentionLevel::Clean, |reason| reason.level);
        Self {
            level,
            needs_attention: level != AttentionLevel::Clean,
            reasons,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_is_the_most_severe_reason() {
        let attention = Attention::from_reasons(vec![
            Reason::Staged { count: 1 },
            Reason::Ahead { count: 2 },
            Reason::Stashes { count: 1 },
            Reason::DetachedHead,
        ]);
        assert_eq!(attention.level, AttentionLevel::Risk);
        assert!(attention.needs_attention);
        let kinds: Vec<AttentionLevel> = attention.reasons.iter().map(|r| r.level).collect();
        assert_eq!(
            kinds,
            [
                AttentionLevel::Risk,
                AttentionLevel::Change,
                AttentionLevel::Sync,
                AttentionLevel::Branch
            ]
        );
    }

    #[test]
    fn no_reasons_is_clean() {
        let attention = Attention::from_reasons(Vec::new());
        assert_eq!(attention.level, AttentionLevel::Clean);
        assert!(!attention.needs_attention);
    }

    #[test]
    fn levels_are_ordered_by_severity() {
        assert!(AttentionLevel::Risk > AttentionLevel::Change);
        assert!(AttentionLevel::Change > AttentionLevel::Sync);
        assert!(AttentionLevel::Sync > AttentionLevel::Branch);
        assert!(AttentionLevel::Branch > AttentionLevel::Clean);
    }

    #[test]
    fn reasons_serialize_with_kind_and_level() {
        let attention = Attention::from_reasons(vec![Reason::UnmergedBranches { count: 2 }]);
        assert_eq!(
            serde_json::to_value(&attention).unwrap(),
            serde_json::json!({
                "level": "branch",
                "needsAttention": true,
                "reasons": [{ "level": "branch", "kind": "unmergedBranches", "count": 2 }]
            })
        );
    }
}
