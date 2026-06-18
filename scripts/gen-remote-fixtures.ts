// Generates byte-exact mux framing fixtures from the Bun encoder. The Rust
// encoder must produce identical bytes (see tests/remote-fixtures.test.ts and
// rust/climon-remote/tests/fixtures.rs). Run: bun scripts/gen-remote-fixtures.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeControl, encodeData, type ControlMessage } from "../src/remote/mux.js";
import type { SessionMeta } from "../src/types.js";

// SessionMeta keys are ordered to match the Rust SessionMeta struct field
// order so JSON.stringify (insertion order) equals serde_json (struct order).
const meta = {
  id: "s1",
  command: ["bash", "-lc", "echo hi"],
  displayCommand: "bash -lc echo hi",
  cwd: "/home/dev",
  status: "running",
  priorityReason: "running",
  cols: 80,
  rows: 24,
  socketPath: "tcp://127.0.0.1:9000",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  lastActivityAt: "2026-01-01T00:00:00.000Z"
} as unknown as SessionMeta;

const controls: Record<string, ControlMessage> = {
  hello: { kind: "hello", clientId: "devbox-abc" },
  "session-added": { kind: "session-added", meta },
  "session-updated": { kind: "session-updated", id: "s1", patch: { status: "completed", priorityReason: "completed" } },
  "session-removed": { kind: "session-removed", id: "a" },
  attach: { kind: "attach", id: "s1" },
  detach: { kind: "detach", id: "s1" },
  ping: { kind: "ping" },
  pong: { kind: "pong" }
};

const frames: Record<string, string> = {};
for (const [name, msg] of Object.entries(controls)) {
  frames[`control:${name}`] = Buffer.from(encodeControl(msg)).toString("hex");
}
frames["data:sess-1"] = Buffer.from(encodeData("sess-1", Buffer.from([1, 2, 3, 4]))).toString("hex");
frames["data:empty"] = Buffer.from(encodeData("x", Buffer.from([]))).toString("hex");

const out = join(import.meta.dir, "..", "fixtures", "remote", "mux-frames.json");
writeFileSync(out, JSON.stringify(frames, null, 2) + "\n");
console.log(`wrote ${out}`);
