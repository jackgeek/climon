import { HarnessError, type SubcheckResult } from "./types.js";

export interface SubcheckDefinition<Name extends string = string> {
  name: Name;
  title: string;
}

export function formatSubcheckLabel(
  subcheck: Pick<SubcheckDefinition, "name" | "title">
): string {
  return `${subcheck.title} (${subcheck.name})`;
}

export function failedSubcheckLabels(
  subchecks: readonly SubcheckResult[]
): string[] {
  return subchecks
    .filter((subcheck) => subcheck.status === "failed")
    .map((subcheck) => formatSubcheckLabel(subcheck));
}

export function validateSubcheckResults(
  definitions: readonly SubcheckDefinition[],
  results: readonly SubcheckResult[]
): void {
  if (definitions.length !== results.length) {
    throw new HarnessError(
      "assertion",
      `Expected ${definitions.length} subchecks, received ${results.length}`
    );
  }

  definitions.forEach((definition, index) => {
    const result = results[index]!;
    if (result.name !== definition.name) {
      throw new HarnessError(
        "assertion",
        `Subcheck order mismatch at ${index}: expected ${definition.name}, received ${result.name}`
      );
    }
    if (result.title !== definition.title) {
      throw new HarnessError(
        "assertion",
        `Subcheck title mismatch for ${definition.name}`
      );
    }
  });
}
