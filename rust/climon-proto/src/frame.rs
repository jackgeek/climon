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
    // Tags 9 and 10 are reserved (previously used) and intentionally left
    // unmapped so existing tag numbers stay stable.
    Control = 11,
    TakeControl = 12,
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
            11 => Some(FrameType::Control),
            12 => Some(FrameType::TakeControl),
            _ => None,
        }
    }
}

/// Surface class for control-priority ordering. Mirrors `SurfaceKind` in
/// `src/ipc/frame.ts`. Priority: pwa > dashboard > terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SurfaceKind {
    Terminal,
    Dashboard,
    Pwa,
}

impl SurfaceKind {
    pub fn priority(self) -> u8 {
        match self {
            SurfaceKind::Terminal => 1,
            SurfaceKind::Dashboard => 2,
            SurfaceKind::Pwa => 3,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizePayload {
    pub cols: u16,
    pub rows: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<SurfaceKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewer_id: Option<String>,
}

/// Broadcast to every surface: who controls the shared PTY and its grid size.
/// Mirrors `ControlPayload`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlPayload {
    pub controller_id: String,
    pub cols: u16,
    pub rows: u16,
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
                kind: None,
                viewer_id: None,
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
                kind: None,
                viewer_id: None,
            }
        );
    }

    #[test]
    fn round_trips_a_resize_with_surface_identity() {
        let frame = encode_json_frame(
            FrameType::Resize,
            &ResizePayload {
                cols: 120,
                rows: 40,
                kind: Some(SurfaceKind::Dashboard),
                viewer_id: Some("abc123".into()),
            },
        );
        assert_eq!(
            &frame[5..],
            br#"{"cols":120,"rows":40,"kind":"dashboard","viewerId":"abc123"}"#
        );
        let decoded = FrameDecoder::new().push(&frame);
        let payload: ResizePayload = parse_json_payload(&decoded[0].payload).unwrap();
        assert_eq!(payload.kind, Some(SurfaceKind::Dashboard));
        assert_eq!(payload.viewer_id.as_deref(), Some("abc123"));
    }

    #[test]
    fn round_trips_a_control_frame() {
        let frame = encode_json_frame(
            FrameType::Control,
            &ControlPayload {
                controller_id: "local".into(),
                cols: 80,
                rows: 24,
            },
        );
        assert_eq!(
            &frame[5..],
            br#"{"controllerId":"local","cols":80,"rows":24}"#
        );
        let decoded = FrameDecoder::new().push(&frame);
        assert_eq!(decoded[0].frame_type, FrameType::Control);
        let payload: ControlPayload = parse_json_payload(&decoded[0].payload).unwrap();
        assert_eq!(payload.controller_id, "local");
    }

    #[test]
    fn encodes_a_take_control_frame_with_empty_payload() {
        let frame = encode_frame(FrameType::TakeControl, &[]);
        let decoded = FrameDecoder::new().push(&frame);
        assert_eq!(decoded[0].frame_type, FrameType::TakeControl);
        assert!(decoded[0].payload.is_empty());
    }

    #[test]
    fn surface_kind_priority_orders_pwa_over_dashboard_over_terminal() {
        assert!(SurfaceKind::Pwa.priority() > SurfaceKind::Dashboard.priority());
        assert!(SurfaceKind::Dashboard.priority() > SurfaceKind::Terminal.priority());
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
