/**
 * pino redaction config. Censors secrets (auth tokens, tunnel credentials,
 * App Insights connection strings) to `[REDACTED]` in all log records.
 */
export const REDACT_OPTIONS = {
  paths: [
    "connectionString",
    "*.connectionString",
    "authorization",
    "*.authorization",
    "password",
    "*.password",
    "token",
    "*.token",
    "auth",
    "*.auth",
    "accessToken",
    "*.accessToken",
    "tunnelToken",
    "*.tunnelToken",
  ],
  censor: "[REDACTED]",
};
