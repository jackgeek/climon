//! Length-prefixed binary frame codec + typed JSON payloads.
//!
//! Wire-compatible with the TypeScript client (`src/ipc/frame.ts`): each frame
//! is a 4-byte big-endian payload length, a 1-byte frame type, then the payload.
//! The decoder accumulates raw socket bytes and yields complete frames, handling
//! payloads split across chunks and multiple frames per chunk. Unknown frame
//! types are skipped (payload still consumed) so a future protocol extension
//! cannot wedge the stream.

use serde::{Deserialize, Serialize};

/// Frame type tags. Values MUST match `FrameType` in `src/ipc/frame.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum FrameType {
    Output = 1,
    Input = 2,
    Resize = 3,
    Exit = 4,
    Replay = 5,
    PtySize = 6,
    Attention = 7,
    Title = 8,
    TerminalMode = 9,
    TerminalWarning = 10,
}

impl FrameType {
    pub fn from_u8(value: u8) -> Option<FrameType> {
        match value {
            1 => Some(FrameType::Output),
            2 => Some(FrameType::Input),
            3 => Some(FrameType::Resize),
            4 => Some(FrameType::Exit),
            5 => Some(FrameType::Replay),
            6 => Some(FrameType::PtySize),
            7 => Some(FrameType::Attention),
            8 => Some(FrameType::Title),
            9 => Some(FrameType::TerminalMode),
            10 => Some(FrameType::TerminalWarning),
            _ => None,
        }
    }
}

/// Browser-selected resize behavior. Mirrors `TerminalResizeMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalResizeMode {
    Clamped,
    Fill,
}

