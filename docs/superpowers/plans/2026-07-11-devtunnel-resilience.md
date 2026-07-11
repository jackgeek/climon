# Dev-Tunnel Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every Microsoft Dev Tunnels operation through typed Bun/Rust gateways, surface actionable failures consistently, and make Tunnel Link discoverable and recoverable when the CLI is missing, logged out, quota-limited, or temporarily unavailable.

**Architecture:** The Bun server and Rust client remain independent binaries, each with one runtime-local dev-tunnel gateway. A checked-in fixture corpus defines their shared error/status contract; product managers consume typed results while preserving existing tunnel reuse, self-heal, and process ownership.

**Tech Stack:** Bun 1.3, TypeScript ESM, React 19, Fluent UI v9, `bun:test`, Rust 2021, Tokio process/time, Serde, Cargo tests.

---

## File structure

### Shared contract

- Create `fixtures/devtunnel/failures.json` — cross-runtime classification corpus.
- Create `src/devtunnel/types.ts` — stable Bun error, retry, health, command, and process types.
- Create `src/devtunnel/classify.ts` — Bun structured-first classifier and friendly remediation.
- Create `tests/devtunnel-classify.test.ts` — Bun fixture/parity tests.
- Create `rust/climon-remote/src/devtunnel/types.rs` — Rust equivalents with Serde shapes matching Bun.
- Create `rust/climon-remote/src/devtunnel/classify.rs` — Rust fixture-compatible classifier.
- Create `rust/climon-remote/src/devtunnel/mod.rs` — gateway module exports.

### Bun gateway and server integration

- Create `src/devtunnel/gateway.ts` — all short-lived Bun command execution, environment setup, probes, and operations.
- Create `src/devtunnel/process.ts` — long-running hosted-process wrapper and lifecycle events.
- Create `src/devtunnel/retry.ts` — capped retry/backoff state machine.
- Create `tests/devtunnel-gateway.test.ts` — command construction, process, retry, and sanitization tests.
- Modify `src/server/dashboard-tunnel.ts` — consume the gateway; retain dashboard-specific persistence, URL verification, keepalive, and self-heal.
- Modify `src/remote/tunnel.ts` — retain server-side ingest desired-state behavior but delegate commands/classification to the gateway.
- Modify `src/server/server.ts` — construct one gateway, expose structured API failures/status, and share it with both managers.
- Modify `tests/dashboard-tunnel.test.ts`, `tests/tunnel.test.ts`, and `tests/server-remote.test.ts` — typed failure and regression coverage.

### Dashboard UI

- Create `src/web/devtunnel-docs.ts` — one exported GitHub README installation URL.
- Create `src/web/components/DevtunnelFailure.tsx` — shared friendly failure, remediation, details disclosure, and Retry UI.
- Modify `src/web/api.ts` — shared dev-tunnel status/error wire types and JSON error parsing.
- Modify `src/web/components/Sidebar.tsx` — always show Tunnel Link.
- Modify `src/web/components/TunnelLinkDialog.tsx` — state-driven missing/auth/quota/transient/running UI.
- Modify `src/web/components/RemoteClientDialog.tsx` — show normalized ingest tunnel health and Retry.
- Modify `src/web/App.tsx` — retain structured failures and implement explicit Retry.
- Modify `tests/dashboard-tunnel-menu.test.ts` and `tests/remote-client-dialog.test.ts`.
- Create `tests/devtunnel-failure-ui.test.ts`.

### Rust gateway and remote integration

- Create `rust/climon-remote/src/devtunnel/gateway.rs` — Tokio command builder, short-lived operations, and process spawn.
- Create `rust/climon-remote/src/devtunnel/retry.rs` — Rust backoff/pause state.
- Modify `rust/climon-remote/src/lib.rs` — export `devtunnel`.
- Modify `rust/climon-remote/src/tunnel.rs` — keep ingest tunnel state orchestration; use gateway operations.
- Modify `rust/climon-remote/src/discovery.rs` — return success-empty separately from typed failure.
- Modify `rust/climon-remote/src/uplink.rs` — use gateway connect/port operations and retry classification.
- Modify `rust/climon-remote/src/ingest.rs` — use gateway host process and record host failures.
- Modify `rust/climon-cli/src/launcher.rs` — use the shared Rust probe result rather than a local command.

### Status, CLI, and docs

- Modify `rust/climon-remote/src/uplink_status.rs` and `rust/climon-remote/src/ingest_status.rs` — serialize normalized dev-tunnel health.
- Modify `rust/climon-cli/src/remotes_cmd.rs` — render friendly error, code, time, retry, remediation, and technical detail.
- Modify `src/web/api.ts`, `src/server/server.ts`, and `src/web/components/RemoteClientDialog.tsx` — surface the same server-side status.
- Create `docs/manual-tests/devtunnel-resilience.md`.
- Modify `docs/manual-tests/README.md`, `README.md`, `docs/architecture.md`, `docs/troubleshooting.md`, and `docs/features.md`.

### Scope discipline

Do not add a new feature flag: this hardens existing Tunnel Link and remotes behavior. Do not add a broker daemon, automatic login, automatic CLI installation, or automatic tunnel deletion.

---

### Task 1: Define the shared failure contract and fixtures

**Files:**
- Create: `fixtures/devtunnel/failures.json`
- Create: `src/devtunnel/types.ts`
- Create: `src/devtunnel/classify.ts`
- Create: `tests/devtunnel-classify.test.ts`

- [ ] **Step 1: Write the failing Bun fixture test**

Create `tests/devtunnel-classify.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import fixtures from "../fixtures/devtunnel/failures.json";
import { classifyDevtunnelFailure } from "../src/devtunnel/classify.js";

describe("classifyDevtunnelFailure", () => {
  for (const fixture of fixtures) {
    test(fixture.name, () => {
      expect(classifyDevtunnelFailure(fixture.input)).toMatchObject(fixture.expected);
    });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test tests/devtunnel-classify.test.ts
```

