import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { applyRemoteStatusToDraft, type RemoteClientDraftState } from "../src/web/components/remoteClientState.js";
import { RemoteTunnelStatusSection } from "../src/web/components/RemoteClientDialog.js";

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

describe("RemoteClientDialog auto-managed tunnel status", () => {
  test("shows auto-managed tunnel status without create/recreate buttons", () => {
    const markup = renderToStaticMarkup(createElement(RemoteTunnelStatusSection, {
      status: {
        devtunnelAvailable: true,
        ingestPort: 7070,
        tunnel: { id: "climon-ingest-f6466583e8b34a25d74d.eun1" },
        canHost: true
      }
    }));

    expect(markup).toContain("Ingest tunnel (auto-managed)");
    expect(markup).toContain("climon-ingest-f6466583e8b34a25d74d");
    expect(markup).not.toMatch(/create tunnel/i);
    expect(markup).not.toMatch(/recreate/i);
  });
});
