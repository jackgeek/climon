import { describe, expect, test } from "bun:test";
import { spawnPty } from "../src/pty.js";

// SIGWINCH is a POSIX concept; the resize-signal behaviour only applies off Windows.
const unixTest = process.platform === "win32" ? test.skip : test;

describe("spawnPty resize", () => {
  unixTest(
    "delivers SIGWINCH so the child observes the new terminal size",
    async () => {
      // The child traps SIGWINCH and reports the kernel window size it now sees.
      // Node-based TUIs (e.g. the Copilot CLI) only refresh their cached size on
      // SIGWINCH, so without the signal they keep rendering at the old size and
      // browser viewers that resized their grid render corrupted output.
      const pty = spawnPty({
        command: "bash",
        args: [
          "-lc",
          "trap 'echo WINCH $(stty size)' WINCH; for i in $(seq 1 30); do sleep 0.1; done; echo END"
        ],
        cwd: process.cwd(),
        cols: 80,
        rows: 24
      });

      let out = "";
      pty.onData((data) => {
        out += data.toString("utf8");
      });
      const exited = new Promise<void>((resolve) => pty.onExit(() => resolve()));

      await Bun.sleep(500);
      pty.resize(120, 40);
      await Bun.sleep(700);
      pty.kill("SIGKILL");
      await exited;

      // `stty size` prints "rows cols", so the resized 120x40 grid reports "40 120".
      expect(out).toContain("WINCH 40 120");
    },
    10_000
  );
});
