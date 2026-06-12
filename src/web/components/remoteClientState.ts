import type { RemoteStatus } from "../api.js";

export interface RemoteClientDraftState {
  status: RemoteStatus | null;
  tunnelInput: string;
}

export function applyRemoteStatusToDraft(
  state: RemoteClientDraftState,
  status: RemoteStatus
): RemoteClientDraftState {
  return {
    ...state,
    status,
    tunnelInput: status.tunnel?.id ?? state.tunnelInput
  };
}
