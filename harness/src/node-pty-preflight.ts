import { chmod, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

type NodePtyFileSystem = {
  chmod: typeof chmod;
  readdir: typeof readdir;
  stat: typeof stat;
};

const nodePtyFileSystem: NodePtyFileSystem = {
  chmod,
  readdir,
  stat,
};

export async function prepareNodePty(
  rootDir = process.cwd(),
  platform: NodeJS.Platform = process.platform,
  fileSystem: NodePtyFileSystem = nodePtyFileSystem
): Promise<void> {
  if (platform === "win32") {
    return;
  }

  const prebuildsDir = join(rootDir, "node_modules", "node-pty", "prebuilds");
  let prebuilds;

  try {
    prebuilds = await fileSystem.readdir(prebuildsDir, {
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
      if ((await fileSystem.stat(helperPath)).isFile()) {
        await fileSystem.chmod(helperPath, 0o755);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}
