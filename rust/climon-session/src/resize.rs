//! Pure resize helpers. Ports `clampResize` / `revertSize` from
//! `src/daemon/daemon.ts`.

use climon_proto::frame::{ResizeSource, TerminalResizeMode};

/// A requested resize, mirroring the relevant fields of `ResizePayload`.
#[derive(Debug, Clone, Copy)]
pub struct ResizeRequest {
    pub cols: u16,
    pub rows: u16,
    pub source: Option<ResizeSource>,
    pub mode: Option<TerminalResizeMode>,
}

/// A pair of terminal dimensions, floored at 1x1 by the helpers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Dimensions {
    pub cols: u16,
    pub rows: u16,
}

/// Resolves a requested resize to the dimensions actually applied to the PTY.
///
/// With clamping enabled, a viewer (browser) request is capped to the host
/// terminal's size so the non-reflowing local terminal is never overgrown. Host
/// requests and the unclamped case pass through (floored at 1x1). Mirrors
/// `clampResize`.
pub fn clamp_resize(
    request: ResizeRequest,
    host: Dimensions,
    clamp_browser_to_host: bool,
) -> Dimensions {
    let cols = request.cols.max(1);
    let rows = request.rows.max(1);
    let is_viewer = request.source != Some(ResizeSource::Host);
    let is_fill = request.mode == Some(TerminalResizeMode::Fill);
    if clamp_browser_to_host && is_viewer && !is_fill {
        return Dimensions {
            cols: cols.min(host.cols.max(1)),
            rows: rows.min(host.rows.max(1)),
        };
    }
    Dimensions { cols, rows }
}

/// Resolves the size to restore when the last browser viewer disconnects. The
/// PTY returns to the host terminal's dimensions (floored at 1x1). Returns
/// `None` when the applied size already matches the host so callers can skip a
/// no-op resize and broadcast. Mirrors `revertSize`.
pub fn revert_size(host: Dimensions, applied: Dimensions) -> Option<Dimensions> {
    let cols = host.cols.max(1);
    let rows = host.rows.max(1);
    if cols == applied.cols && rows == applied.rows {
        return None;
    }
    Some(Dimensions { cols, rows })
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: Dimensions = Dimensions { cols: 80, rows: 24 };

    fn req(
        cols: u16,
        rows: u16,
        source: Option<ResizeSource>,
        mode: Option<TerminalResizeMode>,
    ) -> ResizeRequest {
        ResizeRequest {
            cols,
            rows,
            source,
            mode,
        }
    }

    #[test]
    fn caps_a_larger_browser_viewport_to_the_host_terminal_size() {
        assert_eq!(
            clamp_resize(req(200, 50, Some(ResizeSource::Viewer), None), HOST, true),
            Dimensions { cols: 80, rows: 24 }
        );
    }

    #[test]
    fn leaves_a_smaller_browser_viewport_untouched() {
        assert_eq!(
            clamp_resize(req(60, 20, Some(ResizeSource::Viewer), None), HOST, true),
            Dimensions { cols: 60, rows: 20 }
        );
    }

    #[test]
    fn never_clamps_the_host_terminal_itself() {
        assert_eq!(
            clamp_resize(req(200, 50, Some(ResizeSource::Host), None), HOST, true),
            Dimensions {
                cols: 200,
                rows: 50
            }
        );
    }

    #[test]
    fn passes_the_browser_viewport_through_when_clamping_is_disabled() {
        assert_eq!(
            clamp_resize(req(200, 50, Some(ResizeSource::Viewer), None), HOST, false),
            Dimensions {
                cols: 200,
                rows: 50
            }
        );
    }

    #[test]
    fn passes_a_fill_mode_browser_viewport_through_even_when_clamping_is_enabled() {
        assert_eq!(
            clamp_resize(
                req(
                    200,
                    50,
                    Some(ResizeSource::Viewer),
                    Some(TerminalResizeMode::Fill)
                ),
                HOST,
                true
            ),
            Dimensions {
                cols: 200,
                rows: 50
            }
        );
    }

    #[test]
    fn clamps_a_clamped_mode_browser_viewport_when_clamping_is_enabled() {
        assert_eq!(
            clamp_resize(
                req(
                    200,
                    50,
                    Some(ResizeSource::Viewer),
                    Some(TerminalResizeMode::Clamped)
                ),
                HOST,
                true
            ),
            Dimensions { cols: 80, rows: 24 }
        );
    }

    #[test]
    fn treats_a_missing_source_as_a_viewer() {
        assert_eq!(
            clamp_resize(req(200, 50, None, None), HOST, true),
            Dimensions { cols: 80, rows: 24 }
        );
    }

    #[test]
    fn floors_dimensions_at_1x1() {
        assert_eq!(
            clamp_resize(req(0, 0, Some(ResizeSource::Host), None), HOST, true),
            Dimensions { cols: 1, rows: 1 }
        );
    }

    #[test]
    fn returns_the_host_size_when_the_applied_size_differs() {
        assert_eq!(
            revert_size(
                Dimensions { cols: 80, rows: 24 },
                Dimensions { cols: 40, rows: 12 }
            ),
            Some(Dimensions { cols: 80, rows: 24 })
        );
    }

    #[test]
    fn returns_none_when_applied_already_matches_host() {
        assert_eq!(
            revert_size(
                Dimensions { cols: 80, rows: 24 },
                Dimensions { cols: 80, rows: 24 }
            ),
            None
        );
    }

    #[test]
    fn floors_the_host_dimensions_at_1x1() {
        assert_eq!(
            revert_size(
                Dimensions { cols: 0, rows: 0 },
                Dimensions { cols: 40, rows: 12 }
            ),
            Some(Dimensions { cols: 1, rows: 1 })
        );
    }
}
