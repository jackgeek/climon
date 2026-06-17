import type { Logger } from "pino";
import { loadCatalog, lookupByKey, renderMessage } from "./catalog.js";
import type { Catalog, MessageParams } from "./types.js";

/** Log levels that carry a catalog message. */
export type LogMsgLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/**
 * Id used for records whose key is not (yet) in the catalog. The Application
 * Insights emitter (SP-C) recognizes it as "uncatalogued"; once the call-site
 * migration completes, lint forbids it.
 */
export const SENTINEL_MSG_ID = "00000000";

/**
 * Logs a catalogued message.
 *
 * Local file/terminal streams receive the fully rendered text as the pino
 * message (unchanged developer experience) and the params as ordinary top-level
 * structured fields (so existing `{ field }`-style log assertions keep working).
 * The record also carries `msgId` and `msgKey` so the Application Insights
 * stream can transmit the compact id and per-parameter-redacted fields instead
 * of the rendered text.
 *
 * `msgId`/`msgKey` are written after the params spread so they always win; avoid
 * param names that collide with reserved pino fields (`level`, `time`, `pid`,
 * `hostname`, `msg`).
 */
export function logMsg(
  logger: Logger,
  level: LogMsgLevel,
  key: string,
  params: MessageParams = {},
  catalog: Catalog = loadCatalog(),
): void {
  const entry = lookupByKey(catalog, key);
  const msgId = entry?.id ?? SENTINEL_MSG_ID;
  const text = renderMessage(catalog, key, params);
  logger[level]({ ...params, msgId, msgKey: key }, text);
}
