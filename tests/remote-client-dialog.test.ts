import { describe, expect, test } from "bun:test";
import { applyRemoteStatusToDraft, type RemoteClientDraftState } from "../src/web/components/remoteClientState.js";

const baseState: RemoteClientDraftState = {
  status: null,
  tunnelInput: ""
};

describe("applyRemoteStatusToDraft", () => {
  test("populates tunnelInput from status tunnel id", () => {
    const result = applyRemoteStatusToDraft(baseState, {
      devtunnelAvailable: true,
      ingestPort: 3132,
      tunnel: { id: "spiffy-chair-c2lj709.eun1" },
      canHost: true
    });

    expect(result.tunnelInput).toBe("spiffy-chair-c2lj709.eun1");
  });

  test("retains existing tunnelInput when status has no tunnel", () => {
    const withInput: RemoteClientDraftState = { ...baseState, tunnelInput: "my-tunnel" };
    const result = applyRemoteStatusToDraft(withInput, {
      devtunnelAvailable: true,
      ingestPort: 3132,
      canHost: true
    });

    expect(result.tunnelInput).toBe("my-tunnel");
  });
});
