# Vanilla example (no @wcstack/state)

Pure-JS client that talks to the [example server](../server/) in **remote mode**.

It registers `<auth0-gate>` / `<auth0-session>` via `bootstrapAuth()`, defines a `<app-core-facade>` payload child whose class declares the same wcBindable schema as the server-side Core, and uses `bind()` from `@wc-bindable/core` to subscribe directly to the facade.

## Setup

```bash
cp .env.example .env       # then edit VITE_AUTH0_*
npm install
npm run dev                # http://localhost:5173
```

Make sure the [example server](../server/) is running first (`npm run dev` from `examples/server`).

## Things this example demonstrates

- Remote-mode gate (`mode` is inferred from `remote-url`).
- Two-element pattern + payload child: `<auth0-gate>` + `<auth0-session>` containing `<app-core-facade>`.
- `<app-core-facade>` is a **schema-only** custom element (`static wcBindable = appCoreDeclaration` — the same declaration constant the server-side `AppCore` uses, imported from `shared/appCore.js`); the session installs property mirrors and command forwarders on it for the lifetime of the connection.
- `bind(facade, ...)` subscribes to mirrored property events directly — no `bind(session.proxy, ...)` bridge.
- `facade.increment?.()` / `facade.decrement?.()` / `facade.reset?.()` — command forwarders route to `proxy.invoke(...)`. They are installed by `<auth0-session>` as own-properties only after the connection is established, so they are `undefined` before connect; the optional-chaining call (`?.()`) keeps a pre-connect click from throwing. (The buttons are only meaningfully used once the session is ready.)
- No `registerCoreDeclaration` / `core="..."` registry indirection.
