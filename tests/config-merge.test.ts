import { describe, expect, test } from "bun:test";
import {
  applyConfigDelta,
  cloneConfigValue,
  diffConfig,
  type ConfigDelta
} from "../src/config-merge.js";

describe("config merge helpers", () => {
  function parseConfig<T>(json: string): T {
    return JSON.parse(json) as T;
  }

  test("diffConfig returns undefined when data is unchanged", () => {
    const value = {
      server: { host: "127.0.0.1", port: 3131 },
      terminal: { clampBrowserToHost: false },
      tags: ["alpha", "beta"]
    };

    expect(diffConfig(value, cloneConfigValue(value))).toBeUndefined();
  });

  test("additions and nested replacements apply without changing unrelated latest siblings", () => {
    const golden = {
      server: { host: "127.0.0.1", port: 3131 },
      terminal: { clampBrowserToHost: false }
    };
    const current = {
      server: { host: "0.0.0.0", port: 3131, lan: true },
      terminal: { clampBrowserToHost: true }
    };
    const latest = {
      server: { host: "127.0.0.1", port: 3131, token: "persist" },
      terminal: { clampBrowserToHost: false, detachPrefix: 28 }
    };

    const delta = diffConfig(golden, current);
    expect(delta).toEqual({
      kind: "object",
      entries: {
        server: {
          kind: "object",
          entries: {
            host: { kind: "replace", value: "0.0.0.0" },
            lan: { kind: "replace", value: true }
          }
        },
        terminal: {
          kind: "object",
          entries: {
            clampBrowserToHost: { kind: "replace", value: true }
          }
        }
      }
    } satisfies ConfigDelta);

    expect(applyConfigDelta(latest, delta!)).toEqual({
      server: { host: "0.0.0.0", port: 3131, token: "persist", lan: true },
      terminal: { clampBrowserToHost: true, detachPrefix: 28 }
    });
    expect(latest).toEqual({
      server: { host: "127.0.0.1", port: 3131, token: "persist" },
      terminal: { clampBrowserToHost: false, detachPrefix: 28 }
    });
  });

  test("diffConfig preserves added own __proto__ properties", () => {
    const golden = parseConfig<{
      server: { host: string };
    }>('{"server":{"host":"127.0.0.1"}}');
    const current = parseConfig<{
      server: { host: string; __proto__: { marker: string } };
    }>('{"server":{"host":"127.0.0.1","__proto__":{"marker":"added"}}}');

    const delta = diffConfig(golden, current);
    expect(delta?.kind).toBe("object");
    const serverDelta = (delta as Extract<ConfigDelta, { kind: "object" }>).entries.server as Extract<
      ConfigDelta,
      { kind: "object" }
    >;
    expect(Object.prototype.hasOwnProperty.call(serverDelta.entries, "__proto__")).toBe(true);
    expect(serverDelta.entries["__proto__"]).toEqual({
      kind: "replace",
      value: { marker: "added" }
    });
  });

  test("applyConfigDelta preserves added own __proto__ properties", () => {
    const delta = parseConfig<ConfigDelta>(
      '{"kind":"object","entries":{"server":{"kind":"object","entries":{"__proto__":{"kind":"replace","value":{"marker":"added"}}}}}}'
    );
    const latest = parseConfig<{
      server: { host: string };
    }>('{"server":{"host":"127.0.0.1"}}');

    const next = applyConfigDelta(latest, delta);
    expect(Object.prototype.hasOwnProperty.call(next.server, "__proto__")).toBe(true);
    expect(next.server["__proto__"]).toEqual({ marker: "added" });
    expect(Object.getPrototypeOf(next.server)).toBe(Object.prototype);
  });

  test("diffConfig preserves replaced own __proto__ properties", () => {
    const golden = parseConfig<{
      server: { host: string; __proto__: string };
    }>('{"server":{"host":"127.0.0.1","__proto__":"old"}}');
    const current = parseConfig<{
      server: { host: string; __proto__: string };
    }>('{"server":{"host":"127.0.0.1","__proto__":"new"}}');

    const delta = diffConfig(golden, current);
    expect(delta?.kind).toBe("object");
    const serverDelta = (delta as Extract<ConfigDelta, { kind: "object" }>).entries.server as Extract<
      ConfigDelta,
      { kind: "object" }
    >;
    expect(Object.prototype.hasOwnProperty.call(serverDelta.entries, "__proto__")).toBe(true);
    expect(serverDelta.entries["__proto__"]).toEqual({
      kind: "replace",
      value: "new"
    });
  });

  test("explicit deletion removes only the requested key and preserves unrelated latest keys", () => {
    const golden = {
      server: { host: "127.0.0.1", port: 3131, lan: true },
      feature: { remote: "enabled" }
    };
    const current = {
      server: { host: "127.0.0.1", port: 3131 },
      feature: { remote: "enabled" }
    };
    const latest = {
      server: { host: "127.0.0.1", port: 3131, lan: true, token: "keep" },
      feature: { remote: "enabled", extra: "stay" }
    };

    const delta = diffConfig(golden, current);
    expect(delta).toEqual({
      kind: "object",
      entries: {
        server: {
          kind: "object",
          entries: {
            lan: { kind: "delete" }
          }
        }
      }
    } satisfies ConfigDelta);

    expect(applyConfigDelta(latest, delta!)).toEqual({
      server: { host: "127.0.0.1", port: 3131, token: "keep" },
      feature: { remote: "enabled", extra: "stay" }
    });
  });

  test("applyConfigDelta preserves replaced own __proto__ properties", () => {
    const delta = parseConfig<ConfigDelta>(
      '{"kind":"object","entries":{"server":{"kind":"object","entries":{"__proto__":{"kind":"replace","value":{"marker":"new"}}}}}}'
    );
    const latest = parseConfig<{
      server: { host: string; token: string };
    }>('{"server":{"host":"127.0.0.1","token":"keep"}}');

    const next = applyConfigDelta(latest, delta);
    expect(Object.prototype.hasOwnProperty.call(next.server, "__proto__")).toBe(true);
    expect(next.server["__proto__"]).toEqual({ marker: "new" });
    expect(next.server.token).toBe("keep");
    expect(Object.getPrototypeOf(next.server)).toBe(Object.prototype);
  });

  test("diffConfig preserves deletion of own __proto__ properties", () => {
    const golden = parseConfig<{
      server: { host: string; __proto__: { marker: string } };
    }>('{"server":{"host":"127.0.0.1","__proto__":{"marker":"remove"}}}');
    const current = parseConfig<{
      server: { host: string };
    }>('{"server":{"host":"127.0.0.1"}}');

    const delta = diffConfig(golden, current);
    expect(delta?.kind).toBe("object");
    const serverDelta = (delta as Extract<ConfigDelta, { kind: "object" }>).entries.server as Extract<
      ConfigDelta,
      { kind: "object" }
    >;
    expect(Object.prototype.hasOwnProperty.call(serverDelta.entries, "__proto__")).toBe(true);
    expect(serverDelta.entries["__proto__"]).toEqual({ kind: "delete" });
  });

  test("arrays replace as a unit", () => {
    const golden = { tags: ["alpha", "beta"] };
    const current = { tags: ["alpha", "gamma"] };

    expect(diffConfig(golden, current)).toEqual({
      kind: "object",
      entries: {
        tags: { kind: "replace", value: ["alpha", "gamma"] }
      }
    });
  });

  test("cloneConfigValue deep-clones data", () => {
    const original = {
      server: { host: "127.0.0.1", ports: [3131, 3132] },
      tags: ["alpha", { nested: true }]
    };

    const cloned = cloneConfigValue(original);
    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
    expect(cloned.server).not.toBe(original.server);
    expect(cloned.server.ports).not.toBe(original.server.ports);
    expect(cloned.tags).not.toBe(original.tags);
    expect((cloned.tags[1] as { nested: boolean })).not.toBe(original.tags[1]);
  });
});
