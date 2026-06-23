import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface StoredPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

export function subscriptionsPath(climonHome: string): string {
  return join(climonHome, "push", "subscriptions.json");
}

const INTERNAL_HOST_EXACT = new Set([
  "localhost",
  "local",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
]);
const INTERNAL_HOST_SUFFIXES = [".localhost", ".local", ".internal"];

function normalizeEndpointHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

function isInternalHostname(hostname: string): boolean {
  if (INTERNAL_HOST_EXACT.has(hostname)) return true;
  return INTERNAL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

function ipv4OctetsFromLiteral(hostname: string): [number, number, number, number] | undefined {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return undefined;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return undefined;
  return octets as [number, number, number, number];
}

function isPrivateIpv4Octets([a, b]: [number, number, number, number]): boolean {
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function ipv4OctetsFromEmbeddedIpv6Literal(hostname: string): [number, number, number, number] | undefined {
  let embedded: string;
  if (hostname.startsWith("::ffff:")) {
    embedded = hostname.slice("::ffff:".length);
  } else if (hostname.startsWith("::")) {
    embedded = hostname.slice("::".length);
  } else {
    return undefined;
  }

  const dotted = ipv4OctetsFromLiteral(embedded);
  if (dotted) return dotted;

  const parts = embedded.split(":");
  if (parts.length !== 2) return undefined;
  const words = parts.map((part) => Number.parseInt(part, 16));
  if (words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) return undefined;
  return [words[0] >> 8, words[0] & 0xff, words[1] >> 8, words[1] & 0xff];
}

function isPrivateIpv6Literal(hostname: string): boolean {
  if (hostname === "::" || hostname === "::1") return true;

  const embeddedIpv4 = ipv4OctetsFromEmbeddedIpv6Literal(hostname);
  if (embeddedIpv4) return isPrivateIpv4Octets(embeddedIpv4);

  const firstHextet = hostname.split(":")[0];
  if (firstHextet.length === 0) return false;
  const first = Number.parseInt(firstHextet, 16);
  if (!Number.isInteger(first)) return false;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  return false;
}

function isPrivateIpLiteral(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized.includes(":")) return isPrivateIpv6Literal(normalized);

  const ipv4 = ipv4OctetsFromLiteral(normalized);
  if (!ipv4) return false;
  return isPrivateIpv4Octets(ipv4);
}

/**
 * Restricts a web-push endpoint to an https URL that is not aimed at an
 * internal IP literal or known-internal DNS hostname, closing the SSRF vector
 * where a tunnel client registers an endpoint pointing at an internal service.
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const hostname = normalizeEndpointHostname(url.hostname);
  if (isInternalHostname(hostname)) return false;
  return !isPrivateIpLiteral(hostname);
}

export function isValidSubscription(value: unknown): value is StoredPushSubscription {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.endpoint !== "string" || v.endpoint.length === 0) return false;
  if (!isAllowedPushEndpoint(v.endpoint)) return false;
  const keys = v.keys as Record<string, unknown> | undefined;
  if (!keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") return false;
  return true;
}

async function readAll(climonHome: string): Promise<StoredPushSubscription[]> {
  const file = Bun.file(subscriptionsPath(climonHome));
  if (!(await file.exists())) return [];
  try {
    const parsed = (await file.json()) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidSubscription);
  } catch {
    return [];
  }
}

async function writeAll(climonHome: string, subs: StoredPushSubscription[]): Promise<void> {
  const path = subscriptionsPath(climonHome);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(subs, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

export async function listSubscriptions(climonHome: string): Promise<StoredPushSubscription[]> {
  return readAll(climonHome);
}

export async function addSubscription(
  climonHome: string,
  subscription: StoredPushSubscription,
): Promise<void> {
  const subs = await readAll(climonHome);
  const next = subs.filter((s) => s.endpoint !== subscription.endpoint);
  next.push(subscription);
  await writeAll(climonHome, next);
}

export async function removeSubscription(climonHome: string, endpoint: string): Promise<void> {
  const subs = await readAll(climonHome);
  const next = subs.filter((s) => s.endpoint !== endpoint);
  if (next.length !== subs.length) await writeAll(climonHome, next);
}
