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

export function readUserPath(): string {
  const result = spawnSync("reg.exe", ["query", "HKCU\\Environment", "/v", "Path"], {
    encoding: "utf8",
    windowsHide: true
  });

  if (result.status !== 0) {
    return "";
  }

  const line = result.stdout
    .split(/\r?\n/)
    .find((candidate) => /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+/i.test(candidate));

  if (!line) {
    return "";
  }

  return line.replace(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+/i, "");
}

export function writeUserPath(value: string): void {
  const result = spawnSync(
    "reg.exe",
    ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", value, "/f"],
    { encoding: "utf8", windowsHide: true }
  );

  if (result.status !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || "reg.exe failed";
    throw new Error(`Failed to update user PATH: ${message}`);
  }
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
