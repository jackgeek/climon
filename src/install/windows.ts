import { spawnSync } from "node:child_process";
import { dlopen, FFIType, ptr } from "bun:ffi";

const kernel32Symbols = {
  ExpandEnvironmentStringsW: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
    returns: FFIType.u32
  }
} as const;

const user32Symbols = {
  SendMessageTimeoutW: {
    args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
    returns: FFIType.ptr
  }
} as const;

type FfiHandle = { symbols: Record<string, (...args: any[]) => any> };

let kernel32: FfiHandle | undefined;
let user32: FfiHandle | undefined;

function loadKernel32(): FfiHandle {
  kernel32 ??= dlopen("kernel32.dll", kernel32Symbols) as FfiHandle;
  return kernel32;
}

function loadUser32(): FfiHandle {
  user32 ??= dlopen("user32.dll", user32Symbols) as FfiHandle;
  return user32;
}

const HWND_BROADCAST = 0xffff;
const WM_SETTINGCHANGE = 0x001a;
const SMTO_ABORTIFHUNG = 0x0002;

function wide(value: string): Buffer {
  return Buffer.from(`${value}\0`, "utf16le");
}

export function expandEnvironmentString(value: string): string {
  const input = wide(value);
  const requiredChars = loadKernel32().symbols.ExpandEnvironmentStringsW(ptr(input), null, 0);
  if (requiredChars === 0) {
    throw new Error("Failed to expand Windows environment strings.");
  }

  const output = Buffer.alloc(requiredChars * 2);
  const writtenChars = loadKernel32().symbols.ExpandEnvironmentStringsW(ptr(input), ptr(output), requiredChars);
  if (writtenChars === 0 || writtenChars > requiredChars) {
    throw new Error("Failed to expand Windows environment strings.");
  }

  return output.toString("utf16le", 0, (writtenChars - 1) * 2);
}

export function getLocalAppData(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error("LOCALAPPDATA is not set.");
  }
  return localAppData;
}

export function encodeUtf16Base64(value: string): string {
  return Buffer.from(value, "utf16le").toString("base64");
}

export function decodeUtf16Base64(value: string): string {
  return Buffer.from(value.trim(), "base64").toString("utf16le");
}

export function powershellArgsForScript(script: string): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodeUtf16Base64(script)
  ];
}

export function readUserPathScript(): string {
  return [
    "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')",
    "$value = if ($null -eq $key) { '' } else { $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }",
    "if ($null -eq $value) { $value = '' }",
    "[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($value))"
  ].join("; ");
}

export function writeUserPathScript(value: string): string {
  return [
    "$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')",
    `$bytes = [Convert]::FromBase64String('${encodeUtf16Base64(value)}')`,
    "$value = [Text.Encoding]::Unicode.GetString($bytes)",
    "$key.SetValue('Path', $value, [Microsoft.Win32.RegistryValueKind]::ExpandString)"
  ].join("; ");
}

function runPowerShell(script: string, action: string): string {
  const result = spawnSync("powershell.exe", powershellArgsForScript(script), {
    encoding: "utf8",
    windowsHide: true
  });

  if (result.status !== 0) {
    const message = result.stderr.trim()
      || result.stdout.trim()
      || result.error?.message
      || "powershell.exe failed";
    throw new Error(`Failed to ${action}: ${message}`);
  }

  return result.stdout.trim();
}

export function readUserPath(): string {
  const encodedPath = runPowerShell(readUserPathScript(), "read user PATH");
  return encodedPath.length === 0 ? "" : decodeUtf16Base64(encodedPath);
}

export function writeUserPath(value: string): void {
  runPowerShell(writeUserPathScript(value), "update user PATH");
}

export function broadcastEnvironmentChange(): void {
  const environment = wide("Environment");
  loadUser32().symbols.SendMessageTimeoutW(
    HWND_BROADCAST,
    WM_SETTINGCHANGE,
    null,
    ptr(environment),
    SMTO_ABORTIFHUNG,
    5000,
    null
  );
}
