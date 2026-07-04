# Foreground attention toast (in-app, instead of system notification)

These cases prove that while the climon dashboard is open in the foreground, a
session entering `needs-attention` raises a **subtle in-app toast** at the top
of the viewport (`<session name> needs attention`) with sound and vibration —
instead of an OS/system notification — and that tapping the toast opens the
session. System (push) notifications are reserved for when the dashboard is
hidden/backgrounded or closed.

Implementation: `src/web/attentionAlerts.ts` (manager fires `onAttention` +
sound + vibration, gated by `alertsVisible`), `src/web/attentionToast.ts`
(toast content — title `<session name> needs attention`, terminal title as a
second line), the Fluent `Toaster` wiring in `src/web/App.tsx`, and **per-device
server-side push suppression**: the client presence reporter
(`src/web/pwa/presence.ts`, wired in `App.tsx`) POSTs `/api/push/presence`, and
the server's `src/server/push/presence.ts` skips foreground endpoints when
sending. The service worker (`src/web/pwa/swPush.ts` / `src/web/sw.ts`) now
**always** shows a notification for every push (iOS/WebKit requires it).
See the [design spec](../superpowers/specs/2026-07-04-ios-safe-push-suppression-design.md).

Preconditions common to all cases:

- At least two sessions exist; one is driven into `needs-attention` during the
  test (e.g. a command that waits on input or prints the attention marker).
- For the push cases (banner while backgrounded), the dashboard is reachable
  over a **tunnel origin** (HTTPS) with the PWA installed and notifications
  granted — push is not used on plain `localhost`.

---

## MT-FG-TOAST-01 — Toast on desktop while viewing another session

- **ID:** MT-FG-TOAST-01
- **Feature:** Foreground attention toast
- **Preconditions:** Common preconditions; desktop browser, dashboard focused,
  viewing session B (sidebar list visible alongside).
- **Config-matrix cell:** desktop browser tab, foreground
- **Platforms:** Desktop (Chrome/Edge/Firefox)

**Steps:**
1. Keep the dashboard focused on session B.
2. Drive session A into `needs-attention`.

**Expected result:** A subtle toast `A needs attention` (with session A's
terminal title on a second line) appears at the top of the viewport with a sound
(and vibration if the device supports it). **No** OS notification banner appears.
Tapping the toast switches to session A's terminal.

**Result tracking:** | Version | Date | Tester | Platform | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |

---

## MT-FG-TOAST-02 — Toast on mobile while viewing another session

- **ID:** MT-FG-TOAST-02
- **Feature:** Foreground attention toast
- **Preconditions:** Common preconditions; mobile PWA/browser, maximized into
  session B (not the session list).
- **Config-matrix cell:** mobile, foreground, session maximized
- **Platforms:** Android (Chrome/PWA), iOS (Safari/PWA)

**Steps:**
1. Open session B (maximized terminal).
2. Drive session A into `needs-attention`.

**Expected result:** A toast `A needs attention` appears at the top with sound +
vibration; no system notification. Tapping it opens session A's terminal.

**Result tracking:** | Version | Date | Tester | Platform | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |

---

## MT-FG-TOAST-03 — No toast while viewing the attentive session

- **ID:** MT-FG-TOAST-03
- **Feature:** Foreground attention toast
- **Preconditions:** Common preconditions; actively viewing session A.
- **Config-matrix cell:** foreground, viewing the attentive session
- **Platforms:** Desktop; mobile (maximized)

**Steps:**
1. Open/focus session A's terminal.
2. Drive session A into `needs-attention`.

**Expected result:** No toast, sound, vibration, or system notification — the
user is already looking at the session (and it auto-acknowledges).

**Result tracking:** | Version | Date | Tester | Platform | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |

---

## MT-FG-TOAST-04 — No toast on the mobile session list

- **ID:** MT-FG-TOAST-04
- **Feature:** Foreground attention toast
- **Preconditions:** Common preconditions; mobile, on the session list (not
  maximized into any session).
- **Config-matrix cell:** mobile, foreground, session list
- **Platforms:** Android (Chrome/PWA), iOS (Safari/PWA)

**Steps:**
1. Stay on the mobile session list.
2. Drive session A into `needs-attention`.

**Expected result:** No toast (and no system notification) — the list already
shows session A's attention badge, which updates visibly.

**Result tracking:** | Version | Date | Tester | Platform | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |

---

## MT-FG-TOAST-05 — System notification only when backgrounded/closed

- **ID:** MT-FG-TOAST-05
- **Feature:** Foreground toast vs. background push
- **Preconditions:** Common push preconditions (tunnel origin, installed PWA,
  notifications granted).
- **Config-matrix cell:** installed PWA, tunnel origin (push)
- **Platforms:** Android (Chrome PWA), iOS (Safari PWA)

**Steps:**
1. With the PWA foreground, drive session A into `needs-attention` — observe a
   toast, no system banner.
2. Background or close the PWA, then drive session B into `needs-attention`.

**Expected result:** Step 1 shows only the in-app toast. Step 2 shows an OS
notification titled `B needs attention` with session B's terminal title as the
body (no toast, since the app is not foreground). Tapping it opens session B (see
`pwa-notification-click.md`).

**Result tracking:** | Version | Date | Tester | Platform | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |

---

## MT-FG-TOAST-06 — iOS PWA: exactly one notification, no generic fallback banner

- **ID:** MT-FG-TOAST-06
- **Feature:** iOS-safe push (service worker always shows)
- **Preconditions:** Common push preconditions on an **iOS/iPadOS** installed
  Safari PWA (notifications granted). The PWA is backgrounded or the device is
  locked so a push is delivered.
- **Config-matrix cell:** iOS installed PWA, backgrounded (push)
- **Platforms:** iOS/iPadOS (Safari PWA)

**Steps:**
1. Background the PWA (or lock the device).
2. Drive session A into `needs-attention`.

**Expected result:** Exactly **one** OS notification appears, titled
`A needs attention` with session A's terminal title as the body. There is **no**
second generic/empty "climon" banner, and the push subscription is **not**
revoked (a subsequent attention event still delivers a push). This confirms the
service worker calls `showNotification` for the push rather than silently
dropping it.

**Result tracking:** | Version | Date | Tester | Platform | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |

---

## MT-FG-TOAST-07 — Multi-device: foreground device toasts, other device still gets push

- **ID:** MT-FG-TOAST-07
- **Feature:** Per-device server-side push suppression
- **Preconditions:** Common push preconditions. **Two** devices are subscribed to
  push for the same climon server (e.g. a desktop browser and a phone PWA), both
  with notifications granted.
- **Config-matrix cell:** two subscribed devices, one foreground + one backgrounded
- **Platforms:** Desktop + Android/iOS phone (mixed)

**Steps:**
1. Keep device 1 (desktop) foreground on the dashboard (not viewing session A).
2. Background device 2 (phone) so it is not foreground.
3. Drive session A into `needs-attention`.

**Expected result:** Device 1 (foreground) shows only the in-app toast and **no**
OS notification. Device 2 (backgrounded) receives the OS push
`A needs attention`. Suppression is keyed per push-subscription endpoint via the
presence heartbeat, so foregrounding one device never suppresses another.

**Result tracking:** | Version | Date | Tester | Platform | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |
