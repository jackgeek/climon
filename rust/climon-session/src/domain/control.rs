//! Actor-domain control-handoff state: wraps the pure decision core in
//! `crate::control` (shared, unmodified, with the legacy host) with the
//! mutable bookkeeping the actor needs — which surfaces are connected, at
//! what size, and who currently holds the pty.
//!
// Consumed by the aggregate actor state assembled in a later task (Task 8);
// some accessors below are unused within this crate until then.
#![allow(dead_code)]

use std::collections::HashMap;

use climon_proto::frame::SurfaceKind;

use crate::control::{choose_controller, Surface};

/// The stable id used for the local, in-process attached terminal.
pub(crate) const LOCAL_ID: &str = "local";

/// A connected non-local surface's negotiated size and connection order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SurfaceState {
    pub(crate) id: String,
    pub(crate) kind: SurfaceKind,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
    pub(crate) seq: u64,
}

impl SurfaceState {
    /// Creates a surface state, clamping `cols`/`rows` to at least 1.
    pub(crate) fn new(id: &str, kind: SurfaceKind, cols: u16, rows: u16, seq: u64) -> Self {
        Self {
            id: id.to_string(),
            kind,
            cols: cols.max(1),
            rows: rows.max(1),
            seq,
        }
    }
}

impl From<&SurfaceState> for Surface {
    fn from(state: &SurfaceState) -> Self {
        Surface {
            id: state.id.clone(),
            kind: state.kind,
            cols: state.cols,
            rows: state.rows,
            seq: state.seq,
        }
    }
}

/// The result of a control-handoff transition: who now controls the pty and
/// at what size, and whether the applied size actually changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ControlChange {
    pub(crate) controller_id: String,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
    pub(crate) size_changed: bool,
}

/// Owns the connected surfaces and decides who controls the pty, mirroring
/// the legacy host's control-handoff behaviour but as pure, unit-testable
/// state transitions.
#[derive(Debug)]
pub(crate) struct ControlState {
    host_cols: u16,
    host_rows: u16,
    applied_cols: u16,
    applied_rows: u16,
    local_attached: bool,
    controller_id: Option<String>,
    surfaces: HashMap<String, SurfaceState>,
}

impl ControlState {
    /// Creates control state for a host of `host_cols`x`host_rows`. When
    /// `local_attached`, the local terminal starts as controller.
    pub(crate) fn new(host_cols: u16, host_rows: u16, local_attached: bool) -> Self {
        let cols = host_cols.max(1);
        let rows = host_rows.max(1);
        Self {
            host_cols: cols,
            host_rows: rows,
            applied_cols: cols,
            applied_rows: rows,
            local_attached,
            controller_id: local_attached.then(|| LOCAL_ID.to_string()),
            surfaces: HashMap::new(),
        }
    }

    /// Inserts or replaces a non-local surface's state by id.
    pub(crate) fn upsert(&mut self, surface: SurfaceState) {
        self.surfaces.insert(surface.id.clone(), surface);
    }

    /// Reports a resize of the local host terminal. Returns a change only
    /// when the local terminal is the current controller.
    pub(crate) fn report_local_size(&mut self, cols: u16, rows: u16) -> Option<ControlChange> {
        let cols = cols.max(1);
        let rows = rows.max(1);
        self.host_cols = cols;
        self.host_rows = rows;
        (self.controller_id.as_deref() == Some(LOCAL_ID))
            .then(|| self.apply_size(LOCAL_ID.to_string(), cols, rows))
    }

    /// Reports a resize of a known non-local surface. Returns `None` if `id`
    /// is unknown; returns a change only when `id` is the current controller.
    pub(crate) fn report_surface_size(
        &mut self,
        id: &str,
        cols: u16,
        rows: u16,
    ) -> Option<ControlChange> {
        let cols = cols.max(1);
        let rows = rows.max(1);
        let surface = self.surfaces.get_mut(id)?;
        surface.cols = cols;
        surface.rows = rows;
        (self.controller_id.as_deref() == Some(id))
            .then(|| self.apply_size(id.to_string(), cols, rows))
    }

    /// Hands manual control to `id`. `"local"` succeeds only when the local
    /// terminal is attached; any other id must be a known surface. Unknown
    /// ids are ignored, returning `None`.
    pub(crate) fn take_control(&mut self, id: &str) -> Option<ControlChange> {
        if id == LOCAL_ID {
            if !self.local_attached {
                return None;
            }
            let (cols, rows) = (self.host_cols, self.host_rows);
            self.controller_id = Some(LOCAL_ID.to_string());
            Some(self.apply_size(LOCAL_ID.to_string(), cols, rows))
        } else {
            let surface = self.surfaces.get(id)?;
            let (cols, rows) = (surface.cols, surface.rows);
            self.controller_id = Some(id.to_string());
            Some(self.apply_size(id.to_string(), cols, rows))
        }
    }

