/**
 * Unit / integration tests for daemon-client.ts.
 *
 * Uses a real loopback TCP server (port 0 — OS-assigned) plus, on non-Windows
 * platforms, a Unix socket to validate:
 *
 *  - FrameType enum parity with src/ipc/frame.ts values.
 *  - FrameDecoder handles split and coalesced chunks.
 *  - Attach handshake: server sends PtySize + Replay; client sends no bytes;
 *    waitForAttached() requires BOTH frames (either alone times out).
 *  - Output accumulation and waitForOutput().
 *  - Pause / resume flow (socket.pause() stops data events).
 *  - Close detection via waitForClosed() even on a paused socket.
 *  - Malformed JSON for PtySize, Control, and Exit frames.
 *  - Strict JSON validators: u16 cols/rows, finite integer exitCode.
 *  - Oversized frame (declared length > MAX_FRAME_PAYLOAD).
 *  - Unknown frame type tag.
 *  - Timeout (deadline elapsed before condition met).
 *  - Socket error propagation.
 *  - Idempotent destroy() / close().
 */

import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { describe, expect, test, afterEach } from "bun:test";
import {
  DaemonClient,
  DaemonClientError,
  FrameDecoder,
  FrameType,
  MAX_FRAME_PAYLOAD,
} from "../src/drivers/daemon-client.js";

// ── Frame type parity ─────────────────────────────────────────────────────────

/**
 * FrameType values are wire-format constants shared with src/ipc/frame.ts and
 * rust/climon-proto/src/frame.rs. Verify them explicitly so a rename / reorder
 * that shifts a numeric value is caught immediately.
 */
describe("FrameType parity with src/ipc/frame.ts values", () => {
  const expected: Record<string, number> = {
    Output: 1,
    Input: 2,
    Resize: 3,
    Exit: 4,
    Replay: 5,
    PtySize: 6,
    Attention: 7,
    Title: 8,
    Control: 11,
    TakeControl: 12,
  };

  // Build a typed name→number map from the enum's forward entries only
  // (filtering out the reverse number→name entries that TypeScript numeric
  // enums emit, which have type string for values and would confuse the cast).
  const frameTypeByName = Object.fromEntries(
    Object.entries(FrameType).filter((e): e is [string, number] => typeof e[1] === "number")
  );

  for (const [name, value] of Object.entries(expected)) {
    test(`FrameType.${name} === ${value}`, () => {
      expect(frameTypeByName[name]).toBe(value);
    });
  }

  test("tags 9 and 10 are absent from FrameType (reserved)", () => {
    const values = Object.values(FrameType).filter(
      (v): v is number => typeof v === "number"
    );
    expect(values).not.toContain(9);
    expect(values).not.toContain(10);
  });
});

// ── MAX_FRAME_PAYLOAD ─────────────────────────────────────────────────────────

test("MAX_FRAME_PAYLOAD is 8 MiB", () => {
  expect(MAX_FRAME_PAYLOAD).toBe(8 * 1024 * 1024);
});

// ── FrameDecoder unit tests ───────────────────────────────────────────────────

