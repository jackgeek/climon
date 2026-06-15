/** One downloadable artifact: the zip URL and its detached signature URL. */
export type ManifestArtifact = { url: string; sig: string };

/** The release manifest published alongside signed artifacts. */
export type Manifest = {
  version: string;
  artifacts: Record<string, ManifestArtifact>;
};

function parse(version: string): [number, number, number] {
  const cleaned = version.trim().replace(/^v/, "");
  const [maj = "0", min = "0", pat = "0"] = cleaned.split(".");
  return [Number(maj) || 0, Number(min) || 0, Number(pat) || 0];
}

/** Returns >0 if a>b, 0 if equal, <0 if a<b (major, minor, patch order). */
export function compareSemver(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** True when the manifest's version is strictly newer than `current`. */
export function isNewer(manifest: Manifest, current: string): boolean {
  return compareSemver(manifest.version, current) > 0;
}

/** Fetches and validates a release manifest from a URL. */
export async function fetchManifest(url: string): Promise<Manifest> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Manifest fetch failed: HTTP ${res.status}`);
  const data = (await res.json()) as Manifest;
  if (typeof data.version !== "string" || typeof data.artifacts !== "object") {
    throw new Error("Malformed manifest");
  }
  return data;
}

/** Maps the current process to its artifact key, e.g. "linux-x64". */
export function currentArtifactKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  const os =
    platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : "linux";
  const cpu = arch === "arm64" ? "arm64" : "x64";
  return `${os}-${cpu}`;
}
