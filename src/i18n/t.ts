import { loadCatalog, renderMessage } from "./catalog.js";
import type { MessageParams } from "./types.js";

/**
 * Supported locales. English is the authoritative source; others are future.
 * Kept here so EULA text and other locale-keyed records have a stable type now
 * that the legacy `src/i18n/messages.ts` catalog has been retired in favour of
 * the single `messages.en.json` source of truth.
 */
export type Locale = "en";

/**
 * Resolves a user-facing message by catalog key, interpolating `{named}`
 * placeholders from `params`. Backed by the same `messages.en.json` catalog that
 * `logMsg` uses, so user-facing and log strings share one source of truth.
 * Unknown keys fall back to the key itself (visible, never throws).
 */
export function t(key: string, params: MessageParams = {}): string {
  return renderMessage(loadCatalog(), key, params);
}