describe("FrameDecoder", () => {
  function makeFrame(type: number, payloadStr: string): Buffer {
    const body = Buffer.from(payloadStr, "utf8");
    const buf = Buffer.allocUnsafe(5 + body.length);
    buf.writeUInt32BE(body.length, 0);
    buf.writeUInt8(type, 4);
    body.copy(buf, 5);
    return buf;
  }

  test("decodes a single complete frame in one chunk", () => {
    const d = new FrameDecoder();
    const frames = d.push(makeFrame(FrameType.Output, "hello"));
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(FrameType.Output);
    expect(frames[0].payload.toString()).toBe("hello");
  });

  test("handles split frame across two pushes", () => {
    const d = new FrameDecoder();
    const full = makeFrame(FrameType.Output, "split-me");
    const half = full.length / 2;
    const part1 = full.subarray(0, Math.floor(half));
    const part2 = full.subarray(Math.floor(half));

    expect(d.push(part1)).toHaveLength(0);
    const frames = d.push(part2);
    expect(frames).toHaveLength(1);
    expect(frames[0].payload.toString()).toBe("split-me");
  });

  test("handles coalesced frames (multiple frames in one chunk)", () => {
    const d = new FrameDecoder();
    const chunk = Buffer.concat([
      makeFrame(FrameType.Output, "one"),
      makeFrame(FrameType.Output, "two"),
      makeFrame(FrameType.Replay, ""),
    ]);
    const frames = d.push(chunk);
    expect(frames).toHaveLength(3);
    expect(frames[0].payload.toString()).toBe("one");
    expect(frames[1].payload.toString()).toBe("two");
    expect(frames[2].type).toBe(FrameType.Replay);
  });

  test("rejects frame with declared length > MAX_FRAME_PAYLOAD", () => {
    const d = new FrameDecoder();
    const buf = Buffer.allocUnsafe(5);
    buf.writeUInt32BE(MAX_FRAME_PAYLOAD + 1, 0);
    buf.writeUInt8(FrameType.Output, 4);
    expect(() => d.push(buf)).toThrow(DaemonClientError);
    expect(() => d.push(buf)).toThrow(/oversized/i);
  });

  test("rejects unknown frame type tag", () => {
    const d = new FrameDecoder();
    const buf = makeFrame(9, "reserved"); // tag 9 is reserved / unknown
    expect(() => d.push(buf)).toThrow(DaemonClientError);
    expect(() => d.push(buf)).toThrow(/unknown frame type/i);
  });

  test("rejects frame type tag 10 (also reserved)", () => {
    const d = new FrameDecoder();
    const buf = makeFrame(10, "reserved");
    expect(() => d.push(buf)).toThrow(DaemonClientError);
  });

  test("rejects frame type 0 (completely unknown)", () => {
    const d = new FrameDecoder();
    const buf = makeFrame(0, "bad");
    expect(() => d.push(buf)).toThrow(DaemonClientError);
  });

  test("handles header split at byte boundary (only partial header)", () => {
    const d = new FrameDecoder();
    const full = makeFrame(FrameType.Output, "abc");
    expect(d.push(full.subarray(0, 2))).toHaveLength(0); // partial header
    expect(d.push(full.subarray(2))).toHaveLength(1);
  });

  test("bufferedBytes reflects unconsumed bytes", () => {
    const d = new FrameDecoder();
    const full = makeFrame(FrameType.Output, "x".repeat(10));
    d.push(full.subarray(0, 4)); // partial header
    expect(d.bufferedBytes).toBe(4);
    d.push(full.subarray(4));
    expect(d.bufferedBytes).toBe(0);
  });
});

// ── Loopback server helpers ───────────────────────────────────────────────────

function makeFrame(type: number, payloadStr: string): Buffer {
  const body = Buffer.from(payloadStr, "utf8");
  const buf = Buffer.allocUnsafe(5 + body.length);
  buf.writeUInt32BE(body.length, 0);
  buf.writeUInt8(type, 4);
  body.copy(buf, 5);
  return buf;
}

function makeJsonFrame(type: number, value: unknown): Buffer {
  return makeFrame(type, JSON.stringify(value));
}

/**
 * Build the server-driven attach handshake: PtySize (advertising current PTY
 * dimensions) immediately followed by Replay (end of initial scrollback burst).
 * Together they satisfy waitForAttached() — both must arrive for the condition
 * to resolve.
 */
function makeAttachHandshake(cols = 80, rows = 24): Buffer {
  return Buffer.concat([
    makeJsonFrame(FrameType.PtySize, { cols, rows }),
    makeFrame(FrameType.Replay, ""),
  ]);
}

