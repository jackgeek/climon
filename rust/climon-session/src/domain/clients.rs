//! Client registry: tracks connected actor clients (dashboard/PWA/terminal
//! viewers) and the surface state they negotiate, deciding which clients are
//! eligible to receive state broadcasts.
//!
// Consumed by the aggregate actor state (`engine::state`); the one accessor it
// does not yet need carries a local allowance.

use std::collections::HashMap;

use climon_proto::frame::SurfaceKind;

use crate::engine::effect::ClientId;

/// Per-client negotiated surface state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ClientState {
    pub(crate) viewer_id: String,
    pub(crate) kind: SurfaceKind,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
    pub(crate) seq: u64,
    pub(crate) initialized: bool,
}

/// Registry of connected clients, keyed by [`ClientId`].
#[derive(Debug, Default)]
pub(crate) struct ClientRegistry {
    clients: HashMap<ClientId, ClientState>,
    next_seq: u64,
}

impl ClientRegistry {
    /// Registers `id` as connected with default surface state, replacing any
    /// prior state for a reused id (reconnect).
    pub(crate) fn connect(&mut self, id: ClientId) {
        self.clients.insert(
            id,
            ClientState {
                viewer_id: format!("client-{}", id.0),
                kind: SurfaceKind::Dashboard,
                cols: 0,
                rows: 0,
                seq: 0,
                initialized: false,
            },
        );
    }

    /// Updates the negotiated surface for a connected client. `viewer_id` is
    /// ignored (preserving the existing id) when empty or the literal
    /// `"local"`; `cols`/`rows` are clamped to at least 1. No-op if `id` is
    /// not connected.
    pub(crate) fn update_surface(
        &mut self,
        id: ClientId,
        viewer_id: &str,
        kind: SurfaceKind,
        cols: u16,
        rows: u16,
    ) {
        if let Some(state) = self.clients.get_mut(&id) {
            if !viewer_id.is_empty() && viewer_id != "local" {
                state.viewer_id = viewer_id.to_string();
            }
            state.kind = kind;
            state.cols = cols.max(1);
            state.rows = rows.max(1);
        }
    }

    /// Marks a connected client initialized, assigning it the next broadcast
    /// sequence number. No-op if `id` is unknown or already initialized.
    pub(crate) fn mark_initialized(&mut self, id: ClientId) {
        let next_seq = self.next_seq;
        if let Some(state) = self.clients.get_mut(&id) {
            if !state.initialized {
                state.initialized = true;
                state.seq = next_seq;
                self.next_seq = next_seq + 1;
            }
        }
    }

    /// Returns the connected, initialized client ids sorted by numeric id.
    pub(crate) fn broadcast_recipients(&self) -> Vec<ClientId> {
        let mut ids: Vec<ClientId> = self
            .clients
            .iter()
            .filter(|(_, state)| state.initialized)
            .map(|(id, _)| *id)
            .collect();
        ids.sort_by_key(|id| id.0);
        ids
    }

    /// Returns every connected client id (initialized or not) sorted by numeric
    /// id. Used to close all clients during exit finalization.
    pub(crate) fn ids(&self) -> Vec<ClientId> {
        let mut ids: Vec<ClientId> = self.clients.keys().copied().collect();
        ids.sort_by_key(|id| id.0);
        ids
    }

    pub(crate) fn get(&self, id: ClientId) -> Option<&ClientState> {
        self.clients.get(&id)
    }

    // Symmetric accessor the aggregate does not yet mutate through; retained
    // for the coordinator wiring.
    #[allow(dead_code)]
    pub(crate) fn get_mut(&mut self, id: ClientId) -> Option<&mut ClientState> {
        self.clients.get_mut(&id)
    }

    pub(crate) fn remove(&mut self, id: ClientId) -> Option<ClientState> {
        self.clients.remove(&id)
    }
}

#[cfg(test)]
mod tests {
    use climon_proto::frame::SurfaceKind;

    use crate::engine::effect::ClientId;

    use super::ClientRegistry;

    #[test]
    fn client_joins_broadcasts_only_after_initialization() {
        let mut clients = ClientRegistry::default();
        clients.connect(ClientId(1));
        assert!(clients.broadcast_recipients().is_empty());
        clients.update_surface(ClientId(1), "dash", SurfaceKind::Dashboard, 100, 30);
        clients.mark_initialized(ClientId(1));
        assert_eq!(clients.broadcast_recipients(), vec![ClientId(1)]);
    }

    #[test]
    fn connect_assigns_default_viewer_id_from_numeric_id() {
        let mut clients = ClientRegistry::default();
        clients.connect(ClientId(7));
        assert_eq!(clients.get(ClientId(7)).unwrap().viewer_id, "client-7");
    }

    #[test]
    fn update_surface_ignores_literal_local_viewer_id() {
        let mut clients = ClientRegistry::default();
        clients.connect(ClientId(1));
        clients.update_surface(ClientId(1), "local", SurfaceKind::Terminal, 80, 24);
        assert_eq!(clients.get(ClientId(1)).unwrap().viewer_id, "client-1");
    }

    #[test]
    fn update_surface_clamps_dimensions_to_at_least_one() {
        let mut clients = ClientRegistry::default();
        clients.connect(ClientId(1));
        clients.update_surface(ClientId(1), "dash", SurfaceKind::Dashboard, 0, 0);
        let state = clients.get(ClientId(1)).unwrap();
        assert_eq!((state.cols, state.rows), (1, 1));
    }

    #[test]
    fn mark_initialized_assigns_sequence_once_per_client() {
        let mut clients = ClientRegistry::default();
        clients.connect(ClientId(1));
        clients.connect(ClientId(2));
        clients.mark_initialized(ClientId(1));
        clients.mark_initialized(ClientId(2));
        clients.mark_initialized(ClientId(1));
        assert_eq!(clients.get(ClientId(1)).unwrap().seq, 0);
        assert_eq!(clients.get(ClientId(2)).unwrap().seq, 1);
    }

    #[test]
    fn ids_returns_every_connected_client_sorted_regardless_of_initialization() {
        let mut clients = ClientRegistry::default();
        clients.connect(ClientId(3));
        clients.connect(ClientId(1));
        clients.mark_initialized(ClientId(1));
        assert_eq!(clients.ids(), vec![ClientId(1), ClientId(3)]);
    }
}
