import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import webpush from "web-push";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export function vapidKeyPath(climonHome: string): string {
  return join(climonHome, "push", "vapid.json");
}

export async function loadOrCreateVapidKeys(climonHome: string): Promise<VapidKeys> {
  const path = vapidKeyPath(climonHome);
  const file = Bun.file(path);
  if (await file.exists()) {
    try {
      const parsed = (await file.json()) as Partial<VapidKeys>;
      if (parsed.publicKey && parsed.privateKey) {
        return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
      }
    } catch {
      // fall through and regenerate
    }
  }
  const generated = webpush.generateVAPIDKeys();
  const keys: VapidKeys = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}
