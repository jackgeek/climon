import { describe, expect, test } from "bun:test";
import fixtures from "../fixtures/devtunnel/failures.json";
import { classifyDevtunnelFailure } from "../src/devtunnel/classify.js";
import type { DevtunnelFailureInput } from "../src/devtunnel/types.js";

describe("classifyDevtunnelFailure", () => {
  for (const fixture of fixtures) {
    test(fixture.name, () => {
      expect(classifyDevtunnelFailure(fixture.input as DevtunnelFailureInput)).toMatchObject(fixture.expected);
    });
  }

  test("scrubs identifiers from technicalDetail", () => {
    const failure = classifyDevtunnelFailure({
      operation: "create-tunnel",
      status: 1,
      stdout: "",
      stderr: "auth failed for user jack@example.com at https://tunnel.example.com/host"
    });
    expect(failure.technicalDetail).not.toContain("jack@example.com");
    expect(failure.technicalDetail).not.toContain("tunnel.example.com");
    expect(failure.technicalDetail).toContain("<email>");
    expect(failure.technicalDetail).toContain("<url>");
  });
});
