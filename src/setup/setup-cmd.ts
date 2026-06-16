import { parseSetupOptions, runOnboarding } from "./onboarding.js";

/** `climon setup` entrypoint: re-runs onboarding with any provided flags. */
export async function runSetupCommand(argv: string[]): Promise<number> {
  const options = parseSetupOptions(argv);
  const result = await runOnboarding({ options });
  return result.accepted ? 0 : 1;
}