Expected: FAIL because the fixture and classifier modules do not exist.

- [ ] **Step 3: Add representative failure fixtures**

Create `fixtures/devtunnel/failures.json` with entries for every stable code. Use this exact schema:

```json
[
  {
    "name": "missing executable",
    "input": {
      "operation": "detect",
      "status": 127,
      "stdout": "",
      "stderr": "spawn failed",
      "spawnError": "ENOENT"
    },
    "expected": {
      "code": "cli_missing",
      "retryClass": "actionable",
      "retryable": false
    }
  },
  {
    "name": "not logged in JSON",
    "input": {
      "operation": "show-user",
      "status": 0,
      "stdout": "{\"status\":\"Not logged in\"}",
      "stderr": ""
    },
    "expected": {
      "code": "not_authenticated",
      "retryClass": "actionable",
      "retryable": false
    }
  },
  {
    "name": "tunnel count quota exhausted",
    "input": {
      "operation": "create-tunnel",
      "status": 1,
      "stdout": "",
      "stderr": "Too many tunnels. The maximum number of tunnels has been reached."
    },
    "expected": {
      "code": "tunnel_quota_exhausted",
      "retryClass": "actionable",
      "retryable": false
    }
  },
  {
    "name": "ordinary rate limit",
    "input": {
      "operation": "list-tunnels",
      "status": 1,
      "stdout": "",
      "stderr": "HTTP 429 Too Many Requests. Retry-After: 30"
    },
    "expected": {
      "code": "rate_limited",
      "retryClass": "transient",
      "retryable": true,
      "retryAfterMs": 30000
    }
  },
  {
    "name": "permission denied",
    "input": {
      "operation": "show-tunnel",
      "status": 1,
      "stdout": "",
      "stderr": "403 Forbidden: user does not have access to this tunnel"
    },
    "expected": {
      "code": "permission_denied",
      "retryClass": "actionable",
      "retryable": false
    }
  },
  {
    "name": "tunnel not found",
    "input": {
      "operation": "show-tunnel",
      "status": 1,
      "stdout": "",
      "stderr": "Tunnel not found in eun1: saved-tunnel"
    },
    "expected": {
      "code": "tunnel_not_found",
      "retryClass": "permanent",
      "retryable": false
    }
  },
  {
    "name": "port conflict",
    "input": {
      "operation": "create-port",
      "status": 1,
      "stdout": "",
      "stderr": "Conflict with existing entity"
    },
    "expected": {
      "code": "port_conflict",
      "retryClass": "permanent",
      "retryable": false
    }
  },
  {
    "name": "network unavailable",
    "input": {
      "operation": "list-tunnels",
      "status": 1,
      "stdout": "",
      "stderr": "Name or service not known"
    },
    "expected": {
      "code": "network_unavailable",
      "retryClass": "transient",
      "retryable": true
    }
  },
  {
    "name": "service unavailable",
    "input": {
      "operation": "create-tunnel",
      "status": 1,
      "stdout": "",
      "stderr": "503 Service Unavailable"
    },
    "expected": {
      "code": "service_unavailable",
      "retryClass": "transient",
      "retryable": true
    }
  },
  {
    "name": "unexpected host exit",
    "input": {
      "operation": "host-tunnel",
      "status": 1,
      "stdout": "",
      "stderr": "host process exited"
    },
    "expected": {
      "code": "process_exited",
      "retryClass": "transient",
      "retryable": true
    }
  },
  {
    "name": "invalid successful output",
    "input": {
      "operation": "create-tunnel",
      "status": 0,
      "stdout": "not-json",
      "stderr": "",
      "parseFailed": true
    },
    "expected": {
      "code": "invalid_output",
      "retryClass": "unknown",
      "retryable": false
    }
  },
  {
    "name": "unknown failure",
    "input": {
      "operation": "delete-tunnel",
      "status": 9,
      "stdout": "",
      "stderr": "unexpected condition"
    },
    "expected": {
      "code": "unknown",
      "retryClass": "unknown",
      "retryable": false
    }
  }
]
```

- [ ] **Step 4: Define Bun contract types**

Create `src/devtunnel/types.ts`:

```ts
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
```

- [ ] **Step 5: Implement the Bun classifier**

Create `src/devtunnel/classify.ts`. Inspect combined stdout/stderr, but prioritize `spawnError`, auth JSON, tunnel-quota phrases, and 429 retry metadata in that order. Return fixed summaries/remediation:

```ts
import { sanitizeDiagnostic } from "../logging/sanitize.js";
import type {
  DevtunnelErrorCode,
  DevtunnelFailure,
  DevtunnelFailureInput,
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
  input: DevtunnelFailureInput,
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
    operation: input.operation,
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
```

- [ ] **Step 6: Run the Bun fixture test**

Run:

```bash
bun test tests/devtunnel-classify.test.ts
```

Expected: PASS for all fixtures.

- [ ] **Step 7: Commit**

```bash
git add fixtures/devtunnel/failures.json src/devtunnel/types.ts src/devtunnel/classify.ts tests/devtunnel-classify.test.ts
git commit -m "feat(devtunnel): define typed failure contract"
```

---

### Task 2: Add Rust parity for the shared contract

**Files:**
- Create: `rust/climon-remote/src/devtunnel/mod.rs`
- Create: `rust/climon-remote/src/devtunnel/types.rs`
- Create: `rust/climon-remote/src/devtunnel/classify.rs`
- Modify: `rust/climon-remote/src/lib.rs`

- [ ] **Step 1: Write the failing Rust fixture test**

In `rust/climon-remote/src/devtunnel/classify.rs`, add a `#[cfg(test)]` module that finds `fixtures/devtunnel/failures.json` from `env!("CARGO_MANIFEST_DIR")`, deserializes each case, invokes `classify_failure`, and asserts `code`, `retry_class`, `retryable`, and `retry_after_ms`.

