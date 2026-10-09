import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import App from "./App";
import { DraftStartup } from "./components/DraftStartup";
import { StorageStartup } from "./components/StorageRecovery";
import "./styles.css";
import "./styles-settings.css";
import "./styles-content.css";
import "./styles-thread.css";
import "./styles-artifact.css";
import "./product-shell.css";
import "./conversation-workspace.css";
import "./history-import.css";
import "./desktop-workbench.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StorageStartup>
      <DraftStartup>
        <App />
      </DraftStartup>
    </StorageStartup>
  </StrictMode>,
);
