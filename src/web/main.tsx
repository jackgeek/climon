import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

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

const container = document.getElementById("root");
if (!container) {
  throw new Error("Missing #root element");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
