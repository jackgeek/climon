import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { t } from "../i18n/t.js";
import { installFilesForPlatform } from "../install/install-manifest.js";
import { decryptEnvelope } from "./crypto-envelope.js";
import { downloadToFile, downloadText } from "./download.js";
import { currentArtifactKey, isNewer, type Manifest } from "./manifest.js";
import { cleanupOldFiles, replaceFileAtomic } from "./swap.js";
import { verifySignature } from "./verify.js";

export type UpdateStatus =
  | "updated"
  | "up-to-date"
  | "verify-failed"
  | "decrypt-failed"
  | "deferred"
  | "no-artifact";

export type UpdateResult = { status: UpdateStatus; version?: string };

export type UpdateCommandOptions = {
  installDir: string;
  currentVersion: string;
  manifest: Manifest;
  publicKeyB64: string;
  /** Shared password to decrypt artifacts when the manifest is encrypted. */
  decryptPassword?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  print?: (s: string) => void;
};

/**
 * Downloads, verifies, and applies an update without ever killing a process.
 * Returns a structured status; never throws for the expected outcomes.
 */
export async function runUpdateCommand(
  opts: UpdateCommandOptions
): Promise<UpdateResult> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const print = opts.print ?? ((s: string) => process.stdout.write(s));

  if (!isNewer(opts.manifest, opts.currentVersion)) {
    print(t("update.upToDate", { current: opts.currentVersion }) + "\n");
    return { status: "up-to-date" };
  }

  const key = currentArtifactKey(platform, arch);
  const artifact = opts.manifest.artifacts[key];
  if (!artifact) return { status: "no-artifact" };

  const work = mkdtempSync(join(tmpdir(), "climon-update-"));
  try {
    const zipPath = join(work, "artifact.zip");
    const downloaded = await downloadToFile(artifact.url, zipPath);
    const sigB64 = await downloadText(artifact.sig);

    let zipBytes = downloaded;
    if (opts.manifest.encryption) {
      const decrypted = decryptEnvelope(downloaded, opts.decryptPassword ?? "");
      if (!decrypted.ok) {
        print(t("update.decryptFailed") + "\n");
        return { status: "decrypt-failed" };
      }
      zipBytes = decrypted.bytes;
    }

    const ok = await verifySignature(zipBytes, sigB64, opts.publicKeyB64);
    if (!ok) {
      print(t("update.verifyFailed") + "\n");
      return { status: "verify-failed" };
    }

    const unzipped = unzipSync(zipBytes);
    const files = installFilesForPlatform(platform);
    let deferred = false;
    for (const { source, dest } of files) {
      const data = unzipped[source];
      if (!data) continue; // optional files (e.g. future locale packs) may be absent
      const result = replaceFileAtomic(opts.installDir, dest, data);
      if (result.deferred) deferred = true;
    }
    cleanupOldFiles(
      opts.installDir,
      files.map((f) => f.dest)
    );

    if (deferred) {
      print(t("update.deferredLocked") + "\n");
      return { status: "deferred", version: opts.manifest.version };
    }
    print(t("update.applied", { next: opts.manifest.version }) + "\n");
    return { status: "updated", version: opts.manifest.version };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
