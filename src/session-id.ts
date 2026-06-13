import { stat } from "node:fs/promises";
import { humanId } from "human-id";
import { getSessionMetaPath } from "./config.js";

const MAX_ATTEMPTS = 50;

function defaultHumanId(): string {
  return humanId({ separator: "-", capitalize: false });
}

async function metaExists(id: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await stat(getSessionMetaPath(id, env));
    return true;
  } catch {
    return false;
  }
}

/**
 * Generates a human-readable, lowercase-hyphenated session id
 * (e.g. `rare-geckos-jam`). Re-rolls if a metadata file already exists for the
 * candidate so ids stay unique within this host. Throws if it cannot find a
 * free id within MAX_ATTEMPTS (no random-suffix fallback by design).
 *
 * `generate` is injectable so tests can force a deterministic collision.
 */
export async function generateSessionId(
  env: NodeJS.ProcessEnv = process.env,
  generate: () => string = defaultHumanId
): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const id = generate();
    if (!(await metaExists(id, env))) {
      return id;
    }
  }
  throw new Error(
    `Could not generate a unique session id after ${MAX_ATTEMPTS} attempts`
  );
}
