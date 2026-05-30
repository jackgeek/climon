import { describe, expect, test } from "bun:test";
import { namespacedId, toLocalMeta } from "../src/remote/accept.js";
import type { SessionMeta } from "../src/types.js";

const meta = {
  id: "abc",
  command: ["npm", "test"],
  displayCommand: "npm test",
  cwd: "/home/alice/app",
  status: "running",
  priorityReason: "running",
  socketPath: "/remote/ignored.sock",
  cols: 80,
  rows: 24,
  createdAt: "t",
  updatedAt: "t",
  lastActivityAt: "t"
} as SessionMeta;

describe("accept helpers", () => {
  test("namespaces ids by client label", () => {
    expect(namespacedId("devbox-1", "abc")).toBe("devbox-1~abc");
  });

  test("toLocalMeta tags origin and rewrites id + socketPath", () => {
    const local = toLocalMeta(meta, "devbox-1", "/home/.climon/sock/devbox-1~abc.sock");
    expect(local.id).toBe("devbox-1~abc");
    expect(local.origin).toBe("remote");
    expect(local.clientLabel).toBe("devbox-1");
    expect(local.socketPath).toBe("/home/.climon/sock/devbox-1~abc.sock");
    expect(local.displayCommand).toBe("npm test");
  });
});
