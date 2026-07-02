# Security Policy

We take the security of climon seriously — remote-client support makes it a
network-facing tool, and its threat model is documented in detail in
[docs/security.md](docs/security.md).

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, report them privately through GitHub's built-in private vulnerability
reporting:

1. Go to the **Security** tab of the
   [jackgeek/climon](https://github.com/jackgeek/climon/security/advisories/new)
   repository.
2. Click **Report a vulnerability** to open a private security advisory.

If you are unable to use GitHub Security Advisories, contact the maintainer
[@jackgeek](https://github.com/jackgeek) privately to arrange a disclosure
channel.

Please include, where possible:

- A description of the vulnerability and its impact.
- Steps to reproduce (a proof of concept if you have one).
- The affected version (`climon --version`) and platform.
- Any suggested mitigation.

We will acknowledge your report, keep you updated on progress, and credit you in
the advisory once a fix ships (unless you prefer to remain anonymous).

## Supported versions

Only the latest released version of climon receives security fixes. Please
upgrade to the newest release before reporting, and confirm the issue still
reproduces there.

| Version | Supported |
|---|---|
| Latest release | ✅ |
| Older releases | ❌ |

## Scope

The remote/uplink/ingest trust boundaries, dashboard server hardening, managed
file integrity, and non-destructive update guarantees are all described in
[docs/security.md](docs/security.md). Reports that demonstrate a bypass of any
control documented there are especially valuable.
