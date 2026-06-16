// @ts-expect-error: pino-applicationinsights ships without complete types
import { createWriteStream } from "pino-applicationinsights";
import type { StreamEntry } from "./types.js";

/** Optional context for the App Insights stream. */
export type AppInsightsOptions = {
  /** Anonymous install id attached to emitted telemetry when telemetry is opted in. */
  installId?: string;
};

/**
 * Builds an in-process App Insights stream entry for the server multistream.
 * Returns undefined when no connection string is configured. Imported only on
 * server-side code paths so the Azure SDK never reaches the client binary.
 *
 * pino-applicationinsights' `createWriteStream` does not accept a connection
 * string directly: it only understands an instrumentation `key` or a `setup`
 * callback. We use the `setup` callback so the modern connection-string format
 * (the only format the Azure SDK v3 supports) is honored. When an anonymous
 * installId is supplied, it is attached as the cloud role instance so telemetry
 * is keyed only by that random id (no PII).
 */
export async function createAppInsightsStream(
  connectionString: string | undefined,
  options?: AppInsightsOptions,
): Promise<StreamEntry | undefined> {
  if (!connectionString || connectionString.trim() === "") return undefined;
  const installId = options?.installId;
  const stream = await createWriteStream({
    setup: (appInsights: {
      setup: (s: string) => unknown;
      start: () => void;
      defaultClient?: {
        context?: {
          keys?: { cloudRoleInstance?: string };
          tags?: Record<string, string>;
        };
      };
    }) => {
      appInsights.setup(connectionString);
      if (installId) {
        const context = appInsights.defaultClient?.context;
        const key = context?.keys?.cloudRoleInstance;
        if (context?.tags && key) {
          context.tags[key] = installId;
        }
      }
      appInsights.start();
    },
  });
  return { stream: stream as unknown as NodeJS.WritableStream };
}
