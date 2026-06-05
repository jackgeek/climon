import { createServer as createNetServer } from "node:net";

export const PORT_RETRY_ATTEMPTS = 20;

export function isAddressInUse(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /address already in use|EADDRINUSE/i.test(message);
}

export async function canBindTcpPort(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        resolve(false);
        return;
      }
      reject(error);
    });
    probe.listen(port, host, () => {
      probe.close(() => resolve(true));
    });
  });
}

export async function chooseAvailablePort(
  startPort: number,
  options: {
    maxAttempts?: number;
    canBind: (port: number) => Promise<boolean>;
  }
): Promise<{ port: number; changed: boolean }> {
  const maxAttempts = options.maxAttempts ?? PORT_RETRY_ATTEMPTS;
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const port = startPort + offset;
    if (await options.canBind(port)) {
      return { port, changed: port !== startPort };
    }
  }
  throw new Error(`No available port found from ${startPort} to ${startPort + maxAttempts - 1}.`);
}
