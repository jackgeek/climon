//! Pure controller-registry logic for the control-handoff model. The daemon
//! (`host.rs`) owns the surfaces and PTY; this module is the pure decision core:
//! given the set of connected surfaces and their sizes, it decides who should
//! control the PTY and whether a given surface is "displaced" (too small to
//! render the controlling grid). Unit-testable in isolation, mirroring the old
//! `resize.rs`.

use climon_proto::frame::SurfaceKind;

/// A connected surface (local terminal, dashboard tab, or PWA).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Surface {
    /// Stable viewer id (`"local"` for the in-process terminal).
    pub id: String,
    pub kind: SurfaceKind,
    pub cols: u16,
    pub rows: u16,
    /// Monotonic connection sequence; higher = more recently connected.
    pub seq: u64,
}

/// Chooses the fallback controller: highest `kind` priority, ties broken by the
/// most-recently-connected (`seq`). Returns `None` when there are no surfaces.
/// Used at startup and whenever the current controller disconnects. Manual
/// `TakeControl` is handled by the caller and is NOT overridden here.
pub fn choose_controller(surfaces: &[Surface]) -> Option<&Surface> {
    surfaces
        .iter()
        .max_by_key(|s| (s.kind.priority(), s.seq))
}

/// Whether a surface of `(own_cols, own_rows)` cannot faithfully render a grid
/// of `(ctrl_cols, ctrl_rows)` — i.e. it is smaller in either dimension.
pub fn is_displaced(own_cols: u16, own_rows: u16, ctrl_cols: u16, ctrl_rows: u16) -> bool {
    own_cols < ctrl_cols || own_rows < ctrl_rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(id: &str, kind: SurfaceKind, cols: u16, rows: u16, seq: u64) -> Surface {
        Surface { id: id.into(), kind, cols, rows, seq }
    }

    #[test]
    fn picks_pwa_over_dashboard_over_terminal() {
        let surfaces = vec![
            s("t", SurfaceKind::Terminal, 80, 24, 1),
            s("d", SurfaceKind::Dashboard, 120, 40, 2),
            s("p", SurfaceKind::Pwa, 40, 20, 3),
        ];
        assert_eq!(choose_controller(&surfaces).unwrap().id, "p");
    }

    #[test]
    fn breaks_ties_by_most_recently_connected() {
        let surfaces = vec![
            s("d1", SurfaceKind::Dashboard, 120, 40, 5),
            s("d2", SurfaceKind::Dashboard, 90, 30, 9),
        ];
        assert_eq!(choose_controller(&surfaces).unwrap().id, "d2");
    }

    #[test]
    fn returns_none_with_no_surfaces() {
        assert!(choose_controller(&[]).is_none());
    }

    #[test]
    fn displaced_when_smaller_in_either_dimension() {
        assert!(is_displaced(79, 24, 80, 24));
        assert!(is_displaced(80, 23, 80, 24));
        assert!(!is_displaced(80, 24, 80, 24));
        assert!(!is_displaced(200, 50, 80, 24));
    }
}
