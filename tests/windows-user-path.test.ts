import { describe, expect, test } from "bun:test";
import {
  decodeUtf16Base64,
  encodeUtf16Base64,
  powershellArgsForScript,
  readUserPathScript,
  writeUserPathScript
} from "../src/install/windows.js";

describe("Windows user PATH PowerShell helpers", () => {
  test("round-trips non-ASCII PATH values through UTF-16 base64", () => {
    const value = "C:\\Tools;C:\\Users\\Zoë\\bin;C:\\工具";

    expect(decodeUtf16Base64(encodeUtf16Base64(value))).toBe(value);
  });

  test("builds an encoded PowerShell command so script text is Unicode-safe", () => {
    const args = powershellArgsForScript("[Environment]::GetEnvironmentVariable('Path', 'User')");

    expect(args).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodeUtf16Base64("[Environment]::GetEnvironmentVariable('Path', 'User')")
    ]);
  });

  test("reads user PATH via .NET and emits UTF-16 base64 instead of localized text", () => {
    const script = readUserPathScript();

    expect(script).toContain("[Environment]::GetEnvironmentVariable('Path', 'User')");
    expect(script).toContain("[Convert]::ToBase64String");
    expect(script).toContain("[Text.Encoding]::Unicode.GetBytes");
  });

  test("writes user PATH via .NET using a UTF-16 base64 payload", () => {
    const value = "C:\\Tools;C:\\Users\\Zoë\\bin;C:\\工具";
    const script = writeUserPathScript(value);

    expect(script).toContain(`[Convert]::FromBase64String('${encodeUtf16Base64(value)}')`);
    expect(script).toContain("[Text.Encoding]::Unicode.GetString");
    expect(script).toContain("[Environment]::SetEnvironmentVariable('Path', $value, 'User')");
    expect(script).not.toContain(value);
  });
});
