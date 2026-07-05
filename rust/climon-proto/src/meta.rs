//! Session metadata types. 1:1 port of `src/types.ts`.
//!
//! serde is configured so JSON round-trips match the Bun server byte-for-byte:
//! camelCase field names, absent optionals omitted (`skip_serializing_if`), and
//! `color` distinguishing absent / explicit-null / value via [`double_option`].

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionStatus {
    Running,
    Acknowledged,
    NeedsAttention,
    Completed,
    Paused,
    Failed,
    Disconnected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnsiColor {
    Black,
    Red,
    Green,
    Yellow,
    Blue,
    Magenta,
    Cyan,
    White,
}

impl AnsiColor {
    /// All eight colors in canonical (`ANSI_COLORS`) order.
    pub const ALL: [AnsiColor; 8] = [
        AnsiColor::Black,
        AnsiColor::Red,
        AnsiColor::Green,
        AnsiColor::Yellow,
        AnsiColor::Blue,
        AnsiColor::Magenta,
        AnsiColor::Cyan,
        AnsiColor::White,
    ];

    /// Lowercase canonical name.
    pub fn name(self) -> &'static str {
        match self {
            AnsiColor::Black => "black",
            AnsiColor::Red => "red",
            AnsiColor::Green => "green",
            AnsiColor::Yellow => "yellow",
            AnsiColor::Blue => "blue",
            AnsiColor::Magenta => "magenta",
            AnsiColor::Cyan => "cyan",
            AnsiColor::White => "white",
        }
    }

    /// Case-insensitive name lookup.
    pub fn from_name(value: &str) -> Option<AnsiColor> {
        let lower = value.to_ascii_lowercase();
        AnsiColor::ALL
            .into_iter()
            .find(|c| c.name() == lower.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProgressState {
    Normal,
    Error,
    Indeterminate,
    Warning,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProgress {
    pub state: ProgressState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PriorityReason {
    Attention,
    Completed,
    Failed,
    Running,
    Disconnected,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    Local,
    Remote,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    pub command: Vec<String>,
    pub display_command: String,
    pub cwd: String,
    pub status: SessionStatus,
    pub priority_reason: PriorityReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daemon_pid: Option<u32>,
    pub cols: u16,
    pub rows: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headless: Option<bool>,
    pub socket_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_version: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub last_activity_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attention_matched_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attention_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<Origin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<u16>,
    #[serde(
        default,
        deserialize_with = "double_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub color: Option<Option<AnsiColor>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_paused: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<TerminalProgress>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetaPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<SessionStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority_reason: Option<PriorityReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daemon_pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<String>,
    #[serde(
        default,
        deserialize_with = "double_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub attention_matched_at: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "double_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub attention_reason: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub socket_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cols: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<u16>,
    #[serde(
        default,
        deserialize_with = "double_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub color: Option<Option<AnsiColor>>,
    #[serde(
        default,
        deserialize_with = "double_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub theme: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_paused: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_title: Option<String>,
    #[serde(
        default,
        deserialize_with = "double_option::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub progress: Option<Option<TerminalProgress>>,
}

/// serde helper that distinguishes an absent field (`None`) from an explicit
/// JSON `null` (`Some(None)`) for `Option<Option<T>>` fields. Without it, serde
/// maps both absent and null to `None`, collapsing the `color` three-state.
pub(crate) mod double_option {
    use serde::{Deserialize, Deserializer};

    pub fn deserialize<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
    where
        T: Deserialize<'de>,
        D: Deserializer<'de>,
    {
        Deserialize::deserialize(deserializer).map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_json() -> &'static str {
        r#"{"id":"abc","command":["bash"],"displayCommand":"bash","cwd":"/","status":"running","priorityReason":"running","cols":80,"rows":24,"socketPath":"tcp://127.0.0.1:9000","createdAt":"t","updatedAt":"t","lastActivityAt":"t"}"#
    }

    #[test]
    fn deserializes_minimal_meta_and_defaults_optionals_to_none() {
        let meta: SessionMeta = serde_json::from_str(minimal_json()).unwrap();
        assert_eq!(meta.id, "abc");
        assert_eq!(meta.command, vec!["bash".to_string()]);
        assert_eq!(meta.status, SessionStatus::Running);
        assert_eq!(meta.daemon_pid, None);
        assert_eq!(meta.color, None);
        assert_eq!(meta.headless, None);
    }

    #[test]
    fn omits_absent_optionals_when_serializing() {
        let meta: SessionMeta = serde_json::from_str(minimal_json()).unwrap();
        let out = serde_json::to_string(&meta).unwrap();
        assert!(!out.contains("daemonPid"));
        assert!(!out.contains("color"));
        assert!(!out.contains("exitCode"));
        assert!(out.contains("\"displayCommand\":\"bash\""));
        assert!(out.contains("\"socketPath\":\"tcp://127.0.0.1:9000\""));
    }

    #[test]
    fn distinguishes_absent_null_and_value_color() {
        let m: SessionMeta = serde_json::from_str(minimal_json()).unwrap();
        assert_eq!(m.color, None);

        let with_null = minimal_json().replace(
            "\"lastActivityAt\":\"t\"",
            "\"lastActivityAt\":\"t\",\"color\":null",
        );
        let m: SessionMeta = serde_json::from_str(&with_null).unwrap();
        assert_eq!(m.color, Some(None));
        assert!(serde_json::to_string(&m)
            .unwrap()
            .contains("\"color\":null"));

        let with_color = minimal_json().replace(
            "\"lastActivityAt\":\"t\"",
            "\"lastActivityAt\":\"t\",\"color\":\"red\"",
        );
        let m: SessionMeta = serde_json::from_str(&with_color).unwrap();
        assert_eq!(m.color, Some(Some(AnsiColor::Red)));
        assert!(serde_json::to_string(&m)
            .unwrap()
            .contains("\"color\":\"red\""));
    }

    #[test]
    fn status_serializes_kebab_case() {
        assert_eq!(
            serde_json::to_string(&SessionStatus::NeedsAttention).unwrap(),
            "\"needs-attention\""
        );
        assert_eq!(
            serde_json::to_string(&SessionStatus::Running).unwrap(),
            "\"running\""
        );
        assert_eq!(
            serde_json::from_str::<SessionStatus>("\"needs-attention\"").unwrap(),
            SessionStatus::NeedsAttention
        );
    }

    #[test]
    fn patch_omits_all_absent_fields() {
        let patch = SessionMetaPatch::default();
        assert_eq!(serde_json::to_string(&patch).unwrap(), "{}");
        let patch = SessionMetaPatch {
            status: Some(SessionStatus::Completed),
            exit_code: Some(0),
            ..Default::default()
        };
        let out = serde_json::to_string(&patch).unwrap();
        assert_eq!(out, r#"{"status":"completed","exitCode":0}"#);
    }

    #[test]
    fn patch_color_supports_explicit_null() {
        let patch = SessionMetaPatch {
            color: Some(None),
            ..Default::default()
        };
        assert_eq!(serde_json::to_string(&patch).unwrap(), r#"{"color":null}"#);
    }

    #[test]
    fn session_meta_theme_round_trips() {
        let mut meta: SessionMeta = serde_json::from_str(minimal_json()).unwrap();
        meta.theme = Some("Dracula".to_string());
        let json = serde_json::to_string(&meta).unwrap();
        assert!(json.contains("\"theme\":\"Dracula\""));
        let back: SessionMeta = serde_json::from_str(&json).unwrap();
        assert_eq!(back.theme.as_deref(), Some("Dracula"));
    }

    #[test]
    fn session_meta_terminal_title_round_trips() {
        let mut meta: SessionMeta = serde_json::from_str(minimal_json()).unwrap();
        assert_eq!(meta.terminal_title, None);
        meta.terminal_title = Some("copilot — repo".to_string());
        let json = serde_json::to_string(&meta).unwrap();
        assert!(json.contains("\"terminalTitle\":\"copilot — repo\""));
        let back: SessionMeta = serde_json::from_str(&json).unwrap();
        assert_eq!(back.terminal_title.as_deref(), Some("copilot — repo"));
    }

    #[test]
    fn patch_terminal_title_serializes_camel_case() {
        let patch = SessionMetaPatch {
            terminal_title: Some("build ok".to_string()),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_string(&patch).unwrap(),
            r#"{"terminalTitle":"build ok"}"#
        );
    }

    #[test]
    fn session_meta_progress_round_trips() {
        let mut meta: SessionMeta = serde_json::from_str(minimal_json()).unwrap();
        assert_eq!(meta.progress, None);
        meta.progress = Some(TerminalProgress {
            state: ProgressState::Normal,
            value: Some(40),
        });
        let json = serde_json::to_string(&meta).unwrap();
        assert!(json.contains(r#""progress":{"state":"normal","value":40}"#));
        let back: SessionMeta = serde_json::from_str(&json).unwrap();
        assert_eq!(
            back.progress,
            Some(TerminalProgress { state: ProgressState::Normal, value: Some(40) })
        );
    }

    #[test]
    fn progress_indeterminate_omits_value() {
        let p = TerminalProgress { state: ProgressState::Indeterminate, value: None };
        let json = serde_json::to_string(&p).unwrap();
        assert_eq!(json, r#"{"state":"indeterminate"}"#);
    }

    #[test]
    fn patch_progress_clear_serializes_null() {
        let patch = SessionMetaPatch { progress: Some(None), ..Default::default() };
        let json = serde_json::to_string(&patch).unwrap();
        assert!(json.contains(r#""progress":null"#));
    }

    #[test]
    fn patch_progress_absent_is_omitted() {
        let patch = SessionMetaPatch::default();
        let json = serde_json::to_string(&patch).unwrap();
        assert!(!json.contains("progress"));
    }
}
