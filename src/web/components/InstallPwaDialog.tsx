import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Text
} from "@fluentui/react-components";
import { detectPwaPlatform, pwaInstallInstructions, type PwaPlatform } from "../pwa/install.js";

interface Props {
  open: boolean;
  /** Present only on Chromium/Android, where a programmatic install is possible. */
  canPrompt: boolean;
  onOpenChange: (open: boolean) => void;
  onInstall: () => void;
  userAgent?: string;
}

export function InstallPwaDialog({ open, canPrompt, onOpenChange, onInstall, userAgent }: Props) {
  const platform: PwaPlatform = detectPwaPlatform(userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : ""));
  return (
    <Dialog open={open} onOpenChange={(_, data) => onOpenChange(data.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Install climon as an app</DialogTitle>
          <DialogContent>
            <Text as="p">
              This installs climon for the current Tunnel Link so your phone can show
              notifications when a session needs attention.
            </Text>
            <Text as="p" weight="semibold">
              This install is temporary. It only works while this Tunnel Link is up.
              When the tunnel closes, the app stops working — long-press its icon and
              choose Uninstall.
            </Text>
            <Text as="p">{pwaInstallInstructions(platform)}</Text>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            {canPrompt && (
              <Button appearance="primary" onClick={onInstall}>
                Install
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