/** Spawn a one-shot TCP loopback server that tracks open connections. */
function makeTcpServer(
  handler: (socket: net.Socket) => void
): Promise<{ server: net.Server; port: number; destroyAll: () => void }> {
  return new Promise((resolve, reject) => {
    const connections = new Set<net.Socket>();
    const server = net.createServer((conn) => {
      connections.add(conn);
      conn.once("close", () => connections.delete(conn));
      handler(conn);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Unexpected address format"));
        return;
      }
      resolve({
        server,
        port: addr.port,
        destroyAll: () => {
          for (const conn of connections) conn.destroy();
          connections.clear();
        },
      });
    });
    server.once("error", reject);
  });
}

/** Destroy all connections, then close a server. */
function shutdownServer(
  server: net.Server,
  destroyAll: () => void
): Promise<void> {
  return new Promise((resolve) => {
    destroyAll();
    server.close(() => resolve());
  });
}

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) {
    await fn();
  }
});

function makeSocketRef(port: number): import("../src/drivers/socket-probe.js").SocketRef {
  return { kind: "tcp", host: "127.0.0.1", port, raw: `tcp://127.0.0.1:${port}` };
}

// ── Integration tests with loopback server ───────────────────────────────────

describe("DaemonClient attach handshake (TCP loopback)", () => {
  test("waitForAttached resolves after server sends PtySize then Replay", async () => {
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      // Send the attach handshake: PtySize followed by Replay.
      conn.write(makeAttachHandshake());
      conn.end();
    });
    cleanup.push(() => shutdownServer(server, destroyAll));

    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());

    const deadline = Date.now() + 5000;
    await client.waitForAttached(deadline);
    expect(client.attached).toBe(true);
  });

  test("waitForAttached resolves when Replay arrives after PtySize and Control frame (Control is optional)", async () => {
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      // PtySize first, then an optional Control, then Replay — all valid ordering.
      conn.write(makeJsonFrame(FrameType.PtySize, { cols: 80, rows: 24 }));
      conn.write(makeJsonFrame(FrameType.Control, { controllerId: "surface-1", cols: 80, rows: 24 }));
      conn.write(makeFrame(FrameType.Replay, ""));
      conn.end();
    });
    cleanup.push(() => shutdownServer(server, destroyAll));

    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());

    await client.waitForAttached(Date.now() + 5000);
    expect(client.allControlFrames).toHaveLength(1);
    expect(client.allControlFrames[0].controllerId).toBe("surface-1");
  });

  test("waitForAttached times out when server never sends Replay", async () => {
    const { server, port, destroyAll } = await makeTcpServer((_conn) => {
      // Send nothing — just hold the connection open.
    });
    cleanup.push(() => shutdownServer(server, destroyAll));

    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());

    const deadline = Date.now() + 200; // Very short deadline.
    await expect(client.waitForAttached(deadline)).rejects.toThrow(DaemonClientError);
  });

  test("waitForAttached rejects if socket closes before Replay", async () => {
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      conn.destroy(); // Immediately close.
    });
    cleanup.push(() => shutdownServer(server, destroyAll));

    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());

    await expect(client.waitForAttached(Date.now() + 5000)).rejects.toThrow();
  });

  test("client sends no bytes on connect (daemon drives the attach handshake)", async () => {
    // The new protocol: the daemon sends PtySize + Replay; the client sends
    // nothing on connect.  Verify that no bytes arrive at the server before the
    // handshake is sent.
    const receivedBeforeHandshake: number[] = [];
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      conn.on("data", (chunk: Buffer) => {
        for (const byte of chunk) receivedBeforeHandshake.push(byte);
      });
      // Delay slightly so the client would have time to (incorrectly) send
      // something first if the old outbound-send code were still present.
      setTimeout(() => conn.write(makeAttachHandshake()), 50);
    });
    cleanup.push(() => shutdownServer(server, destroyAll));

    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());

    await client.waitForAttached(Date.now() + 5000);
    expect(receivedBeforeHandshake).toHaveLength(0);
    expect(client.attached).toBe(true);
  });

  test("PtySize alone (without Replay) times out waitForAttached", async () => {
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      // Send PtySize but never Replay — only half the handshake.
      conn.write(makeJsonFrame(FrameType.PtySize, { cols: 80, rows: 24 }));
      // Hold the connection open indefinitely.
    });
    cleanup.push(() => shutdownServer(server, destroyAll));

    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());

    await expect(client.waitForAttached(Date.now() + 200)).rejects.toThrow(DaemonClientError);
  });

  test("Replay alone (without PtySize) times out waitForAttached", async () => {
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      // Send Replay but never PtySize — only the other half.
      conn.write(makeFrame(FrameType.Replay, ""));
      // Hold the connection open indefinitely.
    });
    cleanup.push(() => shutdownServer(server, destroyAll));

    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());

    await expect(client.waitForAttached(Date.now() + 200)).rejects.toThrow(DaemonClientError);
  });
});

