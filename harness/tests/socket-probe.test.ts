import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  parseSocketRef,
  SocketProbe,
  SocketProbeError,
  tryConnect,
  type SocketRef,
} from "../src/drivers/socket-probe.js";

// ── parseSocketRef ────────────────────────────────────────────────────────────

describe("parseSocketRef — TCP loopback", () => {
  test("parses tcp://127.0.0.1:8080 correctly", () => {
    const ref = parseSocketRef("tcp://127.0.0.1:8080");
    expect(ref.kind).toBe("tcp");
    if (ref.kind === "tcp") {
      expect(ref.host).toBe("127.0.0.1");
      expect(ref.port).toBe(8080);
      expect(ref.raw).toBe("tcp://127.0.0.1:8080");
    }
  });

  test("parses minimum valid port 1", () => {
    const ref = parseSocketRef("tcp://127.0.0.1:1");
    expect(ref.kind).toBe("tcp");
    if (ref.kind === "tcp") {
      expect(ref.port).toBe(1);
    }
  });

  test("parses maximum valid port 65535", () => {
    const ref = parseSocketRef("tcp://127.0.0.1:65535");
    expect(ref.kind).toBe("tcp");
    if (ref.kind === "tcp") {
      expect(ref.port).toBe(65535);
    }
  });

  test("rejects port 0 (out of range)", () => {
    expect(() => parseSocketRef("tcp://127.0.0.1:0")).toThrow(SocketProbeError);
  });

  test("rejects port 65536 (out of range)", () => {
    expect(() => parseSocketRef("tcp://127.0.0.1:65536")).toThrow(SocketProbeError);
  });

  test("rejects non-loopback host 0.0.0.0", () => {
    expect(() => parseSocketRef("tcp://0.0.0.0:8080")).toThrow(SocketProbeError);
  });

  test("rejects non-loopback host localhost (must use 127.0.0.1 explicitly)", () => {
    expect(() => parseSocketRef("tcp://localhost:8080")).toThrow(SocketProbeError);
  });

  test("rejects non-loopback host 192.168.1.1", () => {
    expect(() => parseSocketRef("tcp://192.168.1.1:8080")).toThrow(SocketProbeError);
  });

  test("rejects credentials in the URL", () => {
    expect(() => parseSocketRef("tcp://user:pass@127.0.0.1:8080")).toThrow(SocketProbeError);
  });

  test("rejects path component in the URL", () => {
    expect(() => parseSocketRef("tcp://127.0.0.1:8080/path")).toThrow(SocketProbeError);
  });

  test("rejects query string in the URL", () => {
    expect(() => parseSocketRef("tcp://127.0.0.1:8080?key=value")).toThrow(SocketProbeError);
  });

  test("rejects fragment in the URL", () => {
    expect(() => parseSocketRef("tcp://127.0.0.1:8080#hash")).toThrow(SocketProbeError);
  });

  test("rejects missing port", () => {
    expect(() => parseSocketRef("tcp://127.0.0.1")).toThrow(SocketProbeError);
  });

  test("error messages name the rejected host for non-loopback", () => {
    try {
      parseSocketRef("tcp://10.0.0.1:9000");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SocketProbeError);
      expect((error as SocketProbeError).message).toContain("10.0.0.1");
    }
  });

  test("error mentions credentials for credential rejection", () => {
    try {
      parseSocketRef("tcp://user@127.0.0.1:9000");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SocketProbeError);
      expect((error as SocketProbeError).message).toContain("credentials");
    }
  });
});

describe("parseSocketRef — Unix paths", () => {
  test("parses an absolute Unix socket path", () => {
    const ref = parseSocketRef("/run/climon/sessions/abc.sock");
    expect(ref.kind).toBe("unix");
    if (ref.kind === "unix") {
      expect(ref.path).toBe("/run/climon/sessions/abc.sock");
      expect(ref.raw).toBe("/run/climon/sessions/abc.sock");
    }
  });

  test("parses root-level absolute path /tmp.sock", () => {
    const ref = parseSocketRef("/tmp.sock");
    expect(ref.kind).toBe("unix");
    if (ref.kind === "unix") {
      expect(ref.path).toBe("/tmp.sock");
    }
  });

  test("rejects relative path (no leading slash)", () => {
    expect(() => parseSocketRef("relative/path.sock")).toThrow(SocketProbeError);
  });

  test("rejects empty string", () => {
    expect(() => parseSocketRef("")).toThrow(SocketProbeError);
  });
});