    /// Removes a non-local surface. The local terminal is never removed via
    /// this method since it is not a connectable surface.
    pub(crate) fn remove(&mut self, id: &str) {
        if id != LOCAL_ID {
            self.surfaces.remove(id);
        }
    }

    /// Re-derives the controller after a disconnect. If the current
    /// controller is still connected (or is the still-attached local
    /// terminal), this is a no-op returning `None`. Otherwise falls back to
    /// [`choose_controller`] over the remaining non-local surfaces plus the
    /// local terminal (as a `seq: 0` surface, if attached), applying its
    /// size. If no surfaces remain, the controller becomes `None`.
    pub(crate) fn recompute(&mut self) -> Option<ControlChange> {
        if let Some(current) = &self.controller_id {
            let current_still_connected = if current == LOCAL_ID {
                self.local_attached
            } else {
                self.surfaces.contains_key(current)
            };
            if current_still_connected {
                return None;
            }
        }

        let mut candidates: Vec<Surface> = self.surfaces.values().map(Surface::from).collect();
        if self.local_attached {
            candidates.push(Surface {
                id: LOCAL_ID.to_string(),
                kind: SurfaceKind::Terminal,
                cols: self.host_cols,
                rows: self.host_rows,
                seq: 0,
            });
        }

        match choose_controller(&candidates) {
            Some(winner) => {
                let (id, cols, rows) = (winner.id.clone(), winner.cols, winner.rows);
                self.controller_id = Some(id.clone());
                Some(self.apply_size(id, cols, rows))
            }
            None => {
                self.controller_id = None;
                None
            }
        }
    }

    pub(crate) fn controller_id(&self) -> Option<&str> {
        self.controller_id.as_deref()
    }

    pub(crate) fn applied_size(&self) -> (u16, u16) {
        (self.applied_cols, self.applied_rows)
    }

    pub(crate) fn host_size(&self) -> (u16, u16) {
        (self.host_cols, self.host_rows)
    }

    /// Applies `cols`x`rows` as the new controller's size, reporting whether
    /// it differs from the previously applied size.
    fn apply_size(&mut self, controller_id: String, cols: u16, rows: u16) -> ControlChange {
        let size_changed = (cols, rows) != (self.applied_cols, self.applied_rows);
        self.applied_cols = cols;
        self.applied_rows = rows;
        ControlChange {
            controller_id,
            cols,
            rows,
            size_changed,
        }
    }
}

#[cfg(test)]
mod tests {
    use climon_proto::frame::SurfaceKind;

    use super::{ControlState, SurfaceState};

    #[test]
    fn disconnected_controller_falls_back_by_priority_then_recency() {
        let mut control = ControlState::new(80, 24, true);
        control.upsert(SurfaceState::new(
            "dash",
            SurfaceKind::Dashboard,
            100,
            30,
            1,
        ));
        control.upsert(SurfaceState::new("pwa", SurfaceKind::Pwa, 90, 28, 2));
        control.take_control("dash");
        control.remove("dash");
        let change = control.recompute().unwrap();
        assert_eq!(change.controller_id, "pwa");
        assert_eq!((change.cols, change.rows), (90, 28));
    }

    #[test]
    fn reporting_unchanged_size_marks_no_change() {
        let mut control = ControlState::new(80, 24, true);
        let first = control.report_local_size(100, 40).unwrap();
        assert!(first.size_changed);
        let second = control.report_local_size(100, 40).unwrap();
        assert!(!second.size_changed);
    }

    #[test]
    fn new_controller_defaults_to_local_when_attached() {
        let control = ControlState::new(80, 24, true);
        assert_eq!(control.controller_id(), Some("local"));
    }

    #[test]
    fn take_control_of_unknown_surface_is_ignored() {
        let mut control = ControlState::new(80, 24, true);
        let change = control.take_control("ghost");
        assert!(change.is_none());
        assert_eq!(control.controller_id(), Some("local"));
    }

    #[test]
    fn recompute_is_noop_when_controller_still_connected() {
        let mut control = ControlState::new(80, 24, true);
        control.upsert(SurfaceState::new(
            "dash",
            SurfaceKind::Dashboard,
            100,
            30,
            1,
        ));
        control.take_control("dash");
        assert!(control.recompute().is_none());
    }

    #[test]
    fn recompute_falls_back_to_local_when_it_is_the_only_surface() {
        let mut control = ControlState::new(80, 24, true);
        control.upsert(SurfaceState::new(
            "dash",
            SurfaceKind::Dashboard,
            100,
            30,
            1,
        ));
        control.take_control("dash");
        control.remove("dash");
        let change = control.recompute().unwrap();
        assert_eq!(change.controller_id, "local");
        assert_eq!((change.cols, change.rows), (80, 24));
    }
}
