export type DevtunnelOperation =
  | "detect" | "show-user" | "list-tunnels" | "show-tunnel"
  | "create-tunnel" | "delete-tunnel" | "list-ports"
  | "create-port" | "delete-port" | "host-tunnel" | "connect-tunnel";

export type DevtunnelErrorCode =
  | "cli_missing" | "not_authenticated" | "tunnel_quota_exhausted"
  | "rate_limited" | "permission_denied" | "tunnel_not_found"
  | "port_conflict" | "network_unavailable" | "service_unavailable"
  | "process_exited" | "invalid_output" | "unknown";

export type DevtunnelRetryClass = "transient" | "actionable" | "permanent" | "unknown";

export interface DevtunnelFailureInput {
  operation: DevtunnelOperation;
  status: number;
  stdout: string;
  stderr: string;
  spawnError?: string;
  parseFailed?: boolean;
}

export interface DevtunnelFailure {
  code: DevtunnelErrorCode;
  operation: DevtunnelOperation;
  summary: string;
  remediation: string;
  technicalDetail: string;
  occurredAt: string;
  retryClass: DevtunnelRetryClass;
  retryable: boolean;
  retryAfterMs?: number;
  status?: number;
}

export interface DevtunnelRetryState {
  attempt: number;
  nextRetryAt?: string;
  paused: boolean;
}

export interface DevtunnelHealth {
  available: boolean;
  authenticated: boolean;
  version?: string;
  state: "idle" | "starting" | "running" | "retrying" | "paused" | "stopped";
  lastSuccessAt?: string;
  lastFailure?: DevtunnelFailure;
  retry?: DevtunnelRetryState;
  probedAt: string;
}

export class DevtunnelError extends Error {
  constructor(public readonly failure: DevtunnelFailure) {
    super(failure.summary);
    this.name = "DevtunnelError";
  }
}
