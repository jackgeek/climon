import { describe, expect, test } from "bun:test";
import { applyRemoteStatusToDraft, type RemoteClientDraftState } from "../src/web/components/remoteClientState.js";

const baseState: RemoteClientDraftState = {
  status: null,
  tunnelInput: "",
  connectToken: ""
};

describe("applyRemoteStatusToDraft", () => {
  test("retains an existing connect token when reopened status omits it", () => {
    const afterCreate = applyRemoteStatusToDraft(baseState, {
      devtunnelAvailable: true,
      ingestPort: 3132,
      tunnel: { id: "spiffy-chair-c2lj709.eun1" },
      connectToken: "tok-once",
      canHost: true
    });

    const afterReopenRefresh = applyRemoteStatusToDraft(afterCreate, {
      devtunnelAvailable: true,
      ingestPort: 3132,
      tunnel: { id: "spiffy-chair-c2lj709.eun1" },
      canHost: true
    });

    expect(afterReopenRefresh.connectToken).toBe("tok-once");
    expect(afterReopenRefresh.tunnelInput).toBe("spiffy-chair-c2lj709.eun1");
  });
});
