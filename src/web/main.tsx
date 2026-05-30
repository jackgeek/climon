import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FluentProvider, webDarkTheme } from "@fluentui/react-components";
import { App } from "./App.js";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Missing #root element");
}

createRoot(container).render(
  <StrictMode>
    <FluentProvider theme={webDarkTheme} style={{ height: "100%" }}>
      <App />
    </FluentProvider>
  </StrictMode>
);
