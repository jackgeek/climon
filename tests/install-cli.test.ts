import { describe, expect, test } from "bun:test";
import { runSetupCli } from "../src/install/index.js";

describe("runSetupCli", () => {
  test("pauses before exiting after setup fails so double-click users can read the error", async () => {
    const events: string[] = [];

    await runSetupCli({
      async main() {
        throw new Error("copy failed");
      },
      writeError(message) {
        events.push(`error:${message}`);
      },
      async pauseForExit() {
        events.push("pause");
      },
      exit(code) {
        events.push(`exit:${code}`);
      }
    });

    expect(events).toEqual([
      "error:Setup failed: copy failed",
      "pause",
      "exit:1"
    ]);
  });
});
