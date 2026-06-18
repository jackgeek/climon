//! Mux framing for the remote uplink/ingest channel. 1:1 port of
//! `src/remote/mux.ts`.
//!
//! Wire format (byte-for-byte compatible with the Bun client/server):
//!   - 5-byte header: 4-byte big-endian payload length + 1-byte type
//!   - type Control = 1: payload is UTF-8 JSON of [`ControlMessage`]
//!   - type Data = 2: payload is 1-byte sessionId length + sessionId UTF-8 +
//!     raw data bytes
//!
//! All input is UNTRUSTED: a frame whose declared length exceeds
//! [`MAX_MUX_PAYLOAD`] makes [`MuxDecoder::push`] return `Err` so the caller can
//! tear the connection down rather than buffer unbounded memory.

use climon_proto::meta::{SessionMeta, SessionMetaPatch};
use serde::{Deserialize, Serialize};

/// Mux frame type tags. Values MUST match `MuxType` in `src/remote/mux.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum MuxType {
    Control = 1,
    Data = 2,
}

const HEADER_SIZE: usize = 5; // 4-byte length + 1-byte type

/// Maximum mux payload size (8 MiB). Mirrors `MAX_MUX_PAYLOAD`.
pub const MAX_MUX_PAYLOAD: u32 = 8 * 1024 * 1024;

/// A control message. Serialized as a `kind`-tagged JSON union matching the TS
/// `ControlMessage` exactly (camelCase fields).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ControlMessage {
    #[serde(rename_all = "camelCase")]
    Hello {
        client_id: String,
    },
    SessionAdded {
        meta: Box<SessionMeta>,
    },
    #[serde(rename_all = "camelCase")]
    SessionUpdated {
        id: String,
        patch: Box<SessionMetaPatch>,
    },
    SessionRemoved {
        id: String,
    },
    Attach {
        id: String,
    },
    Detach {
        id: String,
    },
    Ping,
    Pong,
}

/// A decoded mux message.
#[derive(Debug, Clone, PartialEq)]
pub enum MuxMessage {
    Control(ControlMessage),
    Data { session_id: String, data: Vec<u8> },
}

/// A decoded mux frame whose control payload is left as raw JSON bytes. The
/// ingest uses this to parse untrusted control payloads leniently (matching the
/// TS, where the advertised meta is plain JSON and never strictly validated).
#[derive(Debug, Clone, PartialEq)]
pub enum RawFrame {
    /// Raw UTF-8 JSON bytes of a control payload.
    Control(Vec<u8>),
    /// A data frame: target session id + raw bytes.
    Data { session_id: String, data: Vec<u8> },
}

fn envelope(frame_type: MuxType, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(HEADER_SIZE + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.push(frame_type as u8);
    frame.extend_from_slice(payload);
    frame
}

/// Encodes a control message into a complete mux frame. Mirrors `encodeControl`.
pub fn encode_control(message: &ControlMessage) -> Vec<u8> {
    let json = serde_json::to_vec(message).expect("control message serializes to JSON");
    envelope(MuxType::Control, &json)
}

/// Encodes an arbitrary JSON value as a control frame. Used by the ingest tests
/// to send control payloads that intentionally fall outside the typed
/// [`ControlMessage`] (e.g. invalid status/color), mirroring the untrusted wire.
pub fn encode_control_value(value: &serde_json::Value) -> Vec<u8> {
    let json = serde_json::to_vec(value).expect("value serializes to JSON");
    envelope(MuxType::Control, &json)
}

/// Encodes a data frame for `session_id`. Returns `Err` when the id is longer
/// than 255 bytes (it cannot fit the 1-byte length prefix). Mirrors `encodeData`.
pub fn encode_data(session_id: &str, data: &[u8]) -> Result<Vec<u8>, MuxError> {
    let id = session_id.as_bytes();
    if id.len() > 255 {
        return Err(MuxError::SessionIdTooLong);
    }
    let mut payload = Vec::with_capacity(1 + id.len() + data.len());
    payload.push(id.len() as u8);
    payload.extend_from_slice(id);
    payload.extend_from_slice(data);
    Ok(envelope(MuxType::Data, &payload))
}

/// Errors raised by mux encoding/decoding. A decode error means the caller must
/// tear the connection down.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MuxError {
    /// Session id exceeds 255 bytes (cannot fit the data-frame length prefix).
    SessionIdTooLong,
    /// A frame declared a payload larger than [`MAX_MUX_PAYLOAD`].
    FrameTooLarge(u32),
    /// A control frame payload was not valid JSON for a [`ControlMessage`].
    BadControl,
    /// A data frame payload was empty, so it lacked the mandatory 1-byte
    /// session-id length prefix. Mirrors the TS `payload.readUInt8(0)`
    /// `RangeError` on an empty payload, which propagates out of `push()` and
    /// makes the caller tear the connection down.
    MalformedData,
}