Use a fixture-only expected struct:

```rust
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Expected {
    code: DevtunnelErrorCode,
    retry_class: DevtunnelRetryClass,
    retryable: bool,
    retry_after_ms: Option<u64>,
}
```

- [ ] **Step 2: Run the Rust test to verify it fails**

Run:

```bash
cd rust && cargo test -p climon-remote devtunnel::classify::tests -- --nocapture
```

Expected: FAIL because `devtunnel` types and classifier are not implemented/exported.

- [ ] **Step 3: Implement matching Rust types**

Create `types.rs` with `Serialize`, `Deserialize`, `Debug`, `Clone`, `PartialEq`, and `Eq`. Use `#[serde(rename_all = "kebab-case")]` for `DevtunnelOperation`, `#[serde(rename_all = "snake_case")]` for error/retry enums, and `#[serde(rename_all = "camelCase")]` for structs. Define:

```rust
pub enum DevtunnelOperation { Detect, ShowUser, ListTunnels, ShowTunnel, CreateTunnel, DeleteTunnel, ListPorts, CreatePort, DeletePort, HostTunnel, ConnectTunnel }
pub enum DevtunnelErrorCode { CliMissing, NotAuthenticated, TunnelQuotaExhausted, RateLimited, PermissionDenied, TunnelNotFound, PortConflict, NetworkUnavailable, ServiceUnavailable, ProcessExited, InvalidOutput, Unknown }
pub enum DevtunnelRetryClass { Transient, Actionable, Permanent, Unknown }

pub struct DevtunnelFailureInput {
    pub operation: DevtunnelOperation,
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
    pub spawn_error: Option<String>,
    pub parse_failed: Option<bool>,
}

pub struct DevtunnelFailure {
    pub code: DevtunnelErrorCode,
    pub operation: DevtunnelOperation,
    pub summary: String,
    pub remediation: String,
    pub technical_detail: String,
    pub occurred_at: String,
    pub retry_class: DevtunnelRetryClass,
    pub retryable: bool,
    pub retry_after_ms: Option<u64>,
    pub status: Option<i32>,
}
```

Also define `DevtunnelRetryState` and `DevtunnelHealth` with the same camelCase wire fields as TypeScript.

- [ ] **Step 4: Implement the Rust classifier**

Mirror Task 1's precedence and policy exactly. Keep the policy strings identical so UI/CLI/API parity tests can compare them. Implement a local `sanitize_technical_detail` that:

- replaces URLs, emails, UUIDs, IPs, and long opaque tokens with placeholders;
- truncates to 300 characters;
- never stores unsanitized output in `DevtunnelFailure`.

Do not add a regex dependency; use the existing standard-library scanning style in the crate unless a workspace regex dependency already exists.

- [ ] **Step 5: Export the module**

Create `mod.rs`:

```rust
pub mod classify;
pub mod types;

pub use classify::classify_failure;
pub use types::*;
```

Add to `rust/climon-remote/src/lib.rs`:

```rust
pub mod devtunnel;
```

- [ ] **Step 6: Run Bun and Rust parity tests**

Run:

```bash
bun test tests/devtunnel-classify.test.ts
cd rust && cargo test -p climon-remote devtunnel::classify::tests -- --nocapture
```

Expected: both PASS over the same fixture corpus.

- [ ] **Step 7: Commit**

```bash
git add rust/climon-remote/src/devtunnel rust/climon-remote/src/lib.rs
git commit -m "feat(remote): match devtunnel failure contract"
```

---

### Task 3: Build the Bun command gateway and retry state machine

**Files:**
- Create: `src/devtunnel/gateway.ts`
- Create: `src/devtunnel/process.ts`
- Create: `src/devtunnel/retry.ts`
- Create: `tests/devtunnel-gateway.test.ts`
- Modify: `src/remote/tunnel.ts`

- [ ] **Step 1: Write failing gateway tests**

Cover:

1. `detect()` returns `{available:false}` with `cli_missing`, not a generic false-only result.
2. `showUser()` returns authenticated identity for the documented JSON shape.
3. `createTunnel()` converts quota stderr into `DevtunnelError.failure.code === "tunnel_quota_exhausted"`.
4. `spawnHost()` captures stdout/stderr and classifies an early exit.
5. actionable failure pauses retry;
6. transient failure schedules delays `1000`, `2000`, `4000`, capped at `30000`;
7. success resets attempt count;
8. technical detail is sanitized before leaving the gateway.

Inject `runner`, `processSpawner`, `now`, `random`, and `setTimer` so tests do not spawn the real CLI or sleep.

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
bun test tests/devtunnel-gateway.test.ts
```

Expected: FAIL because gateway/process/retry modules do not exist.

- [ ] **Step 3: Implement `DevtunnelRetryController`**

Create `src/devtunnel/retry.ts`:

```ts
import type { DevtunnelFailure, DevtunnelRetryState } from "./types.js";

