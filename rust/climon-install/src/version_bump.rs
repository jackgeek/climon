//! Semantic-version bump helper. 1:1 port of `src/release/version-bump.ts`.
//!
//! This is shared release logic also invoked by the Bun `scripts/` release
//! pipeline; the pure parse/bump functions are ported here with their tests.

/// A semver bump level.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BumpLevel {
    Patch,
    Minor,
    Major,
}

/// Resolves a CLI argument into a bump level, defaulting to `patch` when no
/// argument is supplied. Errors on anything that is not patch/minor/major.
pub fn parse_level(arg: Option<&str>) -> Result<BumpLevel, String> {
    match arg {
        None => Ok(BumpLevel::Patch),
        Some("patch") => Ok(BumpLevel::Patch),
        Some("minor") => Ok(BumpLevel::Minor),
        Some("major") => Ok(BumpLevel::Major),
        Some(other) => Err(format!(
            "Invalid bump level '{other}'. Expected one of: patch, minor, major."
        )),
    }
}

/// Returns the next semantic version after applying `level` to a strict `X.Y.Z`
/// version. Prerelease/build metadata is rejected.
pub fn bump_version(current: &str, level: BumpLevel) -> Result<String, String> {
    let parts: Vec<&str> = current.split('.').collect();
    let invalid = || format!("Cannot bump version '{current}': expected strict X.Y.Z.");
    if parts.len() != 3 {
        return Err(invalid());
    }
    let mut nums = [0u64; 3];
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return Err(invalid());
        }
        nums[i] = part.parse().map_err(|_| invalid())?;
    }
    let (major, minor, patch) = (nums[0], nums[1], nums[2]);
    Ok(match level {
        BumpLevel::Major => format!("{}.0.0", major + 1),
        BumpLevel::Minor => format!("{}.{}.0", major, minor + 1),
        BumpLevel::Patch => format!("{}.{}.{}", major, minor, patch + 1),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_level_defaults_to_patch() {
        assert_eq!(parse_level(None).unwrap(), BumpLevel::Patch);
    }

    #[test]
    fn parse_level_accepts_known() {
        assert_eq!(parse_level(Some("patch")).unwrap(), BumpLevel::Patch);
        assert_eq!(parse_level(Some("minor")).unwrap(), BumpLevel::Minor);
        assert_eq!(parse_level(Some("major")).unwrap(), BumpLevel::Major);
    }

    #[test]
    fn parse_level_rejects_unknown() {
        assert!(parse_level(Some("huge")).is_err());
        assert!(parse_level(Some("")).is_err());
    }

    #[test]
    fn patch_increments_patch() {
        assert_eq!(bump_version("0.1.0", BumpLevel::Patch).unwrap(), "0.1.1");
        assert_eq!(bump_version("1.2.3", BumpLevel::Patch).unwrap(), "1.2.4");
    }

    #[test]
    fn minor_increments_minor_resets_patch() {
        assert_eq!(bump_version("0.1.5", BumpLevel::Minor).unwrap(), "0.2.0");
        assert_eq!(bump_version("1.2.3", BumpLevel::Minor).unwrap(), "1.3.0");
    }

    #[test]
    fn major_increments_major_resets_rest() {
        assert_eq!(bump_version("0.1.5", BumpLevel::Major).unwrap(), "1.0.0");
        assert_eq!(bump_version("1.2.3", BumpLevel::Major).unwrap(), "2.0.0");
    }

    #[test]
    fn rejects_non_strict_versions() {
        assert!(bump_version("1.2", BumpLevel::Patch).is_err());
        assert!(bump_version("1.2.3-beta.1", BumpLevel::Patch).is_err());
        assert!(bump_version("v1.2.3", BumpLevel::Patch).is_err());
    }
}
