import { describe, expect, test } from "bun:test";
import { addComposeEntry, MAX_COMPOSE_HISTORY } from "../src/web/composeHistory.js";

describe("addComposeEntry", () => {
  test("appends text as the newest entry", () => {
    expect(addComposeEntry([], "one")).toEqual(["one"]);
    expect(addComposeEntry(["one"], "two")).toEqual(["one", "two"]);
  });

  test("ignores empty text", () => {
    expect(addComposeEntry(["one"], "")).toEqual(["one"]);
    expect(addComposeEntry([], "")).toEqual([]);
  });

  test("de-duplicates by moving the existing copy to newest", () => {
    expect(addComposeEntry(["one", "two", "three"], "two")).toEqual([
      "one",
      "three",
      "two"
    ]);
  });

  test("does not mutate the input array", () => {
    const history = ["one"];
    addComposeEntry(history, "two");
    expect(history).toEqual(["one"]);
  });

  test("caps to MAX_COMPOSE_HISTORY, dropping oldest first", () => {
    let history: string[] = [];
    for (let i = 0; i < MAX_COMPOSE_HISTORY + 5; i++) {
      history = addComposeEntry(history, `entry-${i}`);
    }
    expect(history.length).toBe(MAX_COMPOSE_HISTORY);
    expect(history[0]).toBe("entry-5");
    expect(history[history.length - 1]).toBe(`entry-${MAX_COMPOSE_HISTORY + 4}`);
  });
});
