import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { allocateLoopbackPort, connectSessionSocket, formatSessionSocketRef, waitForSessionSocket } from "../src/session-socket.js";

describe("session sockets", () => {
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  test("formats and connects to loopback TCP refs", async () => {
    const port = await allocateLoopbackPort();
    const ref = formatSessionSocketRef("127.0.0.1", port);
    expect(ref).toBe(`tcp://127.0.0.1:${port}`);

    server = createServer((socket) => {
      socket.end();
    });
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(port, "127.0.0.1", () => resolve());
    });

    await waitForSessionSocket(ref);
    const socket = connectSessionSocket(ref);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", reject);
    });
  });
});
