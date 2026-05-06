// Augment Vue's GlobalComponents so the template type-checker accepts the
// custom elements. Vue's runtime treats them as native elements thanks to
// the `isCustomElement` rule in vite.config.ts.

import type { Auth, AuthLogout, AuthSession } from "@csbc-dev/auth0";

declare module "@vue/runtime-core" {
  interface GlobalComponents {
    "auth0-gate": Auth;
    "auth0-logout": AuthLogout;
    "auth0-session": AuthSession;
  }
}
