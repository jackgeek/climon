/**
 * Debug logging for remote connection troubleshooting.
 * Enabled by setting CLIMON_DEBUG=1 (or any truthy value).
 * Writes to stderr with a `climon:<component>` prefix and timestamp.
 */

const enabled = !!process.env.CLIMON_DEBUG;

function timestamp(): string {
  return new Date().toISOString();
}

function makeLogger(component: string) {
  const prefix = `climon:${component}`;
  return (message: string, ...args: unknown[]): void => {
    if (!enabled) return;
    const extra = args.length > 0 ? " " + args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ") : "";
    process.stderr.write(`[${timestamp()}] ${prefix}: ${message}${extra}\n`);
  };
}

export const debugUplink = makeLogger("uplink");
export const debugIngest = makeLogger("ingest");
export const debugDiscovery = makeLogger("discovery");
export const debugMux = makeLogger("mux");
