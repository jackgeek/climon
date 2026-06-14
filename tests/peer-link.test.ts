import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  detectWindowsClimonHome,
  peerHostCandidates,
  wslDefaultGatewayIp,
  wslHomeUncPath
} from "../src/remote/peer.js";
import {
  getServerStatePath,
  readServerStateFromDir,
  serializeServerState
} from "../src/server-state.js";
import { serializeIngestState } from "../src/remote/ingest-state.js";
import { discoverDashboard } from "../src/remote/discovery.js";
import { linkPeer, maybeAutoLink } from "../src/remote/link.js";

let root: string;

beforeEach(() => {
  const testTmp = join(process.cwd(), ".copilot-tmp");
  mkdirSync(testTmp, { recursive: true });
  root = mkdtempSync(join(testTmp, "climon-peer-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeHome(name: string): string {
  const home = join(root, name);
  mkdirSync(home, { recursive: true });
  return home;
}

function writeServerJson(home: string, state: { pid: number; port: number; ingest?: number; startedAt?: number }): void {
  writeFileSync(join(home, "server.json"), serializeServerState(state));
}

function writeIngestJson(home: string, state: { pid: number; port: number; host?: string }): void {
  writeFileSync(join(home, "ingest.json"), serializeIngestState(state));
}


describe("peer helpers", () => {
  test("wslHomeUncPath builds a Windows UNC path from distro and HOME", () => {
    const env = { WSL_DISTRO_NAME: "Ubuntu", HOME: "/home/jack" };
    expect(wslHomeUncPath(env)).toBe("\\\\wsl.localhost\\Ubuntu\\home\\jack\\.climon");
  });

  test("wslHomeUncPath returns undefined without a distro name", () => {
    expect(wslHomeUncPath({ HOME: "/home/jack" })).toBeUndefined();
  });

  test("wslDefaultGatewayIp parses the little-endian default route gateway", () => {
    // Default route (00000000) via 192.168.0.1 -> little-endian "0100A8C0".
    const table = [
      "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask",
      "eth0\t00000000\t0100A8C0\t0003\t0\t0\t0\t00000000",
      "eth0\t0000A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF"
    ].join("\n");
    expect(wslDefaultGatewayIp(() => table)).toBe("192.168.0.1");
  });

  test("detectWindowsClimonHome resolves and translates the Windows profile", () => {
    const winHome = makeHome("winhome");
    const run = (file: string): string => {
      if (file === "cmd.exe") return "C:\\Users\\jack\r\n";
      if (file === "wslpath") return winHome;
      throw new Error(`unexpected ${file}`);
    };
    expect(detectWindowsClimonHome(run, (p) => p === join(winHome, ".climon"))).toBe(
      join(winHome, ".climon")
    );
  });

  test("detectWindowsClimonHome returns undefined when the home does not exist", () => {
    const run = (file: string): string => (file === "cmd.exe" ? "C:\\Users\\jack" : "/mnt/c/Users/jack");
    expect(detectWindowsClimonHome(run, () => false)).toBeUndefined();
  });

  test("peerHostCandidates always includes localhost", () => {
    expect(peerHostCandidates({})).toContain("localhost");
  });
});

describe("server-state", () => {
  test("serialize round-trips pid, port, and optional ingest", async () => {
    const home = makeHome("state");
    writeServerJson(home, { pid: 4242, port: 3131, ingest: 3132 });
    expect(await readServerStateFromDir(home)).toEqual({ pid: 4242, port: 3131, ingest: 3132 });
  });

  test("omits ingest when absent and rejects invalid pid/port", async () => {
    const home = makeHome("state2");
    writeFileSync(join(home, "server.json"), JSON.stringify({ pid: 0, port: 3131 }));
    expect(await readServerStateFromDir(home)).toBeUndefined();
    expect(serializeServerState({ pid: 1, port: 2 })).toBe('{"pid":1,"port":2}\n');
  });

  test("getServerStatePath honors CLIMON_HOME", () => {
    expect(getServerStatePath({ CLIMON_HOME: "/tmp/x" })).toBe(join("/tmp/x", "server.json"));
  });

  test("round-trips the optional startedAt promote timestamp", async () => {
    const home = makeHome("state3");
    writeServerJson(home, { pid: 4242, port: 3131, startedAt: 1700000000000 });
    expect(await readServerStateFromDir(home)).toEqual({ pid: 4242, port: 3131, startedAt: 1700000000000 });
    expect(serializeServerState({ pid: 1, port: 2, startedAt: 5 })).toBe('{"pid":1,"port":2,"startedAt":5}\n');
  });

  test("ignores a non-positive or non-finite startedAt", async () => {
    const home = makeHome("state4");
    writeFileSync(join(home, "server.json"), JSON.stringify({ pid: 1, port: 2, startedAt: 0 }));
    expect(await readServerStateFromDir(home)).toEqual({ pid: 1, port: 2 });
  });
});

describe("discoverDashboard", () => {
  test("returns a local target when the local beacon's pid is alive", async () => {
    const home = makeHome("local");
    writeServerJson(home, { pid: 999, port: 5000, ingest: 5001 });
    // A live local dashboard also runs an ingest, which writes the authoritative
    // bound port to ingest.json; discovery resolves the ingest port from there.
    writeIngestJson(home, { pid: 999, port: 5001 });
    const target = await discoverDashboard({ CLIMON_HOME: home }, root, { isAlive: () => true });
    expect(target).toEqual({
      location: "local",
      host: "127.0.0.1",
      port: 5000,
      ingest: 5001,
      url: "http://127.0.0.1:5000/"
    });
  });

  test("falls through to the peer host validated by the ingest beacon + TCP probe", async () => {
    const home = makeHome("client");
    const peer = makeHome("peer");
    writeServerJson(peer, { pid: 111, port: 6000 });
    writeIngestJson(peer, { pid: 222, port: 6001, host: "localhost" });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ remote: { peerHome: peer, peerHost: "localhost" } })
    );
    // Local pid is dead (no local server.json), so discovery probes the peer ingest.
    const target = await discoverDashboard({ CLIMON_HOME: home }, root, {
      isAlive: () => false,
      probeTcp: async (host, port) => host === "localhost" && port === 6001
    });
    expect(target).toMatchObject({
      location: "peer",
      host: "localhost",
      port: 6000,
      ingest: 6001,
      url: "http://localhost:6000/"
    });
  });

  test("ignores a peer with an ingest beacon that is not listening", async () => {
    const home = makeHome("client2");
    const peer = makeHome("peer2");
    writeServerJson(peer, { pid: 111, port: 6000 });
    writeIngestJson(peer, { pid: 222, port: 6001, host: "localhost" });
    writeFileSync(join(home, "config.json"), JSON.stringify({ remote: { peerHome: peer, peerHost: "localhost" } }));
    const target = await discoverDashboard({ CLIMON_HOME: home }, root, {
      isAlive: () => false,
      probeTcp: async () => false
    });
    expect(target).toBeUndefined();
  });

  test("returns undefined when nothing is discoverable", async () => {
    const home = makeHome("empty");
    const target = await discoverDashboard({ CLIMON_HOME: home }, root, { isAlive: () => false });
    expect(target).toBeUndefined();
  });
});

