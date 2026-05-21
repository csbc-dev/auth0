// Per-user sample Core, universal (Node + browser).
//
// - `appCoreDeclaration` is the wcBindable schema shared by both sides.
// - `AppCore` is the server-side EventTarget Core (instantiated per WS connection).
//
// This file deliberately does NOT reference `HTMLElement` or `customElements`,
// so it loads safely under Node (where the example server imports it).
// The browser-only payload facade lives in `./appCoreFacade.js`.
//
// LIFETIME / STATE PERSISTENCE — IMPORTANT FOR ANYONE BUILDING ON THIS.
// `AppCore` is instantiated by `createCores: user => new AppCore(user)` on
// the server, ONCE per authenticated WebSocket connection. The `count`
// field lives in JS memory inside the instance and is GC'd when the
// WebSocket closes (logout, browser reload, network drop, server restart).
// Reconnection — `AuthShell.reconnect()` or `<auth0-session>`'s
// auto-restart — opens a fresh socket, which gets a fresh `AppCore`, so
// the wire is restored but the count resets to 0. Demo behaviour is
// intentional and matches the architecture diagram ("server-side Core
// per session"). Anything beyond a demo needs an explicit persistence
// layer — typically: write to Redis / Postgres on each command, hydrate
// in `createCores` from the user's `sub`.

export const appCoreDeclaration = {
  protocol: "wc-bindable",
  version: 1,
  properties: [
    { name: "count",         event: "app-core:count-changed" },
    // The authenticated user this per-connection Core belongs to. Set once at
    // construction and refreshed only when the user's claims change via an
    // in-band auth:refresh (see `updateUser`). It is NOT "who last touched the
    // count" — each connection has its own Core, so this is always the
    // connected user. Hence the name `connectedUser`, not `lastUpdatedBy`.
    { name: "connectedUser", event: "app-core:connected-user-changed" },
  ],
  commands: [
    { name: "increment" },
    { name: "decrement" },
    { name: "reset" },
  ],
};

function userLabel(user) {
  return user?.email || user?.sub || "anonymous";
}

export class AppCore extends EventTarget {
  static wcBindable = appCoreDeclaration;

  #count = 0;
  #connectedUser;

  constructor(user) {
    super();
    this.#connectedUser = userLabel(user);
  }

  get count() { return this.#count; }
  get connectedUser() { return this.#connectedUser; }

  increment() { this.#count += 1; this.#publishCount(); }
  decrement() { this.#count -= 1; this.#publishCount(); }
  reset()     { this.#count  = 0; this.#publishCount(); }

  // Called by the server's onTokenRefresh hook so refreshed RBAC / email
  // changes propagate to the client without rebuilding the Core.
  updateUser(user) {
    const next = userLabel(user);
    if (next === this.#connectedUser) return;
    this.#connectedUser = next;
    this.dispatchEvent(new CustomEvent("app-core:connected-user-changed", { detail: next }));
  }

  #publishCount() {
    this.dispatchEvent(new CustomEvent("app-core:count-changed", { detail: this.#count }));
  }
}
