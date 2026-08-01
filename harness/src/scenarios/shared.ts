import type { DarId } from "../scenario-registry.js";
import { HarnessError } from "../types.js";

export function asAbsoluteDeadline(deadline: number | Date): number {
  return deadline instanceof Date ? deadline.getTime() : deadline;
}

export function notImplementedRunner(darId: DarId): () => Promise<never> {
  return async () => {
    throw new HarnessError(
      "assertion",
      `${darId} is not implemented in the E2E harness yet. Replace the placeholder runner before relying on this scenario.`
    );
  };
}
