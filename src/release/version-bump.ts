export type BumpLevel = "patch" | "minor" | "major";

const LEVELS: readonly BumpLevel[] = ["patch", "minor", "major"];

/**
 * Resolves a CLI argument into a bump level, defaulting to `patch` when no
 * argument is supplied. Throws on anything that is not patch/minor/major.
 */
export function parseLevel(arg: string | undefined): BumpLevel {
  if (arg === undefined) {
    return "patch";
  }
  if ((LEVELS as readonly string[]).includes(arg)) {
    return arg as BumpLevel;
  }
  throw new Error(`Invalid bump level '${arg}'. Expected one of: ${LEVELS.join(", ")}.`);
}

/**
 * Returns the next semantic version after applying the given bump level to a
 * strict `X.Y.Z` version. Prerelease/build metadata is rejected so the release
 * flow stays unambiguous.
 */
export function bumpVersion(current: string, level: BumpLevel): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) {
    throw new Error(`Cannot bump version '${current}': expected strict X.Y.Z.`);
  }
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  switch (level) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
  }
}
