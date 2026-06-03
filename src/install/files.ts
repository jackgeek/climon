import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const REQUIRED_BINARIES = ["climon.exe", "climon-server.exe"] as const;

export function installBinaries(sourceDir: string, installDir: string): void {
  mkdirSync(installDir, { recursive: true });

  for (const name of REQUIRED_BINARIES) {
    const source = join(sourceDir, name);
    if (!existsSync(source)) {
      throw new Error(`Required installer sibling is missing: ${name}`);
    }
    copyFileSync(source, join(installDir, name));
  }
}