/// Origin of a resize request. Mirrors `ResizePayload.source`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResizeSource {
    Host,
    Viewer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizePayload {
    pub cols: u16,
    pub rows: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<ResizeSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<TerminalResizeMode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PtySizePayload {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionPayload {
    pub needs_attention: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attention_matched_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitPayload {
    pub exit_code: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TitlePayload {
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalModePayload {
    pub mode: TerminalResizeMode,
}

/// Host-only warning surfaced when a viewer overgrows the shared PTY. Mirrors
/// the `TerminalWarningPayload` discriminated union (tagged by `kind`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TerminalWarningPayload {
    #[serde(rename_all = "camelCase")]
    Overgrown {
        cols: u16,
        rows: u16,
        host_cols: u16,
        host_rows: u16,
    },
    Restored,
}

const HEADER_SIZE: usize = 5; // 4-byte length + 1-byte type

/// Encodes a frame: 4-byte big-endian length + 1-byte type + payload.
pub fn encode_frame(frame_type: FrameType, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_SIZE + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.push(frame_type as u8);
    out.extend_from_slice(payload);
    out
}

/// Serializes `value` to JSON and wraps it in a frame. Mirrors `encodeJsonFrame`.
pub fn encode_json_frame<T: Serialize>(frame_type: FrameType, value: &T) -> Vec<u8> {
    let body = serde_json::to_vec(value).expect("payload serializes to JSON");
    encode_frame(frame_type, &body)
}

/// Parses a JSON frame payload. Mirrors `parseJsonPayload`.
pub fn parse_json_payload<T: serde::de::DeserializeOwned>(payload: &[u8]) -> serde_json::Result<T> {
    serde_json::from_slice(payload)
}

/// A decoded frame: its type plus an owned payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedFrame {
    pub frame_type: FrameType,
    pub payload: Vec<u8>,
}

/// Incremental frame decoder. Mirrors the TS `FrameDecoder`.
#[derive(Default)]
pub struct FrameDecoder {
    buffer: Vec<u8>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        FrameDecoder { buffer: Vec::new() }
    }

    /// Feeds a chunk and returns any complete frames now available.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<DecodedFrame> {
        self.buffer.extend_from_slice(chunk);
        let mut frames = Vec::new();
        let mut offset = 0;
        while self.buffer.len() - offset >= HEADER_SIZE {
            let len = u32::from_be_bytes([
                self.buffer[offset],
                self.buffer[offset + 1],
                self.buffer[offset + 2],
                self.buffer[offset + 3],
            ]) as usize;
            let total = HEADER_SIZE + len;
            if self.buffer.len() - offset < total {
                break;
            }
            let type_byte = self.buffer[offset + 4];
            let payload = self.buffer[offset + HEADER_SIZE..offset + total].to_vec();
            if let Some(frame_type) = FrameType::from_u8(type_byte) {
                frames.push(DecodedFrame {
                    frame_type,
                    payload,
                });
            }
            offset += total;
        }
        if offset > 0 {
            self.buffer.drain(0..offset);
        }
        frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_single_frame() {
        let frame = encode_frame(FrameType::Output, b"hello");
        let decoded = FrameDecoder::new().push(&frame);
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0].frame_type, FrameType::Output);
        assert_eq!(decoded[0].payload, b"hello");
    }

    #[test]
    fn decodes_multiple_frames_in_one_chunk() {
        let mut bytes = encode_frame(FrameType::Output, b"a");
        bytes.extend_from_slice(&encode_frame(FrameType::Input, b"b"));
        let decoded = FrameDecoder::new().push(&bytes);
        let payloads: Vec<&[u8]> = decoded.iter().map(|f| f.payload.as_slice()).collect();
        assert_eq!(payloads, vec![b"a".as_slice(), b"b".as_slice()]);
    }

    #[test]
    fn handles_frames_split_across_chunks() {
        let frame = encode_frame(FrameType::Output, b"splitme");
        let mut decoder = FrameDecoder::new();
        assert!(decoder.push(&frame[0..3]).is_empty());
        let rest = decoder.push(&frame[3..]);
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].payload, b"splitme");
    }

    #[test]
    fn encodes_and_parses_json_frames() {
        let frame = encode_json_frame(
            FrameType::Resize,
            &ResizePayload {
                cols: 100,
                rows: 40,
                source: None,
                mode: None,
            },
        );
        assert_eq!(&frame[5..], br#"{"cols":100,"rows":40}"#);
        let decoded = FrameDecoder::new().push(&frame);
        assert_eq!(decoded[0].frame_type, FrameType::Resize);
        let payload: ResizePayload = parse_json_payload(&decoded[0].payload).unwrap();
        assert_eq!(
            payload,
            ResizePayload {
                cols: 100,
                rows: 40,
                source: None,
                mode: None
            }
        );
    }

    #[test]
    fn handles_empty_payloads() {
        let frame = encode_frame(FrameType::Exit, &[]);
        let decoded = FrameDecoder::new().push(&frame);
        assert_eq!(decoded[0].payload.len(), 0);
    }

    #[test]
    fn round_trips_an_attention_frame_payload() {
        let frame = encode_json_frame(
            FrameType::Attention,
            &AttentionPayload {
                needs_attention: true,
                reason: Some("Screen idle for 10s".to_string()),
                attention_matched_at: None,
            },
        );
        assert_eq!(
            &frame[5..],
            br#"{"needsAttention":true,"reason":"Screen idle for 10s"}"#
        );
        let decoded = FrameDecoder::new().push(&frame);
        assert_eq!(decoded[0].frame_type, FrameType::Attention);
        let payload: AttentionPayload = parse_json_payload(&decoded[0].payload).unwrap();
        assert_eq!(
            payload,
            AttentionPayload {
                needs_attention: true,
                reason: Some("Screen idle for 10s".to_string()),
                attention_matched_at: None,
            }
        );
    }

    #[test]
    fn round_trips_a_title_frame() {
        let frame = encode_json_frame(
            FrameType::Title,
            &TitlePayload {
                name: "dev server".into(),
            },
        );
        assert_eq!(&frame[5..], br#"{"name":"dev server"}"#);
        let decoded = FrameDecoder::new().push(&frame);
        let payload: TitlePayload = parse_json_payload(&decoded[0].payload).unwrap();
        assert_eq!(payload.name, "dev server");
    }

    #[test]
    fn round_trips_a_terminal_mode_frame() {
        let frame = encode_json_frame(
            FrameType::TerminalMode,
            &TerminalModePayload {
                mode: TerminalResizeMode::Clamped,
            },
        );
        assert_eq!(&frame[5..], br#"{"mode":"clamped"}"#);
        let decoded = FrameDecoder::new().push(&frame);
        let payload: TerminalModePayload = parse_json_payload(&decoded[0].payload).unwrap();
        assert_eq!(payload.mode, TerminalResizeMode::Clamped);
    }

    #[test]
    fn round_trips_a_host_only_terminal_warning_frame() {
        let frame = encode_json_frame(
            FrameType::TerminalWarning,
            &TerminalWarningPayload::Overgrown {
                cols: 140,
                rows: 40,
                host_cols: 80,
                host_rows: 24,
            },
        );
        assert_eq!(
            &frame[5..],
            br#"{"kind":"overgrown","cols":140,"rows":40,"hostCols":80,"hostRows":24}"#
        );
        let decoded = FrameDecoder::new().push(&frame);
        let payload: TerminalWarningPayload = parse_json_payload(&decoded[0].payload).unwrap();
        assert_eq!(
            payload,
            TerminalWarningPayload::Overgrown {
                cols: 140,
                rows: 40,
                host_cols: 80,
                host_rows: 24,
            }
        );
    }

    #[test]
    fn skips_unknown_frame_types_but_consumes_payload() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&2u32.to_be_bytes());
        bytes.push(99);
        bytes.extend_from_slice(b"xx");
        bytes.extend_from_slice(&encode_frame(FrameType::Output, b"ok"));
        let decoded = FrameDecoder::new().push(&bytes);
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0].frame_type, FrameType::Output);
        assert_eq!(decoded[0].payload, b"ok");
    }
}
