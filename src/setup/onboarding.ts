export type SetupOptions = {
  /** Run non-interactively (no prompts). */
  apply: boolean;
  /** Accept the EULA without prompting. */
  acceptEula: boolean;
  /** Telemetry opt-in; undefined means "leave at current/default". */
  telemetry?: boolean;
  /** Auto-update opt-in; undefined means "leave at current/default". */
  autoUpdate?: boolean;
};

function parseOnOff(flag: string, value: string): boolean {
  if (value === "on" || value === "true") return true;
  if (value === "off" || value === "false") return false;
  throw new Error(`Invalid value for ${flag}: ${value} (expected on|off)`);
}

/** Parses `climon setup` / installer flags into structured options. */
export function parseSetupOptions(args: string[]): SetupOptions {
  const options: SetupOptions = { apply: false, acceptEula: false };
  for (const arg of args) {
    if (arg === "--apply") options.apply = true;
    else if (arg === "--accept-eula") options.acceptEula = true;
    else if (arg.startsWith("--telemetry="))
      options.telemetry = parseOnOff("--telemetry", arg.slice("--telemetry=".length));
    else if (arg.startsWith("--auto-update="))
      options.autoUpdate = parseOnOff(
        "--auto-update",
        arg.slice("--auto-update=".length)
      );
  }
  return options;
}
