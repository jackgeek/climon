import { chmod, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export async function prepareNodePty(
  rootDir = process.cwd(),
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  if (platform === "win32") {
    return;
  }

  const prebuildsDir = join(rootDir, "node_modules", "node-pty", "prebuilds");
  let prebuilds;

  try {
    prebuilds = await readdir(prebuildsDir, {
      encoding: "utf8",
      withFileTypes: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const prebuild of prebuilds) {
    if (!prebuild.isDirectory()) {
      continue;
    }

    const helperPath = join(prebuildsDir, prebuild.name, "spawn-helper");

    try {
      if ((await stat(helperPath)).isFile()) {
        await chmod(helperPath, 0o755);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}
