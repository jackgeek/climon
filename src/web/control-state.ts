import type { SurfaceKind } from "../ipc/frame.js";

export type ControlState = "controlling" | "following" | "displaced";

export function deriveControlState(args: {
  ownViewerId: string;
  controllerId: string | null;
  ownCols: number;
  ownRows: number;
  ctrlCols: number;
  ctrlRows: number;
}): ControlState {
  if (args.controllerId && args.controllerId === args.ownViewerId) return "controlling";
  if (args.ownCols < args.ctrlCols || args.ownRows < args.ctrlRows) return "displaced";
  return "following";
}

export function surfaceKind(isStandalone: boolean): SurfaceKind {
  return isStandalone ? "pwa" : "dashboard";
}
