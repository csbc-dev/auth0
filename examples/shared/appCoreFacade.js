// Browser-only payload facade for `<auth0-session>`.
//
// `AppCoreFacade` is a schema-only HTMLElement subclass: its only job is to
// carry the same `wcBindable` declaration as the server-side `AppCore` so
// that <auth0-session> can adopt it as the data-plane child. <auth0-session>
// installs:
//
//   - own-property mirrors for `count` / `lastUpdatedBy` (updated on every
//     proxy event) plus a re-dispatch of the user-declared events on the
//     element, so `bind(facade, ...)` and `data-wcs="prop: ..."` work
//     directly against the element with no proxy bridging.
//   - own-property command forwarders for `increment` / `decrement` /
//     `reset` that delegate to `proxy.invoke(...)` and return its promise.
//
// The user's element class needs no methods, no constructor logic, and no
// shadow DOM. Adding any of those is fine — the session only writes
// own-properties for the schema's declared names, leaves anything else
// alone, and undoes its writes on teardown via identity comparison.

import { appCoreDeclaration } from "./appCore.js";

export class AppCoreFacade extends HTMLElement {
  static wcBindable = appCoreDeclaration;
}

/**
 * Idempotently register `AppCoreFacade` under a tag name. Safe to call from
 * multiple bootstrap paths and HMR cycles — the second call is a no-op
 * when the same tag is already defined.
 *
 * Default tag is `app-core-facade`. Pick a different one when an example
 * needs to coexist with another that has already claimed the default.
 */
export function defineAppCoreFacade(tag = "app-core-facade") {
  if (!customElements.get(tag)) {
    customElements.define(tag, AppCoreFacade);
  }
}