export class DevtunnelRetryController {
  private attempt = 0;
  private paused = false;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
    private readonly baseMs = 1000,
    private readonly capMs = 30000
  ) {}

  fail(failure: DevtunnelFailure): DevtunnelRetryState {
    if (failure.retryClass !== "transient") {
      this.paused = true;
      return { attempt: this.attempt, paused: true };
    }
    this.attempt += 1;
    const raw = Math.min(this.capMs, this.baseMs * 2 ** (this.attempt - 1));
    const jittered = Math.round(raw * (0.8 + this.random() * 0.4));
    const delay = failure.retryAfterMs ? Math.max(jittered, failure.retryAfterMs) : jittered;
    return {
      attempt: this.attempt,
      paused: false,
      nextRetryAt: new Date(this.now() + delay).toISOString()
    };
  }

  success(): DevtunnelRetryState {
    this.attempt = 0;
    this.paused = false;
    return { attempt: 0, paused: false };
  }

  resume(): DevtunnelRetryState {
    this.paused = false;
    return { attempt: this.attempt, paused: false };
  }
}
```

- [ ] **Step 4: Implement the gateway**

Move `devtunnelEnv`, disabled-guard handling, short-lived spawn logic, and Windows hiding into `src/devtunnel/gateway.ts`. Expose methods:

```ts
export interface DevtunnelGateway {
  detect(): Promise<DevtunnelHealth>;
  showUser(): Promise<DevtunnelHealth>;
  listTunnels(args?: { labels?: string[] }): Promise<unknown>;
  showTunnel(id: string, verbose?: boolean): Promise<unknown>;
  createTunnel(args: { id?: string; labels?: string[]; description?: string }): Promise<RunResult>;
  deleteTunnel(id: string, force?: boolean): Promise<void>;
  listPorts(id: string): Promise<RunResult>;
  createPort(id: string, port: number, protocol?: "http"): Promise<void>;
  deletePort(id: string, port: number): Promise<void>;
  spawnHost(id: string): DevtunnelProcess;
}
```

All non-idempotent failures throw `DevtunnelError`. `createPort` treats only `port_conflict` as idempotent success. Parsing failures use `invalid_output`.

- [ ] **Step 5: Implement the long-running process wrapper**

Create `src/devtunnel/process.ts` with:

```ts
export interface DevtunnelProcessHandlers {
  onStdout(text: string): void;
  onStderr(text: string): void;
  onExit(failure?: DevtunnelFailure): void;
}

export interface DevtunnelProcess {
  stop(): void;
  isAlive(): boolean;
}
```

The default spawner captures startup output, forwards chunks, sets `alive=false`
once, and classifies a non-zero exit as `process_exited` unless the accumulated
output yields a more specific actionable code.

- [ ] **Step 6: Replace `src/remote/tunnel.ts` execution exports**

Delete its local `defaultRunner`, `devtunnelEnv`, and direct command interpretation. Keep parsing, desired-state persistence, and ingest orchestration. Accept a `DevtunnelGateway` in options; production defaults to `createDevtunnelGateway()`.

Preserve temporary compatibility exports only where current server tests require
them, then remove those aliases when all call sites migrate.

- [ ] **Step 7: Run gateway and existing tunnel tests**

Run:

```bash
bun test tests/devtunnel-gateway.test.ts tests/tunnel.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/devtunnel src/remote/tunnel.ts tests/devtunnel-gateway.test.ts tests/tunnel.test.ts
git commit -m "feat(server): centralize devtunnel execution"
```

---

### Task 4: Migrate Dashboard Tunnel Link and its API

**Files:**
- Modify: `src/server/dashboard-tunnel.ts`
- Modify: `src/server/server.ts`
- Modify: `src/web/api.ts`
- Modify: `tests/dashboard-tunnel.test.ts`
- Modify: relevant server route tests under `tests/`

- [ ] **Step 1: Add failing typed-manager tests**

Update `tests/dashboard-tunnel.test.ts` so the manager receives a fake
`DevtunnelGateway`, not a raw runner/spawner. Add assertions that:

- unauthenticated ensure rejects with `DevtunnelError` code `not_authenticated`;
- quota exhaustion preserves the friendly summary/remediation;
- a host early exit carries technical detail;
- persisted `tunnel_not_found` still clears/recreates;
- `port_conflict` remains idempotent;
- transient host exits enter `retrying`;
- actionable failures enter `paused`;
- `retry()` resumes an explicit action.

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
bun test tests/dashboard-tunnel.test.ts
```

Expected: FAIL because the manager still uses `Runner`/`HostSpawner` and has no structured failure/retry state.

- [ ] **Step 3: Refactor the manager interface**

Change `DashboardTunnelManager` to:

```ts
export interface DashboardTunnelStatus extends DevtunnelHealth {
  running: boolean;
  url?: string;
  tunnelId?: string;
  expiresAt?: string;
}

export interface DashboardTunnelManager {
  status(): Promise<DashboardTunnelStatus>;
  ensure(): Promise<DashboardTunnelStatus>;
  retry(): Promise<DashboardTunnelStatus>;
  close(): Promise<void>;
}
```

Use gateway codes instead of `isMissingTunnelError` and
`isExistingPortError`. Preserve URL parsing, cluster persistence, stale-port
pruning, verification, one recreation, keepalive, and watchdog behavior.

- [ ] **Step 4: Return structured API errors**

In `src/server/server.ts`, add:

```ts
function devtunnelErrorResponse(error: unknown): Response {
  if (!(error instanceof DevtunnelError)) {
    return Response.json({ error: { code: "unknown", summary: "Tunnel Link error" } }, { status: 500 });
  }
  const status = error.failure.code === "not_authenticated" ? 401
    : error.failure.code === "cli_missing" ? 503
    : error.failure.code === "permission_denied" ? 403
    : error.failure.code === "tunnel_quota_exhausted" ? 409
    : error.failure.retryClass === "transient" ? 503
    : 500;
  return Response.json({ error: error.failure }, { status });
}
```

Add `POST /api/dashboard-tunnel/retry`, guarded exactly like the existing ensure
route, calling `dashboardTunnel.retry()`.

- [ ] **Step 5: Update the web API client**

In `src/web/api.ts`, export the shared wire interfaces and:

```ts
export class DevtunnelApiError extends Error {
  constructor(public readonly failure: DevtunnelFailure) {
    super(failure.summary);
  }
}

async function readDevtunnelResponse(res: Response): Promise<DashboardTunnelStatus> {
  const body = await res.json() as DashboardTunnelStatus | { error: DevtunnelFailure };
  if (!res.ok) throw new DevtunnelApiError((body as { error: DevtunnelFailure }).error);
  return body as DashboardTunnelStatus;
}

export function retryDashboardTunnel(): Promise<DashboardTunnelStatus> {
  return fetch(withQuery("/api/dashboard-tunnel/retry"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  }).then(readDevtunnelResponse);
}
```