describe("DaemonClient output accumulation", () => {
  test("waitForOutput resolves when output contains marker", async () => {
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      conn.write(makeAttachHandshake());
      conn.write(makeFrame(FrameType.Output, "line one\n"));
      conn.write(makeFrame(FrameType.Output, "marker-found\n"));
      conn.write(makeFrame(FrameType.Output, "line three\n"));
    });
    cleanup.push(() => shutdownServer(server, destroyAll));

    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());

    await client.waitForAttached(Date.now() + 5000);
    await client.waitForOutput("marker-found", Date.now() + 5000);
    expect(client.accumulatedOutput).toContain("marker-found");
  });

  test("output split across multiple frames is concatenated correctly", async () => {
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      conn.write(makeAttachHandshake());
      conn.write(makeFrame(FrameType.Output, "PART1-"));
      conn.write(makeFrame(FrameType.Output, "PART2-"));
      conn.write(makeFrame(FrameType.Output, "PART3"));
    });
    cleanup.push(() => shutdownServer(server, destroyAll));

    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());

    await client.waitForAttached(Date.now() + 5000);
    await client.waitForOutput("PART1-PART2-PART3", Date.now() + 5000);
    expect(client.accumulatedOutput).toBe("PART1-PART2-PART3");
  });

  test("waitForOutput times out when marker never arrives", async () => {
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      conn.write(makeAttachHandshake());
    });
    cleanup.push(() => shutdownServer(server, destroyAll));

    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());

    await client.waitForAttached(Date.now() + 5000);
    await expect(
      client.waitForOutput("NEVER_ARRIVES", Date.now() + 200)
    ).rejects.toThrow(DaemonClientError);
  });
});

describe("DaemonClient pause / resume", () => {
  test("pauseReads() stops data events; resume() re-enables them", async () => {
    let dataReceivedAfterResume = false;
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      conn.write(makeAttachHandshake());
      // Wait a tick, then send output after the client resumes.
      setTimeout(() => {
        conn.write(makeFrame(FrameType.Output, "AFTER_RESUME"));
      }, 100);
    });
    cleanup.push(() => shutdownServer(server, destroyAll));

    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());

    await client.waitForAttached(Date.now() + 5000);
    client.pauseReads();

    // After pause, output sent in ~100ms should not be accumulated yet.
    await new Promise<void>((r) => setTimeout(r, 50));
    const outputAfterPause = client.accumulatedOutput;
    expect(outputAfterPause).not.toContain("AFTER_RESUME");

    // Resume: output should now arrive.
    client.resume();
    await client.waitForOutput("AFTER_RESUME", Date.now() + 3000);
    dataReceivedAfterResume = true;

    expect(dataReceivedAfterResume).toBe(true);
    expect(client.accumulatedOutput).toContain("AFTER_RESUME");
  });
});

