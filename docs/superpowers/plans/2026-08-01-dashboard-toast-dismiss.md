# Dashboard Toast Dismiss Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an accessible close button to foreground dashboard attention toasts while preserving toast-body navigation and automatic timeout behavior.

**Architecture:** Extract the rendered Fluent UI toast into a focused `AttentionToastView` component while leaving attention detection and toast data construction unchanged. The component owns the two interaction paths: its close action stops propagation and dismisses only the toast, while clicking the remaining toast surface opens the session and dismisses the toast.

**Tech Stack:** React 19, Fluent UI React Components v9, TypeScript, Bun test, React server rendering

---

## File Structure

- Create `src/web/components/AttentionToastView.tsx` to render the Fluent toast and define its open/dismiss interaction helpers.
- Create `tests/attention-toast-view.test.ts` to cover accessible rendering and both interaction paths without requiring a browser DOM.
- Modify `src/web/App.tsx` to dispatch `AttentionToastView` instead of assembling toast markup inline.
- Modify `docs/manual-tests/foreground-attention-toast.md` to add a manual explicit-dismiss case.
- Modify `docs/features.md` to describe the dismissible foreground toast behavior.

### Task 1: Add the dismissible attention toast component

**Files:**
- Create: `src/web/components/AttentionToastView.tsx`
- Create: `tests/attention-toast-view.test.ts`
- Modify: `src/web/App.tsx:1-28`
- Modify: `src/web/App.tsx:820-838`

- [ ] **Step 1: Write the failing component and interaction tests**

Create `tests/attention-toast-view.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AttentionToastView,
  dismissAttentionToast,
  openAttentionToast
} from "../src/web/components/AttentionToastView.js";
import type { AttentionToast } from "../src/web/attentionToast.js";

const toast: AttentionToast = {
  toastId: "sess-1:t1",
  message: "API server needs attention",
  body: "Saved. Run tests?",
  sessionId: "sess-1"
};

describe("AttentionToastView", () => {
  test("renders an accessible dismiss button", () => {
    const markup = renderToStaticMarkup(
      createElement(AttentionToastView, {
        toast,
        onOpen: () => undefined,
        onDismiss: () => undefined
      })
    );

    expect(markup).toContain('aria-label="Dismiss notification"');
    expect(markup).toContain('title="Dismiss notification"');
    expect(markup).toContain("API server needs attention");
    expect(markup).toContain("Saved. Run tests?");
  });

  test("dismiss stops toast navigation and dismisses only the toast", () => {
    let propagationStopped = false;
    const dismissed: string[] = [];
    const event = {
      stopPropagation: () => {
        propagationStopped = true;
      }
    };

    dismissAttentionToast(event, toast.toastId, (toastId) => dismissed.push(toastId));

    expect(propagationStopped).toBe(true);
    expect(dismissed).toEqual(["sess-1:t1"]);
  });

  test("opening the toast opens the session and dismisses the toast", () => {
    const opened: string[] = [];
    const dismissed: string[] = [];

    openAttentionToast(
      toast,
      (sessionId) => opened.push(sessionId),
      (toastId) => dismissed.push(toastId)
    );

    expect(opened).toEqual(["sess-1"]);
    expect(dismissed).toEqual(["sess-1:t1"]);
  });
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run:

```bash
bun test tests/attention-toast-view.test.ts
```

Expected: FAIL because `src/web/components/AttentionToastView.tsx` does not exist.

- [ ] **Step 3: Implement the focused toast component**

Create `src/web/components/AttentionToastView.tsx`:

```tsx
import {
  Button,
  Toast,
  ToastBody,
  ToastTitle
} from "@fluentui/react-components";
import { Dismiss20Regular } from "@fluentui/react-icons";
import type { AttentionToast } from "../attentionToast.js";

interface StopPropagationEvent {
  stopPropagation: () => void;
}

export interface AttentionToastViewProps {
  toast: AttentionToast;
  onOpen: (sessionId: string) => void;
  onDismiss: (toastId: string) => void;
}

export function dismissAttentionToast(
  event: StopPropagationEvent,
  toastId: string,
  onDismiss: (toastId: string) => void
): void {
  event.stopPropagation();
  onDismiss(toastId);
}

export function openAttentionToast(
  toast: AttentionToast,
  onOpen: (sessionId: string) => void,
  onDismiss: (toastId: string) => void
): void {
  onOpen(toast.sessionId);
  onDismiss(toast.toastId);
}