- [ ] **Step 6: Run focused server tests**

Run:

```bash
bun test tests/dashboard-tunnel.test.ts tests/web-api.test.ts tests/dashboard-host-guard.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/dashboard-tunnel.ts src/server/server.ts src/web/api.ts tests/dashboard-tunnel.test.ts tests/web-api.test.ts tests/dashboard-host-guard.test.ts
git commit -m "feat(tunnel-link): expose structured failures"
```

---

### Task 5: Make Tunnel Link always visible and state-driven

**Files:**
- Create: `src/web/devtunnel-docs.ts`
- Create: `src/web/components/DevtunnelFailure.tsx`
- Create: `tests/devtunnel-failure-ui.test.ts`
- Modify: `src/web/components/Sidebar.tsx`
- Modify: `src/web/components/TunnelLinkDialog.tsx`
- Modify: `src/web/App.tsx`
- Modify: `tests/dashboard-tunnel-menu.test.ts`

- [ ] **Step 1: Change the menu test first**

Replace the availability-dependent test with:

```ts
test("always shows Tunnel Link so missing installations are discoverable", () => {
  expect(shouldShowTunnelLink({ devtunnelAvailable: true })).toBe(true);
  expect(shouldShowTunnelLink({ devtunnelAvailable: false })).toBe(true);
  expect(shouldShowTunnelLink(null)).toBe(true);
});
```

- [ ] **Step 2: Add failing server-render UI tests**

Create `tests/devtunnel-failure-ui.test.ts` using `renderToStaticMarkup`. Assert:

- `cli_missing` contains "Microsoft Dev Tunnels is not installed", the GitHub README URL, "Retry", and a details disclosure;
- `not_authenticated` contains `devtunnel user login`;
- `tunnel_quota_exhausted` contains `devtunnel list` and does not contain "Delete automatically";
- `rate_limited` contains retry timing;
- running Tunnel Link still renders Copy/Open controls.

- [ ] **Step 3: Run UI tests to verify they fail**

Run:

```bash
bun test tests/dashboard-tunnel-menu.test.ts tests/devtunnel-failure-ui.test.ts
```

Expected: FAIL because the menu remains conditional and the shared failure component does not exist.

- [ ] **Step 4: Add the temporary documentation URL**

Create `src/web/devtunnel-docs.ts`:

```ts
export const DEVTUNNEL_INSTALL_DOCS_URL =
  "https://github.com/jackgeek/climon#optional-the-devtunnel-cli";
```

Keep this as the only source of the URL so the future `climon.org/docs` migration
is one edit.

- [ ] **Step 5: Implement the shared failure component**

`DevtunnelFailure.tsx` receives:

```ts
interface Props {
  failure: DevtunnelFailure;
  retry?: DevtunnelRetryState;
  onRetry: () => void;
  retrying: boolean;
}
```

Render friendly summary/remediation, code-specific command/link blocks, a Fluent
`Accordion` or native `<details>` for `technicalDetail`, and a Retry button.
Disable Retry while retrying. For `cli_missing`, render an external link using
`DEVTUNNEL_INSTALL_DOCS_URL`.

- [ ] **Step 6: Make the menu unconditional**

Change:

```ts
export function shouldShowTunnelLink(_status: Pick<DashboardTunnelStatus, "devtunnelAvailable"> | null): boolean {
  return true;
}
```

Keep Close Tunnel Link conditional on `running`.

- [ ] **Step 7: Refactor Tunnel Link dialog state**

Replace the separate `error: string` prop with:

```ts
failure?: DevtunnelFailure;
retrying: boolean;
onRetry(): void;
```

Render `DevtunnelFailure` when no URL and a failure exists; otherwise render
starting/retrying/running states. Do not hide the dialog after failure.

- [ ] **Step 8: Wire explicit Retry in `App.tsx`**

Store `DevtunnelFailure | undefined`, catch `DevtunnelApiError`, and call
`retryDashboardTunnel()` from a new `handleRetryTunnelLink`. Do not automatically
run login or installation.

- [ ] **Step 9: Run UI tests and typecheck**

Run:

```bash
bun test tests/dashboard-tunnel-menu.test.ts tests/devtunnel-failure-ui.test.ts
bun run typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/web/devtunnel-docs.ts src/web/components/DevtunnelFailure.tsx src/web/components/Sidebar.tsx src/web/components/TunnelLinkDialog.tsx src/web/App.tsx tests/dashboard-tunnel-menu.test.ts tests/devtunnel-failure-ui.test.ts
git commit -m "feat(tunnel-link): guide missing and failed setups"
```

---

### Task 6: Migrate server-side ingest tunnel setup and remote status

**Files:**
- Modify: `src/remote/tunnel.ts`
- Modify: `src/server/server.ts`
- Modify: `src/web/api.ts`
- Modify: `src/web/components/RemoteClientDialog.tsx`
- Modify: `tests/tunnel.test.ts`
- Modify: `tests/server-remote.test.ts`
- Modify: `tests/remote-client-dialog.test.ts`

- [ ] **Step 1: Add failing ingest orchestration tests**

Add tests that:

- `ensureIngestTunnel` reports `not_authenticated`, `tunnel_quota_exhausted`, and transient failures without persisting success-shaped `remote-host.json`;
- `reconcileTunnelPort` returns/records a typed failure instead of swallowing failed recreation;
- `/api/remote/status` includes `devtunnel: DevtunnelHealth`;
- `/api/remote/tunnel` returns structured failures;
- Remote dialog renders missing/auth/quota/transient states and Retry.

- [ ] **Step 2: Run focused tests to verify they fail**

Run:

```bash
bun test tests/tunnel.test.ts tests/server-remote.test.ts tests/remote-client-dialog.test.ts
```

Expected: FAIL on missing structured status/failure behavior.

- [ ] **Step 3: Make ingest orchestration gateway-only**

Update signatures:

