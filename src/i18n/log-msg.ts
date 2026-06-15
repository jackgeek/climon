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
 * message (unchanged developer experience). The record also carries `msgId`,
 * `msgKey`, and the raw `args` so the Application Insights stream can transmit
 * the compact id + per-parameter-redacted args instead of the rendered text.
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
  logger[level]({ msgId, msgKey: key, args: params }, text);
}