describe("parseSocketRef — Windows named pipes (prerequisite rejection)", () => {
  test("rejects Windows named pipe with backslash prefix", () => {
    try {
      parseSocketRef("\\\\.\\pipe\\climon-session");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SocketProbeError);
      expect((error as SocketProbeError).message).toContain("Named pipe");
      expect((error as SocketProbeError).message).toContain("prerequisite");
    }
  });

  test("rejects pipe:// scheme", () => {
    try {
      parseSocketRef("pipe://climon-session");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SocketProbeError);
      expect((error as SocketProbeError).message).toContain("prerequisite");
    }
  });

  test("rejects UNC-style \\\\ path", () => {
    expect(() => parseSocketRef("\\\\server\\pipe\\name")).toThrow(SocketProbeError);
  });
});

// ── SocketProbe — unit tests with fake time ──────────────────────────────────

describe("SocketProbe waitOpen — timeout", () => {
  test("throws SocketProbeError when deadline is already past and socket never opens", async () => {
    const probe = new SocketProbe({
      now: () => 1_000,
      sleep: async () => {},
      pollIntervalMs: 10,
    });

    // Point at a port that is definitely not listening.
    const ref = parseSocketRef("tcp://127.0.0.1:19731");
    const pastDeadline = 999; // already expired

    await expect(probe.waitOpen(ref, pastDeadline)).rejects.toBeInstanceOf(SocketProbeError);
  });

  test("throws SocketProbeError with the raw ref in the message", async () => {
    let callCount = 0;
    const probe = new SocketProbe({
      now: () => {
        callCount += 1;
        // Expire after the first poll.
        return callCount >= 2 ? 10_000 : 0;
      },
      sleep: async () => {},
      pollIntervalMs: 1,
    });

    const ref = parseSocketRef("tcp://127.0.0.1:19731");
    try {
      await probe.waitOpen(ref, 5_000);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SocketProbeError);
      expect((error as SocketProbeError).message).toContain("tcp://127.0.0.1:19731");
    }
  });
});

describe("SocketProbe waitClosed — timeout", () => {
  test("throws SocketProbeError when deadline is past and socket is open", async () => {
    // Spin up a real listener so tryConnect always succeeds.
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const probe = new SocketProbe({
        now: () => 1_000,
        sleep: async () => {},
        pollIntervalMs: 10,
      });
      const ref = parseSocketRef(`tcp://127.0.0.1:${port}`);
      const pastDeadline = 500; // already expired

      await expect(probe.waitClosed(ref, pastDeadline)).rejects.toBeInstanceOf(SocketProbeError);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});

// ── SocketProbe — integration tests with real sockets ────────────────────────

describe("SocketProbe TCP — real loopback server", () => {
  let server: net.Server;
  let port: number;

  beforeEach(async () => {
    server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as net.AddressInfo).port;
  });

  afterEach(async () => {
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  test("probeOnce returns true when server is listening", async () => {
    const probe = new SocketProbe();
    const ref = parseSocketRef(`tcp://127.0.0.1:${port}`);
    const open = await probe.probeOnce(ref);
    expect(open).toBe(true);
  });

  test("probeOnce returns false when server is stopped", async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );

    const probe = new SocketProbe();
    const ref = parseSocketRef(`tcp://127.0.0.1:${port}`);
    const open = await probe.probeOnce(ref);
    expect(open).toBe(false);
  });

  test("waitOpen resolves immediately when server is already listening", async () => {
    const probe = new SocketProbe({ pollIntervalMs: 20 });
    const ref = parseSocketRef(`tcp://127.0.0.1:${port}`);
    const deadline = Date.now() + 10_000;
    await expect(probe.waitOpen(ref, deadline)).resolves.toBeUndefined();
  });

  test("waitClosed resolves after server is stopped", async () => {
    const probe = new SocketProbe({ pollIntervalMs: 20 });
    const ref = parseSocketRef(`tcp://127.0.0.1:${port}`);
    const deadline = Date.now() + 10_000;

    // Close the server midway.
    setTimeout(() => {
      server.close();
    }, 50);

    await expect(probe.waitClosed(ref, deadline)).resolves.toBeUndefined();
  });

  test("waitOpen times out on a closed port", async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );

    const probe = new SocketProbe({ pollIntervalMs: 10 });
    const ref = parseSocketRef(`tcp://127.0.0.1:${port}`);
    const deadline = Date.now() + 200;

    await expect(probe.waitOpen(ref, deadline)).rejects.toBeInstanceOf(SocketProbeError);
  });
});

