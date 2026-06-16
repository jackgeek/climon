/** Supported locales. English is the authoritative source; others are future. */
export type Locale = "en";

/** All user-facing message keys. Add new keys here, never inline literals. */
export type MessageKey =
  | "eula.acceptPrompt"
  | "eula.declined"
  | "eula.needAcceptFlag"
  | "telemetry.prompt"
  | "autoUpdate.prompt"
  | "update.banner"
  | "update.applied"
  | "update.upToDate"
  | "update.verifyFailed"
  | "update.deferredLocked";

type Catalog = Record<MessageKey, string>;

export const MESSAGES: Record<Locale, Catalog> = {
  en: {
    "eula.acceptPrompt": "Type 'I AGREE' to accept the licence and continue: ",
    "eula.declined": "Licence not accepted. Installation aborted.",
    "eula.needAcceptFlag":
      "Non-interactive run requires --accept-eula to accept the licence.",
    "telemetry.prompt":
      "Help improve climon by sending anonymous usage telemetry? [y/N] ",
    "autoUpdate.prompt":
      "Automatically download and apply climon updates in the background? [y/N] ",
    "update.banner": "Update {current} → {next} available — run `climon --update`",
    "update.applied":
      "Update applied. Start new sessions (or restart the server) to use {next}.",
    "update.upToDate": "climon is already up to date ({current}).",
    "update.verifyFailed":
      "Update aborted: signature verification failed. No changes were made.",
    "update.deferredLocked":
      "Update could not be applied right now (files in use). Will retry later.",
  },
};

const ACTIVE_LOCALE: Locale = "en";

/**
 * Resolves a message by key for the active locale, interpolating `{name}`
 * placeholders from `params`. Unknown keys return the key itself so a missing
 * translation is visible but never throws.
 */
export function t(
  key: MessageKey,
  params: Record<string, string | number> = {}
): string {
  const template = MESSAGES[ACTIVE_LOCALE][key];
  if (template === undefined) return key;
  return template.replace(/\{(\w+)\}/g, (_m, name: string) =>
    name in params ? String(params[name]) : `{${name}}`
  );
}