```ts
export async function ensureIngestTunnel(
  ingestPort: number,
  options: { env?: NodeJS.ProcessEnv; gateway?: DevtunnelGateway } = {}
): Promise<RemoteHostState>
```

Use gateway `showTunnel`, `createTunnel`, `createPort`, `deletePort`, and
`deleteTunnel`. Only `tunnel_not_found` triggers create. Do not treat every failed
`show` as absence. Remove the catch that silently updates state after recreation
fails; return the typed failure and leave the last valid desired state intact.

- [ ] **Step 4: Share one gateway instance in the server**

Construct `const devtunnel = createDevtunnelGateway()` once after server port
resolution. Inject it into Dashboard Tunnel Link and all ingest helper calls. Add
the latest gateway health to `/api/remote/status`.

- [ ] **Step 5: Add remote retry endpoint**

Add loopback/Origin-guarded `POST /api/remote/tunnel/retry`. It reruns
`ensureIngestTunnel`, starts/reconciles ingest only after success, and returns
structured status.

- [ ] **Step 6: Update Remote dialog**

Extend `RemoteStatus`:

```ts
export interface RemoteStatus {
  devtunnelAvailable: boolean;
  version?: string;
  devtunnel: DevtunnelHealth;
  ingestPort: number;
  tunnel?: RemoteTunnelInfo;
  canHost: boolean;
  remoteSpawn?: boolean;
  spawnSecret?: string;
}
```

Render `DevtunnelFailure` when `status.devtunnel.lastFailure` exists and add a
Retry callback to the dialog.

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```bash
bun test tests/tunnel.test.ts tests/server-remote.test.ts tests/remote-client-dialog.test.ts
bun run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/remote/tunnel.ts src/server/server.ts src/web/api.ts src/web/components/RemoteClientDialog.tsx tests/tunnel.test.ts tests/server-remote.test.ts tests/remote-client-dialog.test.ts
git commit -m "feat(remotes): surface ingest tunnel failures"
```

---

### Task 7: Build the Rust gateway and retry controller

**Files:**
- Create: `rust/climon-remote/src/devtunnel/gateway.rs`
- Create: `rust/climon-remote/src/devtunnel/retry.rs`
- Modify: `rust/climon-remote/src/devtunnel/mod.rs`
- Modify: `rust/climon-remote/src/tunnel.rs`

- [ ] **Step 1: Write failing Rust gateway tests**

Use an injectable async runner and process spawner. Cover:

- environment ICU insertion and disable guard;
- missing executable classification;
- documented authenticated and unauthenticated user JSON;
- list/create/show/port command arguments;
- quota classification;
- host/connect early exits;
- transient delay sequence/cap;
- actionable pause and explicit resume.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd rust && cargo test -p climon-remote devtunnel::gateway devtunnel::retry -- --nocapture
```

Expected: FAIL because gateway/retry modules do not exist.

- [ ] **Step 3: Implement the retry controller**

Use a pure struct:

```rust
pub struct RetryController {
    attempt: u32,
    base_ms: u64,
    cap_ms: u64,
}

