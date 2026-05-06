import React from "react";
import ReactDOM from "react-dom/client";
import { bootstrapAuth } from "@csbc-dev/auth0";
import { defineAppCoreFacade } from "../../shared/appCoreFacade.js";
import App from "./App";

bootstrapAuth();
// `defineAppCoreFacade` is idempotent (HMR-safe) and shares the wcBindable
// declaration with the server-side AppCore via the universal `appCore.js`
// module — single source of truth across both sides of the wire.
defineAppCoreFacade();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
