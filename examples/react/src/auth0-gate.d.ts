// JSX intrinsic-element augmentation for the @csbc-dev/auth0 custom elements.
// Without this, TypeScript flags <auth0-gate /> / <auth0-session /> as unknown.

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
        core?: string;
        url?: string;
        "auto-connect"?: string | boolean;
      };
      "app-core-facade": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}
