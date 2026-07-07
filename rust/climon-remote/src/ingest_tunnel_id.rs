//! Shared ingest tunnel id derivation. MUST match the TypeScript host
//! (`src/remote/ingest-tunnel-id.ts`): `climon-ingest-<first 20 hex of
//! sha256("climon-ingest" + install.id)>`.

use sha2::{Digest, Sha256};

/// Shared discovery label applied to the host's ingest tunnel.
pub const INGEST_TUNNEL_LABEL: &str = "climon-ingest";

/// Derives the stable ingest tunnel id from the anonymous install id.
/// Contract: `climon-ingest-<first 20 hex of sha256("climon-ingest" + install_id)>`.
pub fn derive_ingest_tunnel_id(install_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(INGEST_TUNNEL_LABEL.as_bytes());
    hasher.update(install_id.as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("{INGEST_TUNNEL_LABEL}-{}", &hex[..20])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_the_pinned_shared_test_vector() {
        assert_eq!(
            derive_ingest_tunnel_id("00000000-0000-4000-8000-000000000000"),
            "climon-ingest-f6466583e8b34a25d74d"
        );
    }

    #[test]
    fn label_is_the_shared_constant() {
        assert_eq!(INGEST_TUNNEL_LABEL, "climon-ingest");
    }

    #[test]
    fn is_deterministic_and_shaped() {
        let a = derive_ingest_tunnel_id("abc");
        assert_eq!(a, derive_ingest_tunnel_id("abc"));
        assert_ne!(a, derive_ingest_tunnel_id("abd"));
        let slug = a.strip_prefix("climon-ingest-").unwrap();
        assert_eq!(slug.len(), 20);
        assert!(slug
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
    }
}
