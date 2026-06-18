//! Bounded ring buffer holding captured PTY output ("the shadow").
//!
//! Late-joining viewers receive `snapshot()` as a replay so they see the
//! current screen state, not just output produced after they connect.

/// A byte-capped scrollback buffer. Once the cap is exceeded, the oldest bytes
/// are evicted so memory stays bounded for long-running sessions.
pub struct Scrollback {
    data: Vec<u8>,
    cap: usize,
}

impl Scrollback {
    /// Creates a scrollback that retains at most `cap` bytes.
    pub fn new(cap: usize) -> Self {
        Scrollback {
            data: Vec::new(),
            cap,
        }
    }

    /// Appends a chunk of output, evicting the oldest bytes past the cap.
    pub fn append(&mut self, chunk: &[u8]) {
        self.data.extend_from_slice(chunk);
        if self.data.len() > self.cap {
            let overflow = self.data.len() - self.cap;
            self.data.drain(0..overflow);
        }
    }

    /// Returns a copy of the currently retained bytes.
    pub fn snapshot(&self) -> Vec<u8> {
        self.data.clone()
    }

    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.data.len()
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retains_appended_bytes() {
        let mut sb = Scrollback::new(1024);
        sb.append(b"hello ");
        sb.append(b"world");
        assert_eq!(sb.snapshot(), b"hello world");
    }

    #[test]
    fn evicts_oldest_past_cap() {
        let mut sb = Scrollback::new(5);
        sb.append(b"abcdefgh");
        // Only the last 5 bytes are retained.
        assert_eq!(sb.snapshot(), b"defgh");
        assert_eq!(sb.len(), 5);
    }

    #[test]
    fn evicts_across_multiple_appends() {
        let mut sb = Scrollback::new(4);
        sb.append(b"ab");
        sb.append(b"cd");
        sb.append(b"ef");
        assert_eq!(sb.snapshot(), b"cdef");
    }

    #[test]
    fn empty_by_default() {
        let sb = Scrollback::new(10);
        assert!(sb.is_empty());
        assert_eq!(sb.snapshot(), b"");
    }
}
