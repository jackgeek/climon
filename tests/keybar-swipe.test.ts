import { describe, expect, test } from "bun:test";
import { isKeyBarRevealSwipe, type KeyBarSwipeStart } from "../src/web/App.js";

function start(overrides: Partial<KeyBarSwipeStart> = {}): KeyBarSwipeStart {
  return { x: 660, y: 200, fromRightEdge: true, ...overrides };
}

describe("isKeyBarRevealSwipe", () => {
  test("opens on a leftward right-edge swipe in portrait", () => {
    expect(isKeyBarRevealSwipe(start({ x: 360, y: 600 }), 290, 610)).toBe(true);
  });

  test("opens on a leftward right-edge swipe in landscape (wider viewport)", () => {
    expect(isKeyBarRevealSwipe(start({ x: 660, y: 200 }), 500, 230)).toBe(true);
  });

  test("recognises the swipe mid-move once the threshold is crossed", () => {
    const s = start({ x: 660, y: 200 });

    expect(isKeyBarRevealSwipe(s, 640, 205)).toBe(false);
    expect(isKeyBarRevealSwipe(s, 605, 210)).toBe(true);
  });

  test("ignores gestures that did not begin at the right edge", () => {
    expect(isKeyBarRevealSwipe(start({ fromRightEdge: false }), 400, 200)).toBe(false);
  });

  test("ignores a null start", () => {
    expect(isKeyBarRevealSwipe(null, 400, 200)).toBe(false);
  });

  test("ignores short leftward movement below the threshold", () => {
    expect(isKeyBarRevealSwipe(start({ x: 660 }), 620, 200)).toBe(false);
  });

  test("ignores a rightward swipe", () => {
    expect(isKeyBarRevealSwipe(start({ x: 660 }), 700, 200)).toBe(false);
  });

  test("rejects a mostly-vertical drag near the edge", () => {
    expect(isKeyBarRevealSwipe(start({ x: 660, y: 200 }), 610, 400)).toBe(false);
  });
});