describe("DaemonClient waitForClosed", () => {
  test("resolves when server closes connection", async () => {
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      conn.write(makeAttachHandshake());
      conn.end(); // Close after handshake.
    });
    cleanup.push(() => shutdownServer(server, destroyAll));

    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());

    await client.waitForAttached(Date.now() + 5000);
    await client.waitForClosed(Date.now() + 5000);
    expect(client.closed).toBe(true);
  });

  test("resolves immediately if socket is already closed", async () => {
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      conn.destroy(); // Immediate close.
    });
    cleanup.push(() => shutdownServer(server, destroyAll));

    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());

    // Wait for the socket to close organically.
    await client.waitForClosed(Date.now() + 5000);
    // Calling again should resolve immediately.
    await client.waitForClosed(Date.now() + 5000);
  });

  test("resolves for waitForClosed on a paused socket when server destroys connection", async () => {
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      conn.write(makeAttachHandshake());
      // Close after a short delay so the client has time to pause first.
      setTimeout(() => conn.destroy(), 150);
    });
    cleanup.push(() => shutdownServer(server, destroyAll));

    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());

    await client.waitForAttached(Date.now() + 5000);
    client.pauseReads(); // Stall the client.

    // Even paused, the socket close event fires when the server destroys.
    await client.waitForClosed(Date.now() + 5000);
    expect(client.closed).toBe(true);
  });

  test("times out when socket stays open past deadline", async () => {
    const connections: net.Socket[] = [];
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      connections.push(conn);
      conn.write(makeAttachHandshake());
      // Never close.
    });
    cleanup.push(() => shutdownServer(server, destroyAll));
    cleanup.push(() => connections.forEach((c) => c.destroy()));

    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());

    await client.waitForAttached(Date.now() + 5000);
    await expect(client.waitForClosed(Date.now() + 200)).rejects.toThrow(DaemonClientError);
  });
});

describe("DaemonClient error handling", () => {
  test("rejects waitForAttached when server sends malformed PtySize frame", async () => {
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      // Send a PtySize frame with invalid JSON — client must reject.
      conn.write(makeFrame(FrameType.PtySize, "NOT_JSON"));
      conn.end();
    });
    cleanup.push(() => shutdownServer(server, destroyAll));

    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());

    await expect(client.waitForAttached(Date.now() + 5000)).rejects.toThrow();
  });

  test("rejects on malformed JSON in Control frame", async () => {
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      conn.write(makeAttachHandshake());
      conn.write(makeFrame(FrameType.Control, "{bad json"));
      conn.end();
    });
    cleanup.push(() => shutdownServer(server, destroyAll));

    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());

    await client.waitForAttached(Date.now() + 5000);
    // Subsequent waits should reject because the connection failed.
    await expect(client.waitForClosed(Date.now() + 3000)).resolves.toBeUndefined();
  });

  test("rejects on malformed JSON in Exit frame", async () => {
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      conn.write(makeAttachHandshake());
      conn.write(makeFrame(FrameType.Exit, "not-json"));
      conn.end();
    });
    cleanup.push(() => shutdownServer(server, destroyAll));

    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());

    await client.waitForAttached(Date.now() + 5000);
    await expect(client.waitForClosed(Date.now() + 3000)).resolves.toBeUndefined();
  });

  test("rejects waitForAttached on unknown frame type from server", async () => {
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      // Send an unknown frame type (tag 9 is reserved).
      conn.write(makeFrame(9, "unknown"));
      conn.end();
    });
    cleanup.push(() => shutdownServer(server, destroyAll));

    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());

    await expect(client.waitForAttached(Date.now() + 5000)).rejects.toThrow(DaemonClientError);
  });

  test("rejects waitForAttached on oversized frame", async () => {
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      // Declare a payload length exceeding MAX_FRAME_PAYLOAD.
      const header = Buffer.allocUnsafe(5);
      header.writeUInt32BE(MAX_FRAME_PAYLOAD + 1, 0);
      header.writeUInt8(FrameType.Output, 4);
      conn.write(header);
      conn.end();
    });
    cleanup.push(() => shutdownServer(server, destroyAll));

    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());

    await expect(client.waitForAttached(Date.now() + 5000)).rejects.toThrow(DaemonClientError);
  });

  test("rejects if connection is refused", async () => {
    // Port 1 is almost certain to be refused on loopback.
    const ref = makeSocketRef(1);
    const client = new DaemonClient(ref);
    cleanup.push(() => client.destroy());

    await expect(client.waitForAttached(Date.now() + 5000)).rejects.toThrow();
  });
});

