// Example server for @csbc-dev/auth0 remote mode.
//
// All the HTTP plumbing (env validation, CORS, the /auth-config config
// endpoint, the /_shared/ static mount, WebSocket auth, and the keepalive
// heartbeat) lives in `createExampleServer.js`, composed from three
// package primitives: `createAuthenticatedWSS({ server })`,
// `createAuthConfigHandler`, and the `heartbeatMs` option. This file just
// supplies the application Core factory.
//
// See createExampleServer.js for the wiring, and
// docs/patterns/server-config-discovery.md for the config-discovery pattern.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createExampleServer } from "./createExampleServer.js";
import { AppCore } from "../shared/appCore.js";

// Directory of shared browser modules served over `/_shared/`. The buildless
// wcstack-state example loads `/_shared/appCoreFacade.auto.js` from here, which
// defines <app-core-facade> from the same `appCoreDeclaration` this server's
// `AppCore` uses — a single source of truth, no hand-written HTML duplicate.
const SHARED_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../shared");

await createExampleServer({
  createCores: (user) => new AppCore(user),
  // Propagate refreshed claims into the per-connection Core after an
  // in-band auth:refresh. AppCore.updateUser is a single-call atomic update.
  onTokenRefresh: (core, user) => core.updateUser(user),
  sharedDir: SHARED_DIR,
});
