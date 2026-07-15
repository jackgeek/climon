import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DevtunnelErrorCode, DevtunnelFailure } from "../src/devtunnel/types.js";
import { DevtunnelFailure as DevtunnelFailureView } from "../src/web/components/DevtunnelFailure.js";
import { DEVTUNNEL_INSTALL_DOCS_URL } from "../src/web/devtunnel-docs.js";
import { TunnelLinkBody } from "../src/web/components/TunnelLinkDialog.js";

function makeFailure(code: DevtunnelErrorCode, overrides: Partial<DevtunnelFailure> = {}): DevtunnelFailure {
  return {
    code,
    operation: "create-tunnel",
    summary: `summary for ${code}`,
    remediation: `remediation for ${code}`,
    technicalDetail: `technical detail for ${code}`,
    occurredAt: "2026-07-11T12:00:00.000Z",
    retryClass: "actionable",
    retryable: true,
    ...overrides
  };
}

function render(failure: DevtunnelFailure) {
  return renderToStaticMarkup(
    createElement(DevtunnelFailureView, {
      failure,
      onRetry: () => {},
      retrying: false
    })
  );
}

describe("DevtunnelFailure component", () => {
  test("cli_missing guides installation with the README link, Retry, and details", () => {
    const markup = render(makeFailure("cli_missing"));
    expect(markup).toContain("Microsoft Dev Tunnels is not installed");
    expect(markup).toContain(DEVTUNNEL_INSTALL_DOCS_URL);
    expect(markup).toContain("Retry");
    expect(markup).toContain("<details");
  });

  test("not_authenticated shows the sign-in command", () => {
    const markup = render(makeFailure("not_authenticated"));
    expect(markup).toContain("devtunnel user login");
  });

  test("tunnel_quota_exhausted shows devtunnel list without offering automatic deletion", () => {
    const markup = render(makeFailure("tunnel_quota_exhausted"));
    expect(markup).toContain("devtunnel list");
    expect(markup).not.toContain("Delete automatically");
  });

  test("rate_limited surfaces retry timing", () => {
    const markup = render(makeFailure("rate_limited", { retryAfterMs: 30000 }));
    expect(markup.toLowerCase()).toContain("retry");
    expect(markup).toMatch(/30\s*second/i);
  });

  test("disables Retry while retrying", () => {
    const markup = renderToStaticMarkup(
      createElement(DevtunnelFailureView, {
        failure: makeFailure("rate_limited"),
        onRetry: () => {},
        retrying: true
      })
    );
    expect(markup).toContain("disabled");
  });
});

describe("TunnelLinkBody running state", () => {
  test("still renders Copy and Open controls when a URL is present", () => {
    const markup = renderToStaticMarkup(
      createElement(TunnelLinkBody, {
        status: {
          devtunnelAvailable: true,
          authenticated: true,
          running: true,
          url: "https://example.devtunnels.ms/",
          tunnelId: "happy-tunnel-abc.eun1"
        },
        retrying: false,
        onRetry: () => {},
        copied: false,
        onCopy: () => {}
      })
    );
    expect(markup).toContain("Copy link");
    expect(markup).toContain("Open link");
  });
});
