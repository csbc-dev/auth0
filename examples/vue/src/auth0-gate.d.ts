// Augment Vue's GlobalComponents so the template type-checker accepts the
// custom elements. Vue's runtime treats them as native elements thanks to
// the `isCustomElement` rule in vite.config.ts.
//
// NOTE on the asymmetry with the React example's auth0-gate.d.ts: there the
// JSX augmentation lists each accepted attribute (`domain`, `client-id`, …)
// because React's IntrinsicElements typing checks attribute names. Vue's
// template checker does not validate attributes for elements registered via
// `isCustomElement`, so the GlobalComponents map only needs the element →
// class association (used for `ref` typing and as documentation). Listing
// attributes here would have no effect, so the two examples are intentionally
// shaped differently. `app-core-facade` is included for parity with the
// React map even though it has no public attributes — it documents the
// payload element and types `ref` access onto it.
//
// As in the React shim, the FULL element set is declared for completeness and
// reuse even though not all are used by this app — `<auth0-logout>` is mapped
// but unused here (this example logs out via a plain button calling
// `auth.logout()`).

import type { Auth, AuthLogout, AuthSession } from "@csbc-dev/auth0";

declare module "@vue/runtime-core" {
  interface GlobalComponents {
    "auth0-gate": Auth;
    "auth0-logout": AuthLogout;
    "auth0-session": AuthSession;
    "app-core-facade": HTMLElement;
  }
}
