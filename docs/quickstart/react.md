# React quick start (Local mode)

For React 18 / 19 with TypeScript. Plain JS works too — drop the type annotations.

Prerequisites: complete the Auth0 setup in [../README.md#one-time-auth0-setup](../README.md#one-time-auth0-setup-do-this-before-any-quickstart).

---

## Install

```bash
npm create vite@latest my-app -- --template react-ts
cd my-app
npm install
npm install @csbc-dev/auth0 @auth0/auth0-spa-js @wc-bindable/react
```

`.env`:

```ini
VITE_AUTH0_DOMAIN=your-tenant.auth0.com
VITE_AUTH0_CLIENT_ID=your-client-id
VITE_AUTH0_AUDIENCE=https://api.example.com
```

---

## Step 1 — Register the custom elements

`src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { bootstrapAuth } from "@csbc-dev/auth0";
import App from "./App.tsx";

bootstrapAuth();   // registers <auth0-gate>, <auth0-logout>

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`bootstrapAuth()` only runs once — it's a no-op on subsequent calls (HMR-safe).

---

## Step 2 — JSX type augmentation (TypeScript only)

Without this, TS flags `<auth0-gate ref={ref}>` as "no such element". Create one file (any name); it's loaded by `tsconfig.json`'s `include` glob automatically.

`src/auth0-gate.d.ts`:

```ts
import type { DetailedHTMLProps, HTMLAttributes } from "react";
import type { Auth, AuthLogout } from "@csbc-dev/auth0";

type Custom<T> = DetailedHTMLProps<HTMLAttributes<T>, T> & {
  domain?: string;
  "client-id"?: string;
  "redirect-uri"?: string;
  audience?: string;
  scope?: string;
  "cache-location"?: "memory" | "localstorage";
  "use-refresh-tokens"?: string | boolean;
  popup?: string | boolean;
};

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "auth0-gate": Custom<Auth>;
      "auth0-logout": Custom<AuthLogout> & { target?: string; "return-to"?: string };
    }
  }
}
```

Plain JS users: skip this step entirely.

---

## Step 3 — Use it

`src/App.tsx`:

```tsx
import { useWcBindable } from "@wc-bindable/react";
import type { Auth, AuthValues } from "@csbc-dev/auth0";

const env = import.meta.env;

export default function App() {
  // ref is auto-attached to the element below; values updates reactively.
  const [authRef, { authenticated, user, loading, error }] =
    useWcBindable<Auth, AuthValues>();

  return (
    <main>
      <auth0-gate
        ref={authRef}
        domain={env.VITE_AUTH0_DOMAIN}
        client-id={env.VITE_AUTH0_CLIENT_ID}
        audience={env.VITE_AUTH0_AUDIENCE}
        redirect-uri={window.location.origin}
      />

      {loading && <p>Loading Auth0…</p>}
      {error && <p style={{ color: "red" }}>{String(error.message ?? error)}</p>}

      {!loading && !authenticated && (
        <button onClick={() => authRef.current?.login()}>Sign in</button>
      )}

      {authenticated && (
        <>
          <p>Welcome, {user?.name}</p>
          <button onClick={() =>
            authRef.current?.logout({ logoutParams: { returnTo: window.location.origin } })
          }>
            Sign out
          </button>
        </>
      )}
    </main>
  );
}
```

Run:

```bash
npm run dev
```

Make sure `http://localhost:5173` is in your Auth0 SPA's **Allowed Callback URLs / Logout URLs / Web Origins**.

---

## Authenticated fetch

The token is intentionally NOT in the bindable surface. Call `getToken()` from an effect or event handler:

```tsx
import { useEffect, useState } from "react";

function UserData() {
  const [authRef, { authenticated }] = useWcBindable<Auth, AuthValues>();
  const [data, setData] = useState<unknown>(null);

  useEffect(() => {
    if (!authenticated || !authRef.current) return;
    let cancelled = false;

    (async () => {
      const token = await authRef.current!.getToken();
      if (!token || cancelled) return;
      const res = await fetch("/api/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!cancelled) setData(await res.json());
    })();

    return () => { cancelled = true; };
  }, [authenticated]);

  return <pre>{JSON.stringify(data, null, 2)}</pre>;
}
```

`getToken()` returns the cached token when fresh and silently refreshes only when needed; React doesn't need to manage that lifecycle.

---

## Patterns to know

### Triggering login from outside a button

```tsx
authRef.current?.login();                    // redirect (default)
authRef.current?.login({ appState: { ... } });
```

For popup mode, add `popup` to the element:

```tsx
<auth0-gate ref={authRef} popup ... />
```

### Reading state imperatively

```tsx
authRef.current?.authenticated;     // boolean
authRef.current?.user;              // user profile or null
await authRef.current?.connectedCallbackPromise;  // wait for init
```

### Errors

`error` is part of the bindable surface — render from it directly. Auth0 SDK failures **do not** reject; they show up as `error` while `loading` is cleared. Don't wrap `login()` in `try/catch`.

```tsx
{error && (
  <div role="alert">
    {(error as any).error_description ?? error.message ?? String(error)}
  </div>
)}
```

---

## See also

- [../../README-LOCAL.md](../../README-LOCAL.md) — full attribute / property / method reference + error contract
- [../../README-LOCAL.md#react](../../README-LOCAL.md#react) — alternative integration patterns
- [../../examples/react/](../../examples/react/) — runnable Vite + React 19 app (configured for remote mode; drop `remote-url` and `<auth0-session>` to convert)