impl RetryController {
    pub fn fail(&mut self, failure: &DevtunnelFailure, now_ms: u64, jitter: f64) -> DevtunnelRetryState { /* same policy as Bun */ }
    pub fn success(&mut self) -> DevtunnelRetryState { /* reset */ }
    pub fn resume(&mut self) -> DevtunnelRetryState { /* clear paused */ }
}
```

Pass deterministic jitter from callers/tests; do not hide randomness inside the
pure policy.

- [ ] **Step 4: Implement the Tokio gateway**

Move `devtunnel_env`, disabled handling, Tokio `Command` construction, Windows
creation flags, stdin nulling, and output capture into `gateway.rs`.

Expose typed async operations matching the Bun gateway and:

```rust
pub struct SpawnedDevtunnelProcess {
    pub child: tokio::process::Child,
    pub stdout: tokio::process::ChildStdout,
    pub stderr: tokio::process::ChildStderr,
    pub operation: DevtunnelOperation,
}
```

Short-lived operation failures return `Result<T, DevtunnelFailure>`. Long-running
spawn failures return `DevtunnelFailure`; exits are classified from accumulated
stdout/stderr.

- [ ] **Step 5: Migrate `tunnel.rs`**

Keep tunnel input parsing, desired-state persistence, and reconcile orchestration.
Replace the generic string-error surface:

```rust
pub async fn create_tunnel(...) -> Result<RemoteHostState, DevtunnelFailure>
```

Only `TunnelNotFound` permits recreation; propagate auth/quota/service failures.

- [ ] **Step 6: Run focused Rust tests**

Run:

```bash
cd rust && cargo test -p climon-remote devtunnel tunnel -- --nocapture
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add rust/climon-remote/src/devtunnel rust/climon-remote/src/tunnel.rs
git commit -m "feat(remote): centralize Rust devtunnel execution"
```

---

### Task 8: Migrate Rust detection, discovery, connect, and host

**Files:**
- Modify: `rust/climon-remote/src/discovery.rs`
- Modify: `rust/climon-remote/src/uplink.rs`
- Modify: `rust/climon-remote/src/ingest.rs`
- Modify: `rust/climon-cli/src/launcher.rs`

- [ ] **Step 1: Write failing behavior tests**

Add tests for:

- discovery returns `Ok(vec![])` for a successful empty list;
- discovery returns `Err(not_authenticated)` for logged-out output;
- launcher distinguishes missing CLI from logged-out identity;
- uplink pauses on auth/quota and retries transient errors;
- host spawn errors are recorded rather than replaced with a no-op process;
- existing direct-host/WSL paths remain independent of Dev Tunnels.

- [ ] **Step 2: Run focused tests to verify they fail**

Run:

```bash
cd rust && cargo test -p climon-remote discovery uplink ingest -- --nocapture
cargo test -p climon-cli launcher -- --nocapture
```

Expected: FAIL because current discovery collapses errors, launcher probes directly, and ingest returns a no-op host.

- [ ] **Step 3: Change discovery result**

Replace:

```rust
pub async fn list_climon_ingest_tunnels() -> Vec<DiscoveredHost>
```

with:

```rust
pub async fn list_climon_ingest_tunnels(
    gateway: &DevtunnelGateway
) -> Result<Vec<DiscoveredHost>, DevtunnelFailure>
```

Only successful parsed output returns an empty vector. Update the fan-out caller to
retain explicit targets while recording discovery failure separately.

- [ ] **Step 4: Migrate uplink operations**

Delete local `devtunnel_command`, direct `port list`, and raw auth-output scanning.
Use gateway `connectTunnel` and `listPorts`. Feed typed failures into the retry
controller:

- transient => reconnect with capped backoff;
- actionable => write paused status and wait for explicit/config/probe change;
- direct host => preserve existing reconnect behavior without Dev Tunnels probes.

- [ ] **Step 5: Migrate ingest hosting**

Replace `spawn_devtunnel_host`'s no-op fallback with:

```rust
pub fn spawn_devtunnel_host(
    gateway: &DevtunnelGateway,
    tunnel_id: &str
) -> Result<Box<dyn HostProcess>, DevtunnelFailure>
```

Make `HostProcess` expose the eventual typed exit cause so the ingest supervisor
can retry transient exits and pause actionable exits.

- [ ] **Step 6: Migrate launcher probe**

Remove `detect_devtunnel_sync`. Use a small synchronous wrapper around the shared
gateway probe only where launch planning requires it, preserving the existing
warning for a missing CLI and adding:

```text
climon: remote monitoring is configured, but Dev Tunnels is not signed in. Run `devtunnel user login`, then retry the session.
```

- [ ] **Step 7: Run Rust tests**

Run:

```bash
cd rust && cargo test -p climon-remote discovery uplink ingest -- --nocapture
cargo test -p climon-cli launcher -- --nocapture
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add rust/climon-remote/src/discovery.rs rust/climon-remote/src/uplink.rs rust/climon-remote/src/ingest.rs rust/climon-cli/src/launcher.rs
git commit -m "feat(remote): classify tunnel discovery and process failures"
```

---

### Task 9: Persist dev-tunnel health and render `climon remotes`

**Files:**
- Modify: `rust/climon-remote/src/uplink_status.rs`
- Modify: `rust/climon-remote/src/ingest_status.rs`
- Modify: `rust/climon-remote/src/uplink.rs`
- Modify: `rust/climon-remote/src/ingest.rs`
- Modify: `rust/climon-cli/src/remotes_cmd.rs`

- [ ] **Step 1: Write failing serialization/render tests**

Add a sample `DevtunnelHealth` with a quota failure and assert:

- uplink/ingest JSON uses camelCase and round-trips;
- old status JSON without `devtunnel` still parses via `#[serde(default)]`;
- human output contains friendly summary, code, occurrence time/remediation, and
  "paused";
- human output does not print technical detail by default;
- `--json` includes technical detail;
- transient status prints next retry time.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd rust && cargo test -p climon-remote uplink_status ingest_status -- --nocapture
cargo test -p climon-cli remotes_cmd -- --nocapture
```

Expected: FAIL because status structs do not carry normalized health.

- [ ] **Step 3: Extend status structs compatibly**

Add:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub devtunnel: Option<DevtunnelHealth>,
```

to `UplinkStatus` and `IngestStatus`. Keep `last_error` temporarily for backward
compatibility, populate it from `failure.summary`, and mark its removal out of
scope for this change.

- [ ] **Step 4: Write status on every tunnel transition**

Update the uplink/ingest status writers for:

- starting;
- connected/running success;
- retrying transient failure;
- paused actionable failure;
- stopped/closed.

Use the gateway health snapshot; do not rebuild failure strings at each call site.

- [ ] **Step 5: Render friendly CLI status**

In `render_human`, add a helper:

```rust
fn render_devtunnel_failure(out: &mut String, health: &DevtunnelHealth, now_ms: u64) {
    if let Some(failure) = &health.last_failure {
        out.push_str(&format!("  {} [{}]\n", failure.summary, failure.code.as_str()));
        out.push_str(&format!("  {}\n", failure.remediation));
        if let Some(retry) = &health.retry {
            if retry.paused { out.push_str("  retry: paused\n"); }
            else if let Some(at) = &retry.next_retry_at { out.push_str(&format!("  retry: {at}\n")); }
        }
    }
}
```

Technical details remain available in JSON, satisfying the expandable/detailed CLI
requirement without making raw output the default terminal experience.

- [ ] **Step 6: Run status/CLI tests**

Run:

```bash
cd rust && cargo test -p climon-remote uplink_status ingest_status -- --nocapture
cargo test -p climon-cli remotes_cmd -- --nocapture
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add rust/climon-remote/src/uplink_status.rs rust/climon-remote/src/ingest_status.rs rust/climon-remote/src/uplink.rs rust/climon-remote/src/ingest.rs rust/climon-cli/src/remotes_cmd.rs
git commit -m "feat(remotes): report devtunnel health"
```

---

### Task 10: Remove direct dev-tunnel execution and prove centralization

**Files:**
- Modify: all remaining call sites found by search
- Test: `tests/devtunnel-centralization.test.ts`

- [ ] **Step 1: Add a source-guard test**

Create `tests/devtunnel-centralization.test.ts` that scans maintained source and
fails if `spawn("devtunnel"`, `Command::new("devtunnel")`, or
`tokio::process::Command` construction appears outside:

- `src/devtunnel/`
- `rust/climon-remote/src/devtunnel/`

Permit docs/tests/fixtures. This prevents future policy drift.

- [ ] **Step 2: Run the guard to identify remaining call sites**

Run:

```bash
bun test tests/devtunnel-centralization.test.ts
```

