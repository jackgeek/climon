import { test, expect } from "bun:test";
import { routeRemoteSpawn } from "../src/server/server.js";

const parent = { id: "dev~p1", origin: "remote", cwd: "/devbox/home", cols: 100, rows: 30, priority: 500 } as never;

test("returns 201 with namespaced id on success", async () => {
  const res = await routeRemoteSpawn(
    parent,
    { argv: ["bash"], cwd: "/devbox/home", headless: true, name: undefined, priority: undefined, color: undefined },
    async () => ({ type: "spawn-result", requestId: "x", id: "child9", warning: "no terminal" })
  );
  expect(res.status).toBe(201);
  expect(res.body).toEqual({ id: "dev~child9", warning: "no terminal" });
});

test("returns 202 on timeout", async () => {
  const res = await routeRemoteSpawn(
    parent,
    { argv: ["bash"], cwd: "/devbox/home", headless: false, name: undefined, priority: undefined, color: undefined },
    async () => ({ type: "spawn-result", requestId: "x", error: "timeout" })
  );
  expect(res.status).toBe(202);
});

test("returns 502 on other errors", async () => {
  const res = await routeRemoteSpawn(
    parent,
    { argv: ["bash"], cwd: "/devbox/home", headless: true, name: undefined, priority: undefined, color: undefined },
    async () => ({ type: "spawn-result", requestId: "x", error: "client not connected" })
  );
  expect(res.status).toBe(502);
  expect(res.body).toEqual({ error: "client not connected" });
});
