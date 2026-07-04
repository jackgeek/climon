import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { registerServiceWorker } from "./pwa/push.js";

// Lock the PWA to a 1:1 view. The viewport meta (user-scalable=no) handles most
// browsers, but iOS Safari ignores it and instead emits non-standard
// `gesture*` events for pinch-zoom, so we cancel those explicitly. We also
// cancel multi-touch `touchmove` to stop pinch-zoom on browsers that honour
// neither, while leaving single-finger touches (taps, swipes, internal
// scrolling) untouched.
function lockPageZoom() {
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
  }
  document.addEventListener(
    "touchmove",
    (event) => {
      if (event.touches.length > 1) {
        event.preventDefault();
      }
    },
    { passive: false }
  );
}

lockPageZoom();

// Register the service worker on every load (not just on push opt-in) so its
// app-shell cache is active for future cold starts. Best-effort: a failed
// registration must not block the dashboard from rendering.
if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  void registerServiceWorker().catch(() => {});
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("Missing #root element");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
