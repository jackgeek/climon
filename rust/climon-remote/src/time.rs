//! Small wall-clock helper shared by the remote beacons. Milliseconds since the
//! Unix epoch, saturating on the (impossible) pre-epoch case.

/// Current wall-clock time in milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
