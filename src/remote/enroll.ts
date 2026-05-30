import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname, networkInterfaces, homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

const KEY_TYPE_ALLOW = new Set([
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521"
]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const LABEL = /^[A-Za-z0-9._-]{1,64}$/;
const BEGIN = "# climon-managed BEGIN";
const END = "# climon-managed END";

export interface ParsedKey {
  type: string;
  base64: string;
  comment: string;
}

export interface ManagedClient {
  label: string;
  type: string;
  base64: string;
}

export function parsePublicKey(line: string): ParsedKey {
  if (/[\r\n]/.test(line)) {
    throw new Error("Public key must be a single line.");
  }
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) {
    throw new Error("Public key must include a type and a base64 body.");
  }
  const [type, base64, ...commentParts] = parts;
  if (!KEY_TYPE_ALLOW.has(type)) {
    throw new Error(`Unsupported key type '${type}'.`);
  }
  if (!BASE64.test(base64) || base64.length % 4 !== 0) {
    throw new Error("Public key body is not valid base64.");
  }
  return { type, base64, comment: commentParts.join(" ") };
}

export function sanitizeLabel(label: string): string {
  if (!LABEL.test(label)) {
    throw new Error("Label must match [A-Za-z0-9._-] and be 1-64 characters.");
  }
  return label;
}

export function buildAuthorizedKeysEntry(parsed: ParsedKey, label: string): string {
  const safe = sanitizeLabel(label);
  return `command="climon-server --ssh-accept --label ${safe}",restrict ${parsed.type} ${parsed.base64} climon:${safe}`;
}

function entryLabel(entry: string): string | undefined {
  return entry.match(/--ssh-accept --label ([A-Za-z0-9._-]+)"/)?.[1];
}

function splitManaged(content: string): { outside: string; entries: string[] } {
  const lines = content.split("\n");
  const begin = lines.indexOf(BEGIN);
  const end = lines.indexOf(END);
  if (begin === -1 || end === -1 || end < begin) {
    return { outside: content, entries: [] };
  }
  const entries = lines.slice(begin + 1, end).filter((l) => l.trim().length > 0);
  const outside = [...lines.slice(0, begin), ...lines.slice(end + 1)].join("\n");
  return { outside, entries };
}

function joinManaged(outside: string, entries: string[]): string {
  const base = outside.replace(/\n+$/, "");
  const head = base.length > 0 ? `${base}\n` : "";
  if (entries.length === 0) {
    return head;
  }
  return `${head}${BEGIN}\n${entries.join("\n")}\n${END}\n`;
}

export function addManagedKey(content: string, parsed: ParsedKey, label: string): string {
  const entry = buildAuthorizedKeysEntry(parsed, label);
  const { outside, entries } = splitManaged(content);
  const kept = entries.filter((e) => entryLabel(e) !== label);
  kept.push(entry);
  return joinManaged(outside, kept);
}

export function revokeManagedClient(content: string, label: string): string {
  const { outside, entries } = splitManaged(content);
  return joinManaged(
    outside,
    entries.filter((e) => entryLabel(e) !== label)
  );
}

export function listManagedClients(content: string): ManagedClient[] {
  const { entries } = splitManaged(content);
  const out: ManagedClient[] = [];
  for (const entry of entries) {
    const label = entryLabel(entry);
    const m = entry.match(/restrict (\S+) (\S+)/);
    if (label && m) {
      out.push({ label, type: m[1], base64: m[2] });
    }
  }
  return out;
}

/** Reads ~/.ssh/authorized_keys, returning "" when absent. */
export async function readAuthorizedKeys(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

/** Atomically writes authorized_keys (temp + rename), ensuring 0700 dir / 0600 file. */
export async function writeAuthorizedKeys(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await chmod(dir, 0o700);
  } catch {
    // Non-POSIX filesystems.
  }
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, content, { mode: 0o600 });
  await rename(tempPath, path);
  try {
    await chmod(path, 0o600);
  } catch {
    // Non-POSIX filesystems.
  }
}

/** Candidate SSH host addresses for the setup command: hostname + non-internal IPs. */
export function hostCandidates(): string[] {
  const candidates = new Set<string>();
  candidates.add(hostname());
  for (const iface of Object.values(networkInterfaces())) {
    for (const info of iface ?? []) {
      if (!info.internal) {
        candidates.add(info.address);
      }
    }
  }
  return [...candidates];
}

/**
 * Returns the home machine's SSH host public-key line (type + base64 only),
 * read from the standard host key, falling back to `ssh-keyscan` on localhost.
 */
export async function detectHostKey(): Promise<string | undefined> {
  try {
    const raw = await readFile("/etc/ssh/ssh_host_ed25519_key.pub", "utf8");
    const [type, base64] = raw.trim().split(/\s+/);
    if (type && base64) {
      return `${type} ${base64}`;
    }
  } catch {
    // Fall through to ssh-keyscan.
  }
  const scan = spawnSync("ssh-keyscan", ["-t", "ed25519", "127.0.0.1"], { encoding: "utf8" });
  if (scan.status === 0) {
    for (const line of scan.stdout.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 3 && parts[1] === "ssh-ed25519") {
        return `${parts[1]} ${parts[2]}`;
      }
    }
  }
  return undefined;
}

// ---- High-level enrollment service (operates on the real authorized_keys) ----

export interface ClientInfo {
  label: string;
  keyType: string;
  fingerprint: string;
}

/** Default path to the current user's authorized_keys. */
export function authorizedKeysPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME ?? homedir(), ".ssh", "authorized_keys");
}

/** OpenSSH-style SHA256 fingerprint of a base64 key blob. */
export function fingerprintKey(base64: string): string {
  const digest = createHash("sha256").update(Buffer.from(base64, "base64")).digest("base64").replace(/=+$/, "");
  return `SHA256:${digest}`;
}

export async function listClients(path: string = authorizedKeysPath()): Promise<ClientInfo[]> {
  const content = await readAuthorizedKeys(path);
  return listManagedClients(content).map((c) => ({
    label: c.label,
    keyType: c.type,
    fingerprint: fingerprintKey(c.base64)
  }));
}

export async function authorizeClient(
  label: string,
  parsed: ParsedKey,
  path: string = authorizedKeysPath()
): Promise<void> {
  const content = await readAuthorizedKeys(path);
  await writeAuthorizedKeys(path, addManagedKey(content, parsed, label));
}

/** Returns true if a client with that label existed and was removed. */
export async function revokeClient(label: string, path: string = authorizedKeysPath()): Promise<boolean> {
  const content = await readAuthorizedKeys(path);
  const had = listManagedClients(content).some((c) => c.label === label);
  if (!had) {
    return false;
  }
  await writeAuthorizedKeys(path, revokeManagedClient(content, label));
  return true;
}
