//! Keepalive idle-timeout math. 1:1 port of `src/remote/keepalive.ts`.

/// The mux idle timeout is this many keepalive intervals.
pub const MUX_IDLE_TIMEOUT_FACTOR: f64 = 3.0;

/// Computes the mux idle timeout (ms) from the keepalive interval (ms). Returns
/// 0 when keepalive is disabled (non-finite or non-positive). Mirrors
/// `muxIdleTimeoutMs`.
pub fn mux_idle_timeout_ms(keep_alive_ms: f64) -> u64 {
    if !keep_alive_ms.is_finite() || keep_alive_ms <= 0.0 {
        return 0;
    }
    (keep_alive_ms * MUX_IDLE_TIMEOUT_FACTOR).ceil().max(1.0) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_a_mux_idle_timeout_from_the_keepalive_interval() {
        assert_eq!(mux_idle_timeout_ms(0.0), 0);
        assert_eq!(mux_idle_timeout_ms(50.0), 150);
        assert_eq!(mux_idle_timeout_ms(50.2), 151);
    }
}