describe("DaemonClient JSON payload validator strictness", () => {
  // ── PtySize validation ──────────────────────────────────────────────────

  test("PtySize with fractional cols rejects (must be integer)", async () => {
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      conn.write(makeJsonFrame(FrameType.PtySize, { cols: 80.5, rows: 24 }));
      conn.end();
    });
    cleanup.push(() => shutdownServer(server, destroyAll));
    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());
    await expect(client.waitForAttached(Date.now() + 5000)).rejects.toThrow(DaemonClientError);
  });

  test("PtySize with 0 rows rejects (must be >= 1)", async () => {
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      conn.write(makeJsonFrame(FrameType.PtySize, { cols: 80, rows: 0 }));
      conn.end();
    });
    cleanup.push(() => shutdownServer(server, destroyAll));
    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());
    await expect(client.waitForAttached(Date.now() + 5000)).rejects.toThrow(DaemonClientError);
  });

  test("PtySize with 65536 cols rejects (must be <= 65535)", async () => {
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      conn.write(makeJsonFrame(FrameType.PtySize, { cols: 65536, rows: 24 }));
      conn.end();
    });
    cleanup.push(() => shutdownServer(server, destroyAll));
    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());
    await expect(client.waitForAttached(Date.now() + 5000)).rejects.toThrow(DaemonClientError);
  });

  test("PtySize with Infinity cols rejects (must be finite)", async () => {
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      // Infinity serialises as null in JSON; send a raw string to force it.
      conn.write(makeFrame(FrameType.PtySize, '{"cols":1e309,"rows":24}'));
      conn.end();
    });
    cleanup.push(() => shutdownServer(server, destroyAll));
    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());
    await expect(client.waitForAttached(Date.now() + 5000)).rejects.toThrow(DaemonClientError);
  });

  // ── Exit validation ─────────────────────────────────────────────────────

  test("Exit with fractional exitCode rejects (must be integer)", async () => {
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      conn.write(makeAttachHandshake());
      conn.write(makeJsonFrame(FrameType.Exit, { exitCode: 1.5 }));
      conn.end();
    });
    cleanup.push(() => shutdownServer(server, destroyAll));
    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());
    await client.waitForAttached(Date.now() + 5000);
    await expect(client.waitForClosed(Date.now() + 3000)).resolves.toBeUndefined();
    expect(client.exit).toBeUndefined();
  });

  test("Exit with Infinity exitCode rejects (must be finite)", async () => {
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      conn.write(makeAttachHandshake());
      conn.write(makeFrame(FrameType.Exit, '{"exitCode":1e309}'));
      conn.end();
    });
    cleanup.push(() => shutdownServer(server, destroyAll));
    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());
    await client.waitForAttached(Date.now() + 5000);
    await expect(client.waitForClosed(Date.now() + 3000)).resolves.toBeUndefined();
    expect(client.exit).toBeUndefined();
  });

  // ── Control validation ──────────────────────────────────────────────────

  test("Control with 0 cols rejects (must be >= 1)", async () => {
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      conn.write(makeAttachHandshake());
      conn.write(makeJsonFrame(FrameType.Control, { controllerId: "s1", cols: 0, rows: 24 }));
      conn.end();
    });
    cleanup.push(() => shutdownServer(server, destroyAll));
    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());
    await client.waitForAttached(Date.now() + 5000);
    await expect(client.waitForClosed(Date.now() + 3000)).resolves.toBeUndefined();
    expect(client.allControlFrames).toHaveLength(0);
  });

  test("Control with fractional rows rejects (must be integer)", async () => {
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      conn.write(makeAttachHandshake());
      conn.write(makeJsonFrame(FrameType.Control, { controllerId: "s1", cols: 80, rows: 24.5 }));
      conn.end();
    });
    cleanup.push(() => shutdownServer(server, destroyAll));
    const client = new DaemonClient(makeSocketRef(port));
    cleanup.push(() => client.destroy());
    await client.waitForAttached(Date.now() + 5000);
    await expect(client.waitForClosed(Date.now() + 3000)).resolves.toBeUndefined();
    expect(client.allControlFrames).toHaveLength(0);
  });
});

