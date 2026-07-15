import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DevtunnelErrorCode, DevtunnelFailure, DevtunnelHealth } from "../src/devtunnel/types.js";
import { applyRemoteStatusToDraft, type RemoteClientDraftState } from "../src/web/components/remoteClientState.js";
import { RemoteTunnelStatusSection } from "../src/web/components/RemoteClientDialog.js";

function health(over: Partial<DevtunnelHealth> = {}): DevtunnelHealth {
  return {
    available: true,
    authenticated: true,
    state: "idle",
    probedAt: "2026-07-11T12:00:00.000Z",
    ...over
  };
}

function failure(code: DevtunnelErrorCode, over: Partial<DevtunnelFailure> = {}): DevtunnelFailure {
  return {
    code,
    operation: "create-tunnel",
    summary: `summary for ${code}`,
    remediation: `remediation for ${code}`,
    technicalDetail: `technical detail for ${code}`,
    occurredAt: "2026-07-11T12:00:00.000Z",
    retryClass: "actionable",
    retryable: true,
    ...over
  };
}

const baseState: RemoteClientDraftState = {
  status: null,
  tunnelInput: ""
};

describe("applyRemoteStatusToDraft", () => {
  test("populates tunnelInput from status tunnel id", () => {
    const result = applyRemoteStatusToDraft(baseState, {
      devtunnelAvailable: true,
      devtunnel: health(),
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
      devtunnel: health(),
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
        devtunnel: health(),
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

  test("renders the missing-CLI hint when devtunnel is unavailable", () => {
    const markup = renderToStaticMarkup(createElement(RemoteTunnelStatusSection, {
      status: {
        devtunnelAvailable: false,
        devtunnel: health({ available: false, authenticated: false }),
        ingestPort: 3132,
        canHost: false
      }
    }));
    expect(markup).toMatch(/devtunnel CLI was not found/i);
  });
});

describe("RemoteClientDialog ingest failure surfacing", () => {
  function renderFailure(code: DevtunnelErrorCode, over: Partial<DevtunnelFailure> = {}) {
    return renderToStaticMarkup(createElement(RemoteTunnelStatusSection, {
      status: {
        devtunnelAvailable: true,
        devtunnel: health({ lastFailure: failure(code, over) }),
        ingestPort: 3132,
        canHost: true
      },
      onRetry: () => {},
      retrying: false
    }));
  }

  test("not_authenticated surfaces the sign-in command and a Retry control", () => {
    const markup = renderFailure("not_authenticated");
    expect(markup).toContain("devtunnel user login");
    expect(markup).toContain("Retry");
  });

  test("tunnel_quota_exhausted surfaces devtunnel list guidance", () => {
    const markup = renderFailure("tunnel_quota_exhausted");
    expect(markup).toContain("devtunnel list");
  });

  test("rate_limited surfaces retry timing", () => {
    const markup = renderFailure("rate_limited", { retryAfterMs: 30000 });
    expect(markup).toMatch(/30\s*second/i);
  });

  test("disables Retry while a retry is in flight", () => {
    const markup = renderToStaticMarkup(createElement(RemoteTunnelStatusSection, {
      status: {
        devtunnelAvailable: true,
        devtunnel: health({ lastFailure: failure("rate_limited") }),
        ingestPort: 3132,
        canHost: true
      },
      onRetry: () => {},
      retrying: true
    }));
    expect(markup).toContain("disabled");
  });
});
