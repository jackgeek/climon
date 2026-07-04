# PWA notification click — open originating session

These cases prove that tapping an attention **push** notification opens the
climon PWA on the terminal of the session that raised it, regardless of whether
the PWA was closed, backgrounded, or in the foreground. The fix lives in
`src/web/pwa/swPush.ts` (`resolveNotificationClick`) and the `notificationclick`
handler in `src/web/sw.ts`. See the
[design spec](../superpowers/specs/2026-06-21-pwa-notification-click-session-design.md).

Preconditions common to all cases:

- climon dashboard reachable over a **tunnel origin** (HTTPS) so web push is
  available — push is not used on plain `localhost`.
- The PWA is installed on the test device and notifications are granted.
- At least two sessions exist; one is driven into `needs-attention` during the
  test (e.g. a command that prints the attention marker / waits on input).

---

## MT-PWA-CLICK-01 — Tap with the PWA fully closed

- **ID:** MT-PWA-CLICK-01
- **Feature:** PWA notification click → originating session
- **Preconditions:** Common preconditions; PWA fully closed (swiped away).
- **Config-matrix cell:** installed PWA, tunnel origin (push)
- **Platforms:** Android (Chrome PWA), iOS (Safari PWA)

**Steps:**
1. Fully close the PWA (remove from the recents/app switcher).
2. Drive session A into `needs-attention` and wait for the push notification.
3. Tap the notification.

**Expected result:** The PWA launches and lands directly on session A's
terminal (maximized on mobile), not the session list.

**Result tracking:** | Version | Date | Tester | Platform | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |

---

## MT-PWA-CLICK-02 — Tap with the PWA backgrounded

- **ID:** MT-PWA-CLICK-02
- **Feature:** PWA notification click → originating session
- **Preconditions:** Common preconditions; PWA open then sent to the background
  (home button / app switch) while showing the session list or a different
  session.
- **Config-matrix cell:** installed PWA, tunnel origin (push)
- **Platforms:** Android (Chrome PWA), iOS (Safari PWA)

**Steps:**
1. Open the PWA, navigate to the session list (or session B), then background it.
2. Drive session A into `needs-attention` and wait for the push notification.
3. Tap the notification.

**Expected result:** The PWA returns to the foreground on session A's terminal,
not on the previously shown list/session B.

**Result tracking:** | Version | Date | Tester | Platform | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |

---

## MT-PWA-CLICK-03 — Tap with the PWA in the foreground

- **ID:** MT-PWA-CLICK-03
- **Feature:** PWA notification click → originating session
- **Preconditions:** Common preconditions; PWA open and visible on the session
  list or session B (not viewing session A).
- **Config-matrix cell:** installed PWA, tunnel origin (push)
- **Platforms:** Android (Chrome PWA), iOS (Safari PWA)

**Steps:**
1. Keep the PWA in the foreground on the session list or session B.
2. Drive session A into `needs-attention`.

**Expected result:** While the PWA is in the foreground the system push banner
is **suppressed**; instead an in-app toast `A needs attention` appears (see
`foreground-attention-toast.md`). Tapping the toast switches to session A's
terminal immediately without a full reload (live terminal state for other
sessions is preserved).

**Result tracking:** | Version | Date | Tester | Platform | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |
