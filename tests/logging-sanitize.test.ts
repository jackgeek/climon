import { describe, expect, test } from "bun:test";
import { sanitizeDiagnostic } from "../src/logging/sanitize.js";

describe("sanitizeDiagnostic", () => {
  test("removes hostnames but keeps the error skeleton", () => {
    const out = sanitizeDiagnostic(
      "connection error: getaddrinfo ENOTFOUND my-box.corp.example (code=EAI_AGAIN)",
    );
    expect(out).not.toContain("my-box.corp.example");
    expect(out).toContain("getaddrinfo ENOTFOUND");
    expect(out).toContain("EAI_AGAIN");
    expect(out).toContain("<host>");
  });

  test("removes IPv4 addresses and ports", () => {
    const out = sanitizeDiagnostic("EADDRINUSE: address already in use 127.0.0.1:7420");
    expect(out).toContain("EADDRINUSE");
    expect(out).not.toContain("127.0.0.1");
    expect(out).not.toContain("7420");
    expect(out).toContain("<ip>");
  });

  test("removes POSIX absolute and home paths", () => {
    const out = sanitizeDiagnostic(
      "ENOENT: no such file or directory, open '/Users/alice/.climon/config.jsonc'",
    );
    expect(out).toContain("ENOENT");
    expect(out).not.toContain("alice");
    expect(out).not.toContain("/Users/");
    expect(out).toContain("<path>");
  });

  test("removes Windows paths", () => {
    const out = sanitizeDiagnostic("open 'C:\\Users\\bob\\AppData\\climon.log' failed");
    expect(out).not.toContain("bob");
    expect(out).not.toContain("C:\\Users");
    expect(out).toContain("<path>");
    expect(out).toContain("failed");
  });

  test("removes URLs", () => {
    const out = sanitizeDiagnostic(
      "Tunnel Link could not be re-established: fetch failed https://abc123.usw2.devtunnels.example/connect",
    );
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("devtunnels");
    expect(out).toContain("<url>");
    expect(out).toContain("fetch failed");
  });

  test("removes email addresses", () => {
    const out = sanitizeDiagnostic("push failed for bob@example.com after retry");
    expect(out).not.toContain("bob@example.com");
    expect(out).toContain("<email>");
    expect(out).toContain("after retry");
  });

  test("removes host:port targets", () => {
    const out = sanitizeDiagnostic("port host.internal.example:22 not reachable: ECONNREFUSED");
    expect(out).not.toContain("host.internal.example");
    expect(out).not.toContain(":22");
    expect(out).toContain("ECONNREFUSED");
    expect(out).toContain("<host>");
  });

  test("removes UUIDs and long hex fingerprints", () => {
    const out = sanitizeDiagnostic(
      "session 3f2504e0-4f89-41d3-9a0c-0305e82c3301 fingerprint=deadbeefcafebabe0123456789abcdef gone",
    );
    expect(out).not.toContain("3f2504e0-4f89-41d3-9a0c-0305e82c3301");
    expect(out).not.toContain("deadbeefcafebabe0123456789abcdef");
    expect(out).toContain("<id>");
    expect(out).toContain("gone");
  });

  test("preserves common diagnostic tokens: error codes, syscalls, numbers", () => {
    const out = sanitizeDiagnostic("connect ECONNREFUSED syscall=connect status=503 retries=3");
    expect(out).toBe("connect ECONNREFUSED syscall=connect status=503 retries=3");
  });

  test("truncates very long values", () => {
    const out = sanitizeDiagnostic("retrying step ".repeat(400));
    expect(out.length).toBeLessThan(400);
    expect(out).toContain("…");
  });

  test("returns non-string input unchanged as a string marker-free passthrough", () => {
    expect(sanitizeDiagnostic("")).toBe("");
  });

  describe("golden corpus: no identifier leaks", () => {
    const CORPUS = [
      "getaddrinfo ENOTFOUND my-box.corp.example",
      "connect ECONNREFUSED 10.0.0.5:8080",
      "open /home/jack/projects/secret-app/.env",
      "open C:\\Users\\jack\\Desktop\\notes.txt",
      "GET https://internal.example.com/api/v1/users/42 -> 500",
      "auth failed for jack.allan@corp.example",
      "tunnel dev-tunnel-7f3a.usw2.devtunnels.example dropped",
      "pid=1234 reason=host laptop.local unreachable",
    ];
    const FORBIDDEN = [
      "my-box.corp.example",
      "10.0.0.5",
      "/home/jack",
      "C:\\Users\\jack",
      "internal.example.com",
      "jack.allan@corp.example",
      "devtunnels.example",
      "laptop.local",
    ];
    for (const line of CORPUS) {
      test(`scrubs: ${line.slice(0, 40)}`, () => {
        const out = sanitizeDiagnostic(line);
        for (const bad of FORBIDDEN) {
          expect(out).not.toContain(bad);
        }
      });
    }
  });
});
