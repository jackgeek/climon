# Tunnel-link expiry countdown banner

Manual checks for the fixed-top banner that counts down to the dev tunnel's
expiry when the dashboard is opened through the Tunnel Link (not loopback).

## TEB-1 — Countdown appears on the tunnel origin

- **Feature:** Tunnel-link expiry countdown banner
- **Preconditions:** `devtunnel` CLI installed and logged in. Start `climon-server`,
  enable the Tunnel Link (sidebar menu → Tunnel Link), and open the
  `https://<id>-<port>.<region>.devtunnels.ms/` URL on any device.
- **Config-matrix cell:** Access = dev tunnel URL (HTTPS).
- **Steps:**
  1. Open the tunnel URL in a browser.
  2. Observe the top of the dashboard.
- **Expected result:** A slim info-colored bar at the very top reads
  `Tunnel link expires in NNd NNh NNm` (≈ 30 days). It is not dismissible.
- **Platforms:** Desktop Chrome/Firefox/Safari, mobile Safari/Chrome.
- **Result:** _date / tester / platform / pass-fail / notes_

## TEB-2 — Banner is absent on loopback

- **Feature:** Tunnel-link expiry countdown banner
- **Preconditions:** `climon-server` running; Tunnel Link may be on or off.
- **Config-matrix cell:** Access = `http://localhost:<port>/` (loopback).
- **Steps:**
  1. Open the dashboard at its `localhost` URL.
- **Expected result:** No expiry countdown banner is shown.
- **Platforms:** Desktop Chrome/Firefox/Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## TEB-3 — Warning style under one hour

- **Feature:** Tunnel-link expiry countdown banner
- **Preconditions:** A tunnel whose expiry is under one hour away. Easiest via a
  short-lived/expiring tunnel, or temporarily override the value (e.g. patch the
  server `expiresAt` to `Date.now() + 90s` in a dev build) to exercise the UI.
- **Config-matrix cell:** Access = dev tunnel URL (HTTPS); remaining < 1 hour.
- **Steps:**
  1. Open the tunnel URL with under an hour remaining.
  2. Watch the banner tick.
- **Expected result:** The bar turns yellow and shows minutes **and** seconds,
  e.g. `Tunnel link expires in 04m 32s`, counting down each second.
- **Platforms:** Desktop Chrome/Firefox/Safari.
- **Result:** _date / tester / platform / pass-fail / notes_

## TEB-4 — Expired state

- **Feature:** Tunnel-link expiry countdown banner
- **Preconditions:** As TEB-3, but let the countdown reach zero (or override
  `expiresAt` to a past timestamp).
- **Config-matrix cell:** Access = dev tunnel URL (HTTPS); remaining <= 0.
- **Steps:**
  1. Keep the tunnel page open until the countdown reaches zero.
- **Expected result:** The bar turns red and reads `Tunnel link expired`. (The
  existing health-probe "tunnel down" banner may also appear in an installed PWA.)
- **Platforms:** Desktop Chrome/Firefox/Safari.
- **Result:** _date / tester / platform / pass-fail / notes_
