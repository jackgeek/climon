import { readGlobalConfigSetting, writeConfigSetting } from "../config.js";
import { t } from "../i18n/messages.js";
import { EULA_VERSION, getEula } from "./text.js";

/**
 * True only when the user has accepted the EULA AND the accepted version matches
 * the currently embedded EULA_VERSION. A bumped version re-triggers acceptance.
 */
export function isEulaAccepted(env: NodeJS.ProcessEnv = process.env): boolean {
  const accepted = readGlobalConfigSetting("eula.accepted", env) === true;
  const version = readGlobalConfigSetting("eula.version", env);
  return accepted && version === EULA_VERSION;
}

/** Records acceptance of the current EULA version in the global config. */
export function recordEulaAcceptance(
  env: NodeJS.ProcessEnv = process.env
): void {
  writeConfigSetting("eula.accepted", "true", "global", env);
  writeConfigSetting("eula.version", EULA_VERSION, "global", env);
  writeConfigSetting("eula.acceptedAt", new Date().toISOString(), "global", env);
}

export type EulaGateOptions = {
  env?: NodeJS.ProcessEnv;
  /** When false, do not prompt; require acceptEula. Defaults to true. */
  interactive?: boolean;
  /** Non-interactive acceptance (e.g. from a --accept-eula flag). */
  acceptEula?: boolean;
  /** Output sink (defaults to stdout). */
  print?: (s: string) => void;
  /** Prompt for a line of input (defaults to a readline question). */
  prompt?: (question: string) => Promise<string>;
};

/**
 * Ensures the EULA is accepted, returning true if it is (now or already).
 * - If already accepted for the current version, returns true without prompting.
 * - Non-interactive: requires `acceptEula === true`, else prints guidance and
 *   returns false.
 * - Interactive: prints the licence and requires the user to type "I AGREE".
 * Never throws; callers decide how to handle a false return (e.g. abort).
 */
export async function ensureEulaAccepted(
  options: EulaGateOptions = {}
): Promise<boolean> {
  const env = options.env ?? process.env;
  const print = options.print ?? ((s: string) => process.stdout.write(s));
  const interactive = options.interactive ?? true;

  if (isEulaAccepted(env)) return true;

  if (options.acceptEula) {
    recordEulaAcceptance(env);
    return true;
  }

  if (!interactive) {
    print(t("eula.needAcceptFlag") + "\n");
    return false;
  }

  print(getEula("en").text + "\n");
  const prompt =
    options.prompt ??
    (async (question: string) => {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    });

  const answer = await prompt(t("eula.acceptPrompt"));
  if (answer.trim().toLowerCase() === "i agree") {
    recordEulaAcceptance(env);
    return true;
  }
  print(t("eula.declined") + "\n");
  return false;
}
