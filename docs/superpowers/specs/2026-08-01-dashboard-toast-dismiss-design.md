# Dashboard Toast Dismiss Button Design

## Goal

Add an explicit dismiss control to foreground attention toasts in the dashboard
without changing their existing navigation, deduplication, or timeout behavior.

## User Experience

Each foreground attention toast displays a close icon in the title's top-right
action area. Activating the close icon dismisses only that toast. Clicking or
tapping elsewhere on the toast continues to open the originating session and
dismiss the toast.

The toast continues to auto-dismiss after six seconds. Dismissing it does not
acknowledge or clear the session's attention state, suppress future attention
episodes, or affect sound and vibration behavior.

## Implementation

Keep the change local to the existing toast rendering in `src/web/App.tsx`.
Render a Fluent UI subtle, icon-only `Button` through `ToastTitle`'s native
action slot, using the existing `Dismiss20Regular` icon.

The dismiss button handler must:

1. Stop click propagation so the parent toast's open-session handler does not
   run.
2. Call `dismissToast` with the attention episode's stable toast ID.

The parent `Toast` retains its current click handler, pointer cursor, warning
intent, stable ID, and six-second timeout. `src/web/attentionToast.ts` and the
attention alert manager require no data-model or behavior changes.

## Accessibility

The close button uses the accessible label and tooltip text
`Dismiss notification`. It remains keyboard focusable through Fluent UI's
standard `Button` behavior. Keyboard or pointer activation must dismiss the
toast without opening the session.

## Testing

Add focused dashboard component coverage that verifies:

- activating the dismiss button calls toast dismissal and does not open the
  session;
- activating the remaining toast surface still opens the originating session
  and dismisses the toast;
- the dismiss control has the expected accessible label.

Existing attention-toast content and alert-deduplication tests remain unchanged.

Update `docs/manual-tests/foreground-attention-toast.md` to check both explicit
dismissal and preserved toast navigation. Update the `dash-11` entry in
`docs/features.md` to mention that foreground attention toasts are explicitly
dismissible.

## Out of Scope

- Changing toast duration, position, intent, sound, or vibration.
- Changing attention acknowledgement or session state.
- Adding dismiss controls to operating-system push notifications.
- Persisting a user's dismissal across later attention episodes.
