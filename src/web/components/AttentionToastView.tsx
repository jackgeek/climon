import { Button, Toast, ToastBody, ToastTitle } from "@fluentui/react-components";
import { Dismiss20Regular } from "@fluentui/react-icons";
import type { AttentionToast } from "../attentionToast.js";

export interface StopPropagationEvent {
  stopPropagation: () => void;
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

export interface AttentionToastViewProps {
  toast: AttentionToast;
  onOpen: (sessionId: string) => void;
  onDismiss: (toastId: string) => void;
}

export function AttentionToastView({ toast, onOpen, onDismiss }: AttentionToastViewProps) {
  return (
    <Toast onClick={() => openAttentionToast(toast, onOpen, onDismiss)} style={{ cursor: "pointer" }}>
      <ToastTitle
        action={
          <Button
            appearance="subtle"
            size="small"
            aria-label="Dismiss notification"
            title="Dismiss notification"
            icon={<Dismiss20Regular />}
            onClick={(event) => dismissAttentionToast(event, toast.toastId, onDismiss)}
          />
        }
      >
        {toast.message}
      </ToastTitle>
      {toast.body ? <ToastBody>{toast.body}</ToastBody> : null}
    </Toast>
  );
}
