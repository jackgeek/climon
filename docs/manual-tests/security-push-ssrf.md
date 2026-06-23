# Security — Web Push endpoint SSRF guard

These checks prove that tunnel-reachable push subscription writes cannot register
an internal HTTPS endpoint that the home machine would later contact via
`web-push`, while normal browser push subscriptions still work.

Preconditions common to all cases:

- climon dashboard server running with push enabled and reachable over an HTTPS
  tunnel origin.
- Know the tunnel origin, for example `https://example.devtunnels.ms`.
- For delivery checks, use a browser/PWA profile where notifications can be
  granted.

---

## MT-PUSH-SSRF-01 — Internal IP-literal subscription is rejected

- **ID:** MT-PUSH-SSRF-01
- **Feature:** Web Push endpoint SSRF guard
- **Preconditions:** Common preconditions; same-origin request headers available.
- **Config-matrix cell:** Remote = dev tunnel; Endpoint = internal IPv4 literal.
- **Platforms:** macOS, Linux, Windows host; any tunnel-capable browser/device.

**Steps:**
1. Send a same-origin JSON request to the tunnel URL:
   ```sh
   curl -i "$TUNNEL_ORIGIN/api/push/subscribe" \
     -H "Content-Type: application/json" \
     -H "Origin: $TUNNEL_ORIGIN" \
     -H "Host: ${TUNNEL_ORIGIN#https://}" \
     --data '{"endpoint":"https://10.0.0.5/x","keys":{"p256dh":"a","auth":"b"}}'
   ```
2. Inspect `$CLIMON_HOME/push/subscriptions.json` if it exists.

**Expected result:** The server returns HTTP 400 `Invalid subscription` (or
otherwise ignores the write) and the internal endpoint is not stored.

**Result tracking:** | Version | Date | Tester | Platform | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |

---

## MT-PUSH-SSRF-02 — Real browser push subscription still registers

- **ID:** MT-PUSH-SSRF-02
- **Feature:** Web Push endpoint SSRF guard
- **Preconditions:** Common preconditions; notifications not yet blocked for the
  tunnel origin.
- **Config-matrix cell:** Remote = dev tunnel; Browser push service = public
  HTTPS DNS endpoint.
- **Platforms:** Android Chrome PWA, iOS Safari PWA, desktop Chrome/Firefox.

**Steps:**
1. Open the dashboard over the tunnel origin.
2. Grant notification permission and enable push notifications from the dashboard
   UI/PWA flow.
3. Inspect the network response for `POST /api/push/subscribe` or inspect
   `$CLIMON_HOME/push/subscriptions.json`.

**Expected result:** The subscription succeeds (HTTP 204). The stored endpoint is
an `https:` URL using a public DNS hostname from the browser push service, not an
internal IP literal.

**Result tracking:** | Version | Date | Tester | Platform | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |

---

## MT-PUSH-SSRF-03 — Attention push still delivers after validation

- **ID:** MT-PUSH-SSRF-03
- **Feature:** Web Push endpoint SSRF guard
- **Preconditions:** MT-PUSH-SSRF-02 has passed; at least one climon session is
  available to drive into `needs-attention`.
- **Config-matrix cell:** Remote = dev tunnel; Notification delivery = browser
  push service.
- **Platforms:** Android Chrome PWA, iOS Safari PWA, desktop Chrome/Firefox.

**Steps:**
1. With the valid browser push subscription registered, leave the dashboard/PWA
   not actively viewing the target session.
2. Drive a session into `needs-attention`.
3. Wait for the browser/device notification.

**Expected result:** The attention notification is delivered normally and still
contains only the dashboard-visible session label/reason.

**Result tracking:** | Version | Date | Tester | Platform | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |
