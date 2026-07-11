import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getSessionsDir } from "../config.js";
import { validateSessionId } from "../session-id.js";

export interface IpcAuthRecord {
  version: number;
  generation: string;
  endpoint: string;
  credential: string;
}

export async function readIpcAuthRecord(id: string): Promise<IpcAuthRecord | null> {
  validateSessionId(id);
  const path = join(getSessionsDir(), `${id}.ipc-auth`);
  try {
    return JSON.parse(await readFile(path, "utf8")) as IpcAuthRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function credentialBytes(record: IpcAuthRecord): Uint8Array {
  return Uint8Array.from(Buffer.from(record.credential, "hex"));
}