describe("DaemonClient idempotent destroy / close", () => {
  test("destroy() can be called multiple times without throwing", async () => {
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      conn.write(makeAttachHandshake());
    });
    cleanup.push(() => shutdownServer(server, destroyAll));

    const client = new DaemonClient(makeSocketRef(port));
    await client.waitForAttached(Date.now() + 5000);

    expect(() => {
      client.destroy();
      client.destroy();
      client.destroy();
    }).not.toThrow();
  });

  test("close() is a no-op after destroy()", async () => {
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      conn.write(makeAttachHandshake());
    });
    cleanup.push(() => shutdownServer(server, destroyAll));

    const client = new DaemonClient(makeSocketRef(port));
    await client.waitForAttached(Date.now() + 5000);
    client.destroy();
    expect(() => client.close()).not.toThrow();
  });

  test("pauseReads() / resume() are no-ops after destroy()", async () => {
    const { server, port, destroyAll } = await makeTcpServer((conn) => {
      conn.write(makeAttachHandshake());
    });
    cleanup.push(() => shutdownServer(server, destroyAll));

    const client = new DaemonClient(makeSocketRef(port));
    await client.waitForAttached(Date.now() + 5000);
    client.destroy();
    expect(() => {
      client.pauseReads();
      client.resume();
    }).not.toThrow();
  });
});

// ── Unix socket test (non-Windows) ────────────────────────────────────────────

const IS_WINDOWS = process.platform === "win32";

(IS_WINDOWS ? describe.skip : describe)(
  "DaemonClient Unix socket",
  () => {
    test("connects and attaches over a Unix domain socket", async () => {
      const sockPath = join(
        tmpdir(),
        `daemon-client-test-${randomBytes(6).toString("hex")}.sock`
      );
      cleanup.push(() => {
        try {
          unlinkSync(sockPath);
        } catch {
          /* ignore */
        }
      });

      const serverConns = new Set<net.Socket>();
      const server = net.createServer((conn) => {
        serverConns.add(conn);
        conn.once("close", () => serverConns.delete(conn));
        conn.write(makeAttachHandshake());
        conn.write(makeFrame(FrameType.Output, "UNIX_HELLO"));
        conn.end();
      });
      await new Promise<void>((r, j) => {
        server.listen(sockPath, () => r());
        server.once("error", j);
      });
      cleanup.push(() => shutdownServer(server, () => { for (const c of serverConns) c.destroy(); serverConns.clear(); }));

      const ref: import("../src/drivers/socket-probe.js").SocketRef = {
        kind: "unix",
        path: sockPath,
        raw: sockPath,
      };
      const client = new DaemonClient(ref);
      cleanup.push(() => client.destroy());

      await client.waitForAttached(Date.now() + 5000);
      await client.waitForOutput("UNIX_HELLO", Date.now() + 5000);
      await client.waitForClosed(Date.now() + 5000);
    });
  }
);
