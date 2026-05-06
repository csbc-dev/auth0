// Per-user sample Core, universal (Node + browser).
//
// - `appCoreDeclaration` is the wcBindable schema shared by both sides.
// - `AppCore` is the server-side EventTarget Core (instantiated per WS connection).
//
// This file deliberately does NOT reference `HTMLElement` or `customElements`,
// so it loads safely under Node (where the example server imports it).
// The browser-only payload facade lives in `./appCoreFacade.js`.

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
