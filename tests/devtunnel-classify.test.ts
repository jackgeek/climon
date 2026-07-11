import { describe, expect, test } from "bun:test";
import fixtures from "../fixtures/devtunnel/failures.json";
import { classifyDevtunnelFailure } from "../src/devtunnel/classify.js";

describe("classifyDevtunnelFailure", () => {
  for (const fixture of fixtures) {
    test(fixture.name, () => {
      expect(classifyDevtunnelFailure(fixture.input)).toMatchObject(fixture.expected);
    });
  }
});