export function AttentionToastView({
  toast,
  onOpen,
  onDismiss
}: AttentionToastViewProps) {
  return (
    <Toast
      onClick={() => openAttentionToast(toast, onOpen, onDismiss)}
      style={{ cursor: "pointer" }}
    >
      <ToastTitle
        action={
          <Button
            appearance="subtle"
            size="small"
            icon={<Dismiss20Regular />}
            aria-label="Dismiss notification"
            title="Dismiss notification"
            onClick={(event) =>
              dismissAttentionToast(event, toast.toastId, onDismiss)
            }
          />
        }
      >
        {toast.message}
      </ToastTitle>
      {toast.body ? <ToastBody>{toast.body}</ToastBody> : null}
    </Toast>
  );
}
```

- [ ] **Step 4: Wire the component into the dashboard dispatcher**

In `src/web/App.tsx`, remove `Toast`, `ToastBody`, and `ToastTitle` from the
`@fluentui/react-components` import. Keep `Button`, `Toaster`,
`useToastController`, and `Dismiss20Regular`, because they are used elsewhere.

Add this import beside the existing attention-toast imports:

```ts
import { AttentionToastView } from "./components/AttentionToastView.js";
```

Replace the inline toast passed to `dispatchToast` with:

```tsx
      dispatchToast(
        <AttentionToastView
          toast={toast}
          onOpen={popSession}
          onDismiss={dismissToast}
        />,
        { toastId: toast.toastId, intent: "warning", timeout: 6000 }
      );
```

Do not change the callback dependencies:

```ts
    [dispatchToast, dismissToast, popSession]
```

- [ ] **Step 5: Run focused tests and type-check**

Run:

```bash
bun test tests/attention-toast-view.test.ts tests/attention-toast.test.ts tests/attention-alerts.test.ts
bun run typecheck
```

Expected: all selected tests PASS and TypeScript exits with code 0.

- [ ] **Step 6: Commit the component change**

```bash
git add src/web/components/AttentionToastView.tsx src/web/App.tsx tests/attention-toast-view.test.ts
git commit -m "feat: add dashboard toast dismiss button" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 84d8f689-4dd2-477a-8457-5238f962a4da"
```

### Task 2: Document explicit toast dismissal

**Files:**
- Modify: `docs/manual-tests/foreground-attention-toast.md`
- Modify: `docs/features.md:123`

- [ ] **Step 1: Add the manual dismiss and navigation case**

Append this case to `docs/manual-tests/foreground-attention-toast.md` before
the file's final result summary, if present:

```md
---

## MT-FG-TOAST-08 — Explicit dismiss does not open the session

- **ID:** MT-FG-TOAST-08
- **Feature:** Foreground attention toast dismissal
- **Preconditions:** Common preconditions; dashboard focused, viewing session B.
- **Config-matrix cell:** foreground, desktop and mobile
- **Platforms:** Desktop browsers; Android and iOS browser/PWA

**Steps:**
1. Drive session A into `needs-attention`.
2. Activate the toast's `Dismiss notification` close button.
3. Confirm session B remains open and the toast disappears.
4. Trigger a new attention episode for session A.
5. Tap or click the toast anywhere except its close button.

**Expected result:** Step 2 dismisses only the toast: it does not open session A
or clear session A's attention state. A later attention episode can produce a
new toast. Step 5 opens session A and dismisses that toast. If neither action is
taken, the toast still disappears automatically after six seconds.

**Result tracking:** | Version | Date | Tester | Platform | Pass/Fail | Notes |
| --- | --- | --- | --- | --- | --- |
```

- [ ] **Step 2: Update the dashboard feature catalogue**

Replace the `dash-11` row in `docs/features.md` with:

```md
| dash-11 | Foreground attention toast | While the dashboard is in the foreground, a subtle, explicitly dismissible Fluent toast (with sound + vibration) announces a session needing attention; clicking the toast opens the session, while its close button dismisses without navigation. Toasts are suppressed for the session you're viewing. | Get a gentle in-app nudge about another session without a jarring system notification while you're already working in the dashboard, and dismiss it without leaving your current session. | [manual-tests/foreground-attention-toast.md](manual-tests/foreground-attention-toast.md); `src/web/attentionAlerts.ts`, `src/web/attentionToast.ts`, `src/web/components/AttentionToastView.tsx` |
```

- [ ] **Step 3: Check documentation formatting**

Run:

```bash
git diff --check -- docs/manual-tests/foreground-attention-toast.md docs/features.md
```

Expected: no output and exit code 0.

- [ ] **Step 4: Commit the documentation**

```bash
git add docs/manual-tests/foreground-attention-toast.md docs/features.md
git commit -m "docs: cover dismissible attention toasts" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 84d8f689-4dd2-477a-8457-5238f962a4da"
```

### Task 3: Verify the completed behavior

**Files:**
- Verify: `src/web/components/AttentionToastView.tsx`
- Verify: `src/web/App.tsx`
- Verify: `tests/attention-toast-view.test.ts`
- Verify: `docs/manual-tests/foreground-attention-toast.md`
- Verify: `docs/features.md`

- [ ] **Step 1: Run the complete relevant test set**

```bash
bun test tests/attention-toast-view.test.ts tests/attention-toast.test.ts tests/attention-alerts.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 2: Run the repository TypeScript check**

```bash
bun run typecheck
```

Expected: TypeScript exits with code 0.

- [ ] **Step 3: Build the dashboard bundle**

```bash
bun run build:web
```

Expected: the web bundle builds successfully.

- [ ] **Step 4: Confirm the final diff is scoped**

```bash
git status --short
git diff --check HEAD~2..HEAD
```

Expected: only the pre-existing unrelated worktree changes remain unstaged;
the two implementation commits contain the toast component, its tests, and the
two documentation updates, with no whitespace errors.