Expected: FAIL and list current direct call sites.

- [ ] **Step 3: Migrate every reported maintained call site**

Expected removals include:

- `src/server/dashboard-tunnel.ts` direct spawn;
- `src/remote/tunnel.ts` direct runner;
- `rust/climon-cli/src/launcher.rs` direct command;
- `rust/climon-remote/src/discovery.rs` direct command;
- `rust/climon-remote/src/uplink.rs` command helper;
- `rust/climon-remote/src/ingest.rs` host command.

Do not edit frozen/deleted legacy modules that are no longer tracked on current
`dev`; the source guard should target maintained paths only.

- [ ] **Step 4: Run the guard and focused suites**

Run:

```bash
bun test tests/devtunnel-centralization.test.ts tests/devtunnel-classify.test.ts tests/devtunnel-gateway.test.ts tests/dashboard-tunnel.test.ts tests/tunnel.test.ts
cd rust && cargo test -p climon-remote devtunnel discovery tunnel uplink ingest -- --nocapture
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/devtunnel-centralization.test.ts src rust
git commit -m "refactor(devtunnel): enforce gateway ownership"
```

---

### Task 11: Update user documentation, feature catalogue, and manual tests

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/troubleshooting.md`
- Modify: `docs/features.md`
- Create: `docs/manual-tests/devtunnel-resilience.md`
- Modify: `docs/manual-tests/README.md`

- [ ] **Step 1: Add the manual-test index entry**

Add:

```markdown
| — | Dev-tunnel resilience — installation, authentication, quota, retry, and status | [devtunnel-resilience.md](devtunnel-resilience.md) |
```

- [ ] **Step 2: Write manual cases**

Create cases using the repository-required shape:

- `DTRS-01` CLI absent: Tunnel Link remains visible and links to GitHub README installation docs.
- `DTRS-02` install CLI while dialog is open, click Retry, observe next state.
- `DTRS-03` logged out: exact login command, manual login, explicit Retry.
- `DTRS-04` account tunnel quota exhausted: friendly too-many-tunnels message,
  `devtunnel list` guidance, no automatic deletion.
- `DTRS-05` HTTP 429: transient retry with capped delay and Retry now.
- `DTRS-06` service/network outage: local dashboard remains available and status
  shows retrying.
- `DTRS-07` persisted tunnel missing: one safe recreate.
- `DTRS-08` host/connect process exit: retry and recovery.
- `DTRS-09` dashboard and `climon remotes --json` expose matching error code/state.
- `DTRS-10` normal Tunnel Link and remote ingest/uplink operation.

Each case must include preconditions, matrix cell, numbered steps, expected result,
platforms, and result-tracking row.

- [ ] **Step 3: Update README and troubleshooting**

Document:

- Tunnel Link is always present;
- Dev Tunnels installation follows the linked README instructions;
- login remains manual with `devtunnel user login`;
- quota cleanup remains manual using `devtunnel list`/`devtunnel delete`;
- Retry behavior and technical details;
- `climon remotes` failure/status output.

- [ ] **Step 4: Update architecture**

Add the runtime-local gateway boundary and shared fixture contract. State precisely:

- Bun owns dashboard and server-side ingest create/port operations;
- Rust owns discovery, connect, and ingest host;
- status beacons/API carry normalized health.

- [ ] **Step 5: Update feature catalogue**

Update existing `srv-09` Tunnel Link and `cli-22`/`cli-25` remote rows. Do not
allocate a new feature ID unless implementation introduces a user-distinct feature
rather than hardening those existing features. Add the new manual-test link and
source paths.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/architecture.md docs/troubleshooting.md docs/features.md docs/manual-tests/devtunnel-resilience.md docs/manual-tests/README.md
git commit -m "docs: document resilient devtunnel behavior"
```

---

### Task 12: Final integration verification

**Files:**
- No new files unless a failure reveals a directly related defect.

- [ ] **Step 1: Format**

Run:

```bash
cd rust && cargo fmt --all -- --check
```

Expected: PASS. If it fails, run `cargo fmt --all`, inspect the diff, and rerun.

- [ ] **Step 2: Run focused Bun tests**

Run:

```bash
bun test \
  tests/devtunnel-classify.test.ts \
  tests/devtunnel-gateway.test.ts \
  tests/devtunnel-centralization.test.ts \
  tests/dashboard-tunnel.test.ts \
  tests/dashboard-tunnel-menu.test.ts \
  tests/devtunnel-failure-ui.test.ts \
  tests/tunnel.test.ts \
  tests/server-remote.test.ts \
  tests/remote-client-dialog.test.ts \
  tests/web-api.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run Bun typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run focused Rust tests**

Run:

```bash
cd rust && cargo test -p climon-remote
cargo test -p climon-cli remotes_cmd
cargo test -p climon-cli launcher
```

Expected: PASS.

- [ ] **Step 5: Run Rust lint**

Run:

```bash
cd rust && cargo clippy -p climon-remote -p climon-cli --all-targets -- -D warnings
```

Expected: PASS.

- [ ] **Step 6: Run the broader relevant suites**

Run:

```bash
bun test tests
cd rust && cargo test
```

Expected: no new failures. If the known full-suite Bun integration timeouts or
known macOS `shutdown_watch` flakes appear, rerun the named test in isolation and
record the base-known flake rather than weakening assertions.

- [ ] **Step 7: Inspect final direct-call search**

Run:

```bash
rg -n 'spawn\\("devtunnel"|Command::new\\("devtunnel"|devtunnel_command' src rust
```

Expected: matches only inside `src/devtunnel/`,
`rust/climon-remote/src/devtunnel/`, or comments/tests explicitly covered by the
centralization guard.

- [ ] **Step 8: Commit any verification-only corrections**

If verification required directly related fixes:

```bash
git add src rust tests fixtures docs README.md
git commit -m "fix(devtunnel): address integration verification"
```

If no corrections were required, do not create an empty commit.