impl std::fmt::Display for MuxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MuxError::SessionIdTooLong => write!(f, "session id too long for mux frame"),
            MuxError::FrameTooLarge(n) => write!(f, "mux frame too large: {n} bytes"),
            MuxError::BadControl => write!(f, "invalid control frame payload"),
            MuxError::MalformedData => write!(f, "data frame payload missing length prefix"),
        }
    }
}

impl std::error::Error for MuxError {}

/// Accumulates raw channel chunks and yields decoded mux messages. Mirrors the
/// TS `MuxDecoder`: a frame larger than [`MAX_MUX_PAYLOAD`] returns `Err` so the
/// caller tears the connection down instead of buffering unbounded memory.
#[derive(Default)]
pub struct MuxDecoder {
    buffer: Vec<u8>,
}

impl MuxDecoder {
    pub fn new() -> Self {
        MuxDecoder { buffer: Vec::new() }
    }

    /// Feeds a chunk and returns any complete messages now available. Returns
    /// `Err` on an oversized or malformed frame.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<MuxMessage>, MuxError> {
        let frames = self.push_frames(chunk)?;
        let mut out = Vec::with_capacity(frames.len());
        for frame in frames {
            match frame {
                RawFrame::Control(payload) => {
                    let message: ControlMessage =
                        serde_json::from_slice(&payload).map_err(|_| MuxError::BadControl)?;
                    out.push(MuxMessage::Control(message));
                }
                RawFrame::Data { session_id, data } => {
                    out.push(MuxMessage::Data { session_id, data });
                }
            }
        }
        Ok(out)
    }

    /// Like [`MuxDecoder::push`] but leaves control payloads as raw JSON bytes so
    /// the caller can parse untrusted control frames leniently. Still enforces
    /// [`MAX_MUX_PAYLOAD`].
    pub fn push_frames(&mut self, chunk: &[u8]) -> Result<Vec<RawFrame>, MuxError> {
        self.buffer.extend_from_slice(chunk);
        let mut out = Vec::new();
        let mut offset = 0;
        while self.buffer.len() - offset >= HEADER_SIZE {
            let length = u32::from_be_bytes([
                self.buffer[offset],
                self.buffer[offset + 1],
                self.buffer[offset + 2],
                self.buffer[offset + 3],
            ]);
            if length > MAX_MUX_PAYLOAD {
                return Err(MuxError::FrameTooLarge(length));
            }
            let total = HEADER_SIZE + length as usize;
            if self.buffer.len() - offset < total {
                break;
            }
            let type_byte = self.buffer[offset + 4];
            let payload = &self.buffer[offset + HEADER_SIZE..offset + total];
            if type_byte == MuxType::Control as u8 {
                out.push(RawFrame::Control(payload.to_vec()));
            } else if type_byte == MuxType::Data as u8 {
                // A Data payload is `[idLen:1][sessionId:idLen][data..]`.
                // Match the TS `MuxDecoder` byte-for-byte on malformed input
                // from untrusted peers: an empty payload makes TS
                // `payload.readUInt8(0)` throw (caller tears down), so we
                // return `Err`; an oversized `idLen` makes TS `subarray`
                // clamp to the buffer end (no throw), so we clamp too. Never
                // panic on remote bytes.
                if payload.is_empty() {
                    return Err(MuxError::MalformedData);
                }
                let id_len = payload[0] as usize;
                let id_end = (1 + id_len).min(payload.len());
                let session_id = String::from_utf8_lossy(&payload[1..id_end]).into_owned();
                let data = payload[id_end..].to_vec();
                out.push(RawFrame::Data { session_id, data });
            }
            offset += total;
        }
        if offset > 0 {
            self.buffer.drain(0..offset);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Mirrors the `meta` fixture in `tests/mux.test.ts`: a minimal SessionMeta
    // built from a partial object. We deserialize a full minimal JSON so the
    // round-trip equality holds.
    fn sample_meta(id: &str, display_command: &str) -> SessionMeta {
        serde_json::from_value(json!({
            "id": id,
            "command": ["bash"],
            "displayCommand": display_command,
            "cwd": "/",
            "status": "running",
            "priorityReason": "running",
            "cols": 80,
            "rows": 24,
            "socketPath": "tcp://127.0.0.1:9000",
            "createdAt": "t",
            "updatedAt": "t",
            "lastActivityAt": "t"
        }))
        .unwrap()
    }

    #[test]
    fn encodes_and_decodes_a_control_message() {
        let meta = sample_meta("s1", "npm test");
        let mut decoder = MuxDecoder::new();
        let out = decoder
            .push(&encode_control(&ControlMessage::SessionAdded {
                meta: Box::new(meta.clone()),
            }))
            .unwrap();
        assert_eq!(
            out,
            vec![MuxMessage::Control(ControlMessage::SessionAdded {
                meta: Box::new(meta)
            })]
        );
    }

    #[test]
    fn encodes_and_decodes_a_data_message() {
        let mut decoder = MuxDecoder::new();
        let out = decoder
            .push(&encode_data("sess-1", &[1, 2, 3, 4]).unwrap())
            .unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(
            out[0],
            MuxMessage::Data {
                session_id: "sess-1".into(),
                data: vec![1, 2, 3, 4]
            }
        );
    }

    #[test]
    fn reassembles_a_frame_split_across_chunks() {
        let frame = encode_data("x", b"hello").unwrap();
        let mut decoder = MuxDecoder::new();
        assert_eq!(decoder.push(&frame[0..3]).unwrap(), vec![]);
        let out = decoder.push(&frame[3..]).unwrap();
        match &out[0] {
            MuxMessage::Data { data, .. } => assert_eq!(data, b"hello"),
            other => panic!("expected data, got {other:?}"),
        }
    }

    #[test]
    fn decodes_multiple_frames_in_one_chunk() {
        let mut decoder = MuxDecoder::new();
        let mut buf = encode_control(&ControlMessage::SessionRemoved { id: "a".into() });
        buf.extend_from_slice(&encode_data("b", b"z").unwrap());
        let out = decoder.push(&buf).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(
            out[0],
            MuxMessage::Control(ControlMessage::SessionRemoved { id: "a".into() })
        );
        match &out[1] {
            MuxMessage::Data { session_id, .. } => assert_eq!(session_id, "b"),
            other => panic!("expected data, got {other:?}"),
        }
    }

    #[test]
    fn rejects_an_oversized_frame() {
        let mut decoder = MuxDecoder::new();
        let mut header = Vec::new();
        header.extend_from_slice(&(MAX_MUX_PAYLOAD + 1).to_be_bytes());
        header.push(2);
        assert_eq!(
            decoder.push(&header),
            Err(MuxError::FrameTooLarge(MAX_MUX_PAYLOAD + 1))
        );
    }

    #[test]
    fn empty_data_payload_errors_instead_of_panicking() {
        // A 5-byte frame: length=0, type=Data(2). The payload is empty, so it
        // lacks the mandatory 1-byte session-id length prefix. The TS decoder's
        // `payload.readUInt8(0)` throws here; we must return Err (so the caller
        // tears the connection down) rather than panic on `payload[0]`.
        let mut decoder = MuxDecoder::new();
        let frame = [0u8, 0, 0, 0, 2];
        assert_eq!(decoder.push_frames(&frame), Err(MuxError::MalformedData));
    }

    #[test]
    fn oversized_id_len_clamps_instead_of_panicking() {
        // A 6-byte frame: length=1, type=Data(2), id_len=200 but only 1 payload
        // byte. The TS decoder's `subarray(1, 1 + idLen)` clamps to the buffer
        // end and yields no data; we must clamp identically rather than panic on
        // the out-of-bounds slice.
        let mut decoder = MuxDecoder::new();
        let frame = [0u8, 0, 0, 1, 2, 200];
        let out = decoder.push_frames(&frame).unwrap();
        assert_eq!(out.len(), 1);
        match &out[0] {
            RawFrame::Data { session_id, data } => {
                assert_eq!(session_id, "");
                assert!(data.is_empty());
            }
            other => panic!("expected data, got {other:?}"),
        }
    }

    #[test]
    fn encodes_and_decodes_attach_detach_control() {
        let mut decoder = MuxDecoder::new();
        let mut buf = encode_control(&ControlMessage::Attach { id: "s1".into() });
        buf.extend_from_slice(&encode_control(&ControlMessage::Detach { id: "s1".into() }));
        let out = decoder.push(&buf).unwrap();
        assert_eq!(
            out,
            vec![
                MuxMessage::Control(ControlMessage::Attach { id: "s1".into() }),
                MuxMessage::Control(ControlMessage::Detach { id: "s1".into() }),
            ]
        );
    }

    #[test]
    fn encodes_and_decodes_a_hello_control_frame() {
        let mut decoder = MuxDecoder::new();
        let frame = encode_control(&ControlMessage::Hello {
            client_id: "devbox-abc".into(),
        });
        let msgs = decoder.push(&frame).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(
            msgs[0],
            MuxMessage::Control(ControlMessage::Hello {
                client_id: "devbox-abc".into()
            })
        );
    }

    #[test]
    fn rejects_an_oversized_session_id() {
        let id = "x".repeat(256);
        assert_eq!(encode_data(&id, b""), Err(MuxError::SessionIdTooLong));
    }

    #[test]
    fn control_message_json_uses_kebab_kind_and_camel_fields() {
        // hello -> {"kind":"hello","clientId":"d"}
        let frame = encode_control(&ControlMessage::Hello {
            client_id: "d".into(),
        });
        assert_eq!(&frame[5..], br#"{"kind":"hello","clientId":"d"}"#);
        // session-removed -> {"kind":"session-removed","id":"a"}
        let frame = encode_control(&ControlMessage::SessionRemoved { id: "a".into() });
        assert_eq!(&frame[5..], br#"{"kind":"session-removed","id":"a"}"#);
        // ping -> {"kind":"ping"}
        let frame = encode_control(&ControlMessage::Ping);
        assert_eq!(&frame[5..], br#"{"kind":"ping"}"#);
    }
}
