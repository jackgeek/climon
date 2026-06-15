import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  unixTest(
    "delivers SIGWINCH to a nested grandchild running inside a shell",
    async () => {
      // Mirrors `climon` wrapping a shell (e.g. zsh) with a TUI such as the
      // Copilot CLI running *inside* it. The TUI is a grandchild in its own
      // process group, so signalling only the PTY's direct child never reaches
      // it. A temp script keeps the nested shell quoting sane.
      const dir = mkdtempSync(join(tmpdir(), "climon-pty-winch-"));
      const script = join(dir, "winch-child.sh");
      writeFileSync(
        script,
        "trap 'echo NESTED $(stty size)' WINCH\ni=0\nwhile [ $i -lt 40 ]; do sleep 0.1; i=$((i+1)); done\n"
      );

      const pty = spawnPty({
        // Outer shell is the PTY's direct child; the script it runs is the
        // grandchild that traps SIGWINCH.
        command: "bash",
        args: ["-lc", `bash ${script}; echo END`],
        cwd: process.cwd(),
        cols: 80,
        rows: 24
      });

      let out = "";
      pty.onData((data) => {
        out += data.toString("utf8");
      });
      const exited = new Promise<void>((resolve) => pty.onExit(() => resolve()));

      try {
        // Give the grandchild time to install its SIGWINCH trap before resizing.
        await Bun.sleep(1200);
        pty.resize(120, 40);
        await Bun.sleep(900);
        pty.kill("SIGKILL");
        await exited;

        expect(out).toContain("NESTED 40 120");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    12_000
  );
});
