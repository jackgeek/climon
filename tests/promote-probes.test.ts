import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AddressInfo, createServer, type Server } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPromoteDeps } from "../src/server/promote-probes.js";
import { serializeIngestState } from "../src/remote/ingest-state.js";
import { serializeServerState } from "../src/server-state.js";
import { getShutdownRequestPathInDir, parseShutdownRequest } from "../src/remote/shutdown-request.js";

let peerHome: string;
let server: Server | undefined;
const env = {} as NodeJS.ProcessEnv;
const fastTiming = { confirmTimeoutMs: 300, confirmPollMs: 30, probeTimeoutMs: 500 };

beforeEach(() => {
  const testTmp = join(process.cwd(), ".copilot-tmp");
  mkdirSync(testTmp, { recursive: true });
  peerHome = mkdtempSync(join(testTmp, "climon-promote-probes-"));
});
afterEach(() => {
  server?.close();
  server = undefined;
  rmSync(peerHome, { recursive: true, force: true });
});

function listen(): Promise<number> {
  return new Promise((resolve) => {
    server = createServer(() => {});
    server.listen(0, "127.0.0.1", () => resolve((server!.address() as AddressInfo).port));
  });
}

function writeIngestBeacon(port: number): void {
  writeFileSync(
    join(peerHome, "ingest.json"),
    serializeIngestState({ pid: process.pid, port, host: "127.0.0.1" })
  );
}

describe("buildPromoteDeps (filesystem control plane)", () => {
  test("readPeerIngest yields the published host", async () => {
    const port = await listen();
    writeIngestBeacon(port);
    const deps = buildPromoteDeps(peerHome, env, "WSL");
    expect(await deps.readPeerIngest()).toEqual({ port, host: "127.0.0.1" });
  });

  test("probeIngestListening is true for a live listener, false once closed", async () => {
    const port = await listen();
    writeIngestBeacon(port);
    const deps = buildPromoteDeps(peerHome, env, "WSL", () => {}, fastTiming);
    expect(await deps.probeIngestListening({ port, host: "127.0.0.1" })).toBe(true);
    server?.close();
    server = undefined;
    expect(await deps.probeIngestListening({ port, host: "127.0.0.1" })).toBe(false);
  });

  test("writeShutdownRequest writes an allow-listed request into the peer home", async () => {
    const deps = buildPromoteDeps(peerHome, env, "WSL");
    await deps.writeShutdownRequest();
    const parsed = parseShutdownRequest(readFileSync(getShutdownRequestPathInDir(peerHome), "utf8"));
    // requestedBy is the LOCAL OS — the opposite of the "WSL" peer label.
    expect(parsed?.requestedBy).toBe("Windows");
  });

  test("clearPeerBeacons removes the peer server.json, ingest.json, and request", async () => {
    writeFileSync(join(peerHome, "server.json"), serializeServerState({ pid: 1, port: 3131 }));
    writeIngestBeacon(3132);
    const deps = buildPromoteDeps(peerHome, env, "WSL");
    await deps.writeShutdownRequest();
    await deps.clearPeerBeacons();
    expect(existsSync(join(peerHome, "server.json"))).toBe(false);
    expect(existsSync(join(peerHome, "ingest.json"))).toBe(false);
    expect(existsSync(getShutdownRequestPathInDir(peerHome))).toBe(false);
  });

  test("confirmDemoted is false while the ingest listens, true once it closes and beacons clear", async () => {
    const port = await listen();
    writeIngestBeacon(port);
    const deps = buildPromoteDeps(peerHome, env, "WSL", () => {}, fastTiming);
    expect(await deps.confirmDemoted({ port, host: "127.0.0.1" })).toBe(false);
    server?.close();
    server = undefined;
    rmSync(join(peerHome, "ingest.json"), { force: true });
    expect(await deps.confirmDemoted({ port, host: "127.0.0.1" })).toBe(true);
  });
});
