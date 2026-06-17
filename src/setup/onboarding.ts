import { writeConfigSetting } from "../config.js";
import { ensureEulaAccepted } from "../eula/accept.js";
import { ensureInstallId } from "./install-id.js";
import { t } from "../i18n/t.js";

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

export type OnboardingIO = {
  env?: NodeJS.ProcessEnv;
  options: SetupOptions;
  print?: (s: string) => void;
  prompt?: (question: string) => Promise<string>;
};

export type OnboardingResult = { accepted: boolean };

/** Reads a yes/no answer; default is NO when the user just presses enter. */
function isYes(answer: string): boolean {
  return /^(y|yes)$/i.test(answer.trim());
}

/**
 * Runs the full onboarding flow: EULA gate, telemetry opt-in, auto-update
 * opt-in, and install-id assignment. Both opt-ins default OFF. When the EULA is
 * not accepted, no telemetry/update state is written and accepted=false.
 */
export async function runOnboarding(io: OnboardingIO): Promise<OnboardingResult> {
  const env = io.env ?? process.env;
  const print = io.print ?? ((s: string) => process.stdout.write(s));
  const prompt =
    io.prompt ??
    (async (question: string) => {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    });

  const interactive = !io.options.apply;

  const accepted = await ensureEulaAccepted({
    env,
    interactive,
    acceptEula: io.options.acceptEula,
    print,
    prompt,
  });
  if (!accepted) return { accepted: false };

  // Telemetry opt-in (default OFF). An explicit option or interactive answer is
  // persisted; a non-interactive run without the flag leaves the existing value
  // (or registered default) untouched, so re-running setup never silently
  // revokes a prior opt-in.
  let telemetry: boolean | undefined;
  if (io.options.telemetry !== undefined) telemetry = io.options.telemetry;
  else if (interactive) telemetry = isYes(await prompt(t("telemetry.prompt")));
  if (telemetry !== undefined) {
    writeConfigSetting("telemetry.enabled", String(telemetry), "global", env);
  }

  // Auto-update opt-in (default OFF). Same leave-at-current semantics as above.
  let autoUpdate: boolean | undefined;
  if (io.options.autoUpdate !== undefined) autoUpdate = io.options.autoUpdate;
  else if (interactive) autoUpdate = isYes(await prompt(t("autoUpdate.prompt")));
  if (autoUpdate !== undefined) {
    writeConfigSetting("update.auto", String(autoUpdate), "global", env);
  }

  ensureInstallId(env);
  return { accepted: true };
}
