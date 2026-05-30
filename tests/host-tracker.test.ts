import { describe, expect, test } from "bun:test";
import { HostClientTracker } from "../src/daemon/daemon.js";

describe("HostClientTracker", () => {
  test("reports the 0->1 transition when the first host attaches", () => {
    const t = new HostClientTracker();
    const a = {};
    expect(t.markHost(a)).toBe(true); // became attached
    expect(t.attached).toBe(true);
  });

  test("does not re-fire when the same host is marked twice", () => {
    const t = new HostClientTracker();
    const a = {};
    t.markHost(a);
    expect(t.markHost(a)).toBe(false);
  });

  test("does not fire a transition for a second concurrent host", () => {
    const t = new HostClientTracker();
    t.markHost({});
    expect(t.markHost({})).toBe(false);
    expect(t.attached).toBe(true);
  });

  test("reports the 1->0 transition only when the last host leaves", () => {
    const t = new HostClientTracker();
    const a = {};
    const b = {};
    t.markHost(a);
    t.markHost(b);
    expect(t.remove(a)).toBe(false); // still attached via b
    expect(t.remove(b)).toBe(true); // now detached
    expect(t.attached).toBe(false);
  });

  test("removing an unknown socket is a no-op", () => {
    const t = new HostClientTracker();
    expect(t.remove({})).toBe(false);
  });

  test("pickHost returns a host other than the excluded socket", () => {
    const t = new HostClientTracker();
    const host = {};
    const requester = {};
    t.markHost(host);
    expect(t.pickHost(requester)).toBe(host);
    expect(t.pickHost(host)).toBeUndefined();
  });
});
