import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Returns true if this process now owns the singleton, false if another live instance holds it. */
export async function acquireSingleton(pidFile: string): Promise<boolean> {
  try {
    const existing = await readFile(pidFile, "utf8");
    const pid = Number.parseInt(existing.trim(), 10);
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return false;
  } catch {
    // No (or unreadable) pidfile: we may proceed.
  }
  await mkdir(dirname(pidFile), { recursive: true });
  await writeFile(pidFile, `${process.pid}\n`, { mode: 0o600 });
  return true;
}