describe("linkPeer", () => {
  test("writes the local peer pointer and skips reverse when not on WSL", () => {
    const home = makeHome("wlocal");
    const peer = makeHome("wpeer");
    const result = linkPeer({ peerHome: peer }, { CLIMON_HOME: home }, root, { isWsl: () => false });
    expect(result.reverseLinked).toBe(false);
    expect(result.peerHome).toBe(peer);
    expect(readFileSync(join(home, "config.jsonc"), "utf8")).toContain('"peerHome"');
  });

  test("writes both directions when run from WSL", () => {
    const home = makeHome("wsl");
    const peer = makeHome("win");
    const result = linkPeer({ peerHome: peer }, { CLIMON_HOME: home }, root, {
      isWsl: () => true,
      wslHomeUncPath: () => "\\\\wsl.localhost\\Ubuntu\\home\\jack\\.climon"
    });
    expect(result.reverseLinked).toBe(true);
    expect(readFileSync(join(home, "config.jsonc"), "utf8")).toContain('"peerHome"');
    expect(readFileSync(join(peer, "config.jsonc"), "utf8")).toContain("wsl.localhost");
  });

  test("throws when the peer home cannot be determined", () => {
    expect(() =>
      linkPeer({}, { CLIMON_HOME: makeHome("nope") }, root, {
        isWsl: () => true,
        detectWindowsClimonHome: () => undefined
      })
    ).toThrow(/Windows CLIMON_HOME/);
  });
});

describe("maybeAutoLink", () => {
  test("announces, advises how to disable, links, and confirms success", async () => {
    const home = makeHome("auto");
    const peer = makeHome("autopeer");
    const lines: string[] = [];
    await maybeAutoLink({ CLIMON_HOME: home }, root, (t) => lines.push(t), {
      isWsl: () => true,
      detectWindowsClimonHome: () => peer,
      wslHomeUncPath: () => "\\\\wsl.localhost\\Ubuntu\\home\\jack\\.climon"
    });
    const text = lines.join("");
    expect(text).toContain("attempting to auto-link");
    expect(text).toContain("remote.autoLink false");
    expect(text).toContain("auto-link successful");
    expect(readFileSync(join(home, "config.jsonc"), "utf8")).toContain('"peerHome"');
  });

  test("stays silent when not running on WSL", async () => {
    const home = makeHome("notwsl");
    const lines: string[] = [];
    await maybeAutoLink({ CLIMON_HOME: home }, root, (t) => lines.push(t), {
      isWsl: () => false,
      detectWindowsClimonHome: () => makeHome("p")
    });
    expect(lines).toEqual([]);
  });

  test("stays silent when already linked", async () => {
    const home = makeHome("linked");
    writeFileSync(join(home, "config.json"), JSON.stringify({ remote: { peerHome: "/mnt/c/x" } }));
    const lines: string[] = [];
    await maybeAutoLink({ CLIMON_HOME: home }, root, (t) => lines.push(t), {
      isWsl: () => true,
      detectWindowsClimonHome: () => makeHome("p")
    });
    expect(lines).toEqual([]);
  });

  test("stays silent when auto-link is disabled", async () => {
    const home = makeHome("disabled");
    writeFileSync(join(home, "config.json"), JSON.stringify({ remote: { autoLink: false } }));
    const lines: string[] = [];
    await maybeAutoLink({ CLIMON_HOME: home }, root, (t) => lines.push(t), {
      isWsl: () => true,
      detectWindowsClimonHome: () => makeHome("p")
    });
    expect(lines).toEqual([]);
  });
});
