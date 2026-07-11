import { describe, expect, test } from "bun:test";
import {
  closeTunnelLinkMenuLabel,
  shouldShowCloseTunnelLink,
  shouldShowTunnelLink,
  tunnelLinkMenuLabel
} from "../src/web/components/Sidebar.js";

describe("Tunnel Link menu labels", () => {
  test("uses the approved short menu labels", () => {
    expect(tunnelLinkMenuLabel).toBe("Tunnel Link");
    expect(closeTunnelLinkMenuLabel).toBe("Close Tunnel Link");
  });

  test("always shows Tunnel Link so missing installations are discoverable", () => {
    expect(shouldShowTunnelLink({ devtunnelAvailable: true })).toBe(true);
    expect(shouldShowTunnelLink({ devtunnelAvailable: false })).toBe(true);
    expect(shouldShowTunnelLink(null)).toBe(true);
  });

  test("shows Close Tunnel Link only while a dashboard tunnel is running", () => {
    expect(shouldShowCloseTunnelLink({ devtunnelAvailable: true, running: true })).toBe(true);
    expect(shouldShowCloseTunnelLink({ devtunnelAvailable: true, running: false })).toBe(false);
    expect(shouldShowCloseTunnelLink(null)).toBe(false);
  });
});
