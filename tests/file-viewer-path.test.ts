import { describe, expect, test } from "bun:test";
import { relativeToCwd, shouldOpenFileViewer } from "../src/web/components/FileViewer.js";
import type { FileReadResponse } from "../src/web/api.js";

describe("relativeToCwd", () => {
  test("strips the cwd prefix", () => {
    expect(relativeToCwd("/home/u/proj", "/home/u/proj/src/index.ts")).toBe("src/index.ts");
  });

  test("handles a trailing slash on cwd", () => {
    expect(relativeToCwd("/home/u/proj/", "/home/u/proj/a.ts")).toBe("a.ts");
  });

  test("returns the absolute path when it is not under cwd", () => {
    expect(relativeToCwd("/home/u/proj", "/etc/hosts")).toBe("/etc/hosts");
  });

  test("returns the path unchanged when cwd is empty", () => {
    expect(relativeToCwd("", "/home/u/proj/a.ts")).toBe("/home/u/proj/a.ts");
  });
});

describe("shouldOpenFileViewer", () => {
  test("not-found is a silent no-op (does not open)", () => {
    expect(shouldOpenFileViewer({ status: "not-found" } as FileReadResponse)).toBe(false);
  });

  test("ok and other display states open the viewer", () => {
    expect(
      shouldOpenFileViewer({ status: "ok", path: "/p/a.ts", content: "x" } as FileReadResponse)
    ).toBe(true);
    expect(shouldOpenFileViewer({ status: "binary" } as FileReadResponse)).toBe(true);
    expect(shouldOpenFileViewer({ status: "too-large" } as FileReadResponse)).toBe(true);
    expect(shouldOpenFileViewer({ status: "refused" } as FileReadResponse)).toBe(true);
    expect(shouldOpenFileViewer({ status: "error", message: "boom" } as FileReadResponse)).toBe(true);
  });
});
