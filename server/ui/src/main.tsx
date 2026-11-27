import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app.js";
import { applyTheme, savedTheme } from "./lib/theme.js";
import "./styles.css";

applyTheme(savedTheme());

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
