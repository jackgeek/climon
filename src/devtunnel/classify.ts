import { sanitizeDiagnostic } from "../logging/sanitize.js";
import type {
  DevtunnelErrorCode,
  DevtunnelFailure,
  DevtunnelFailureInput,
  DevtunnelOperation,
  DevtunnelRetryClass
} from "./types.js";

const POLICY: Record<DevtunnelErrorCode, {
  summary: string;
  remediation: string;
  retryClass: DevtunnelRetryClass;
  retryable: boolean;
}> = {
  cli_missing: {
    summary: "Microsoft Dev Tunnels is not installed.",
    remediation: "Install Dev Tunnels using the climon README instructions, then retry.",
    retryClass: "actionable",
    retryable: false
  },
  not_authenticated: {
    summary: "Microsoft Dev Tunnels is not signed in.",
    remediation: "Run `devtunnel user login`, then retry.",
    retryClass: "actionable",
    retryable: false
  },
  tunnel_quota_exhausted: {
    summary: "Climon could not create a dev tunnel because this account already has too many tunnels.",
    remediation: "Run `devtunnel list`, delete an unused tunnel manually, then retry.",
    retryClass: "actionable",
    retryable: false
  },
  rate_limited: {
    summary: "Microsoft Dev Tunnels is temporarily rate limiting requests.",
    remediation: "Wait for the retry timer or retry later.",
    retryClass: "transient",
    retryable: true
  },
  permission_denied: {
    summary: "This identity does not have permission to use the requested dev tunnel.",
    remediation: "Sign in with an authorized identity or update the tunnel access list, then retry.",
    retryClass: "actionable",
    retryable: false
  },
  tunnel_not_found: {
    summary: "The saved dev tunnel no longer exists.",
    remediation: "Retry so Climon can recreate or rediscover the tunnel.",
    retryClass: "permanent",
    retryable: false
  },
  port_conflict: {
    summary: "The dev tunnel port mapping already exists.",
    remediation: "Climon will reuse the existing mapping.",
    retryClass: "permanent",
    retryable: false
  },
  network_unavailable: {
    summary: "Climon could not reach Microsoft Dev Tunnels.",
    remediation: "Check the network connection; Climon will retry automatically.",
    retryClass: "transient",
    retryable: true
  },
  service_unavailable: {
    summary: "Microsoft Dev Tunnels is temporarily unavailable.",
    remediation: "Climon will retry automatically.",
    retryClass: "transient",
    retryable: true
  },
  process_exited: {
    summary: "The dev tunnel process stopped unexpectedly.",
    remediation: "Climon will retry automatically.",
    retryClass: "transient",
    retryable: true
  },
  invalid_output: {
    summary: "Climon could not understand the Dev Tunnels response.",
    remediation: "Update the `devtunnel` CLI and retry.",
    retryClass: "unknown",
    retryable: false
  },
  unknown: {
    summary: "Microsoft Dev Tunnels could not complete the operation.",
    remediation: "Review the technical details and retry.",
    retryClass: "unknown",
    retryable: false
  }
};

export function classifyDevtunnelFailure(
  input: DevtunnelFailureInput | (Omit<DevtunnelFailureInput, "operation"> & { operation: string }),
  now: Date = new Date()
): DevtunnelFailure {
  const output = `${input.stdout}\n${input.stderr}`.trim();
  let code: DevtunnelErrorCode = "unknown";
  if (input.spawnError === "ENOENT" || input.status === 127) code = "cli_missing";
  else if (input.parseFailed) code = "invalid_output";
  else if (/not\s+logged\s+in|not\s+authenticated/i.test(output)) code = "not_authenticated";
  else if (/too many tunnels|maximum number of tunnels|tunnel quota/i.test(output)) code = "tunnel_quota_exhausted";
  else if (/\b429\b|too many requests|rate limit/i.test(output)) code = "rate_limited";
  else if (/\b403\b|forbidden|does not have access|permission denied/i.test(output)) code = "permission_denied";
  else if (/not\s+found|does\s+not\s+exist|\b404\b|no tunnel/i.test(output)) code = "tunnel_not_found";
  else if (/conflict|already\s+exists/i.test(output)) code = "port_conflict";
  else if (/name or service not known|network is unreachable|connection refused|dns/i.test(output)) code = "network_unavailable";
  else if (/\b50[234]\b|service unavailable|temporarily unavailable/i.test(output)) code = "service_unavailable";
  else if (input.operation === "host-tunnel" || input.operation === "connect-tunnel") code = "process_exited";

  const policy = POLICY[code];
  const retryAfter = output.match(/retry-after[:\s]+(\d+)/i)?.[1];
  return {
    code,
    operation: input.operation as DevtunnelOperation,
    summary: policy.summary,
    remediation: policy.remediation,
    technicalDetail: sanitizeDiagnostic(output || `exit status ${input.status}`),
    occurredAt: now.toISOString(),
    retryClass: policy.retryClass,
    retryable: policy.retryable,
    retryAfterMs: retryAfter ? Number(retryAfter) * 1000 : undefined,
    status: input.status
  };
}
