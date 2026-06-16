import { createContext, useContext, type ReactNode } from "react";
import type { FeatureFlagState } from "../../features.js";

export type FeatureFlagsMap = Record<string, FeatureFlagState>;

const FeatureFlagsContext = createContext<FeatureFlagsMap>({});

export function FeatureFlagsProvider({
  value,
  children
}: {
  value: FeatureFlagsMap;
  children: ReactNode;
}) {
  return <FeatureFlagsContext.Provider value={value}>{children}</FeatureFlagsContext.Provider>;
}

/** Returns the effective state of a feature flag. Unknown flags read as disabled. */
export function useFeature(name: string): FeatureFlagState {
  const map = useContext(FeatureFlagsContext);
  return map[name] ?? { enabled: false, locked: false, status: "experimental" };
}
