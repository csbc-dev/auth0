// JSX intrinsic-element augmentation for the @csbc-dev/auth0 custom elements.
// Without this, TypeScript flags <auth0-gate /> / <auth0-session /> as unknown.
//
// This shim covers the FULL @csbc-dev/auth0 element set for completeness and
// copy-paste reuse. Not every element is used by this particular app — e.g.
// `<auth0-logout>` is declared but unused here (this example logs out via a
// plain button calling `auth.logout()`). The vue example's auth0-gate.d.ts
// keeps the same full set for parity.

import type { DetailedHTMLProps, HTMLAttributes } from "react";
import type { Auth, AuthLogout, AuthSession } from "@csbc-dev/auth0";

type Custom<T> = DetailedHTMLProps<HTMLAttributes<T>, T> & {
  domain?: string;
  "client-id"?: string;
  "redirect-uri"?: string;
  audience?: string;
  scope?: string;
  "remote-url"?: string;
  mode?: "local" | "remote";
  "cache-location"?: "memory" | "localstorage";
  "use-refresh-tokens"?: string | boolean;
  popup?: string | boolean;
};

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "auth0-gate": Custom<Auth>;
      "auth0-logout": Custom<AuthLogout> & { target?: string; "return-to"?: string };
      "auth0-session": Custom<AuthSession> & {
        target?: string;
        // `core` selects a string-registered Core declaration
        // (registerCoreDeclaration). This example uses the payload-child
        // pattern instead — the <app-core-facade> child carries the schema —
        // so `core` is intentionally NOT set here. It stays in the type only
        // because it is a valid attribute of the real <auth0-session> element.
        core?: string;
        url?: string;
        "auto-connect"?: string | boolean;
      };
      "app-core-facade": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}
