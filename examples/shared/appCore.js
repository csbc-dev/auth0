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
    { name: "lastUpdatedBy", event: "app-core:last-updated-by-changed" },
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
  #lastUpdatedBy;

  constructor(user) {
    super();
    this.#lastUpdatedBy = userLabel(user);
  }

  get count() { return this.#count; }
  get lastUpdatedBy() { return this.#lastUpdatedBy; }

  increment() { this.#count += 1; this.#publishCount(); }
  decrement() { this.#count -= 1; this.#publishCount(); }
  reset()     { this.#count  = 0; this.#publishCount(); }

  // Called by the server's onTokenRefresh hook so refreshed RBAC / email
  // changes propagate to the client without rebuilding the Core.
  updateUser(user) {
    const next = userLabel(user);
    if (next === this.#lastUpdatedBy) return;
    this.#lastUpdatedBy = next;
    this.dispatchEvent(new CustomEvent("app-core:last-updated-by-changed", { detail: next }));
  }

  #publishCount() {
    this.dispatchEvent(new CustomEvent("app-core:count-changed", { detail: this.#count }));
  }
}