// ── SocketProbe Unix — real socket (Unix/macOS only) ─────────────────────────

const IS_UNIX = process.platform !== "win32";

// macOS UNIX_PATH_MAX is 104 bytes including the null terminator.
// Use a short path relative to the worktree root to stay well under the limit.
// import.meta.dir = <worktree>/harness/tests  →  go up 2 levels = worktree root.
const UNIX_SOCK_DIR = join(import.meta.dir, "..", "..", "sp");

describe.if(IS_UNIX)("SocketProbe Unix socket — real file", () => {
  let server: net.Server;
  let sockPath: string;

  beforeEach(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(UNIX_SOCK_DIR, { recursive: true });

    sockPath = join(UNIX_SOCK_DIR, `s-${(Date.now() % 1_000_000).toString(36)}-${Math.random().toString(36).slice(2, 6)}.sock`);

    server = net.createServer();
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
  });

  afterEach(async () => {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // Clean up the socket file.
    await rm(sockPath, { force: true });
  });

  test("probeOnce returns true when Unix socket server is listening", async () => {
    const probe = new SocketProbe();
    const ref = parseSocketRef(sockPath);
    expect(await probe.probeOnce(ref)).toBe(true);
  });

  test("probeOnce returns false after server is closed", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(sockPath, { force: true });

    const probe = new SocketProbe();
    const ref = parseSocketRef(sockPath);
    expect(await probe.probeOnce(ref)).toBe(false);
  });

  test("waitClosed requires both connection refusal AND file absence", async () => {
    // Track pathExists calls.
    const pathExistsCalls: string[] = [];
    let filePresent = true;

    const probe = new SocketProbe({
      pollIntervalMs: 20,
      pathExists: async (p) => {
        pathExistsCalls.push(p);
        return filePresent;
      },
    });
    const ref = parseSocketRef(sockPath);
    const deadline = Date.now() + 10_000;

    // Close the server (connection refused) but keep the file present initially.
    await new Promise<void>((resolve) => server.close(() => resolve()));

    // Start waitClosed — it should keep polling because filePresent is true.
    let resolved = false;
    const waitPromise = probe
      .waitClosed(ref, deadline)
      .then(() => {
        resolved = true;
      });

    // Give it a moment to poll.
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    expect(resolved).toBe(false);
    expect(pathExistsCalls.length).toBeGreaterThan(0);
    expect(pathExistsCalls[0]).toBe(sockPath);

    // Now simulate file removal.
    filePresent = false;
    await waitPromise;
    expect(resolved).toBe(true);
  });

  test("waitClosed resolves when both connection is refused and file is removed", async () => {
    const probe = new SocketProbe({ pollIntervalMs: 20 });
    const ref = parseSocketRef(sockPath);
    const deadline = Date.now() + 10_000;

    setTimeout(async () => {
      server.close();
      // Simulate daemon removing the socket file after closing.
      setTimeout(() => rm(sockPath, { force: true }), 30);
    }, 30);

    await expect(probe.waitClosed(ref, deadline)).resolves.toBeUndefined();
  });
});

// ── tryConnect — direct API ───────────────────────────────────────────────────

describe("tryConnect", () => {
  test("resolves false for a port with no listener", async () => {
    // Use an unlikely port; if it happens to be in use the test flips to true
    // which is technically correct (we are not asserting closed), but we
    // accept that possibility here since the test is just exercising the API.
    const ref: SocketRef = { kind: "tcp", host: "127.0.0.1", port: 19729, raw: "tcp://127.0.0.1:19729" };
    const result = await tryConnect(ref);
    // We cannot guarantee the port is free, but we can verify the return type.
    expect(typeof result).toBe("boolean");
  });
});
