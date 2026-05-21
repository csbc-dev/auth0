# `@csbc-dev/auth0` examples

Four runnable client examples that all talk to one shared WebSocket server in **remote mode**:

| Example                        | Stack                                       | Demonstrates |
|--------------------------------|---------------------------------------------|--------------|
| [`vanilla/`](vanilla/)         | Vite + `bind()` from `@wc-bindable/core`    | Pure-JS imperative binding |
| [`wcstack-state/`](wcstack-state/) | CDN `<wcs-state>` + `data-wcs`           | Declarative HTML attribute binding |
| [`react/`](react/)             | Vite + React 19 + `@wc-bindable/react`      | `useWcBindable` hook |
| [`vue/`](vue/)                 | Vite + Vue 3 + `@wc-bindable/vue`           | `useWcBindable` composable |

The shared server lives at [`server/`](server/) and is built on `@csbc-dev/auth0/server`. It instantiates one [`AppCore`](shared/appCore.js) per authenticated WebSocket — a per-user counter — and forwards property events / command invocations through `RemoteShellProxy`.

## Auth0 setup (do this once)

In your Auth0 tenant:

1. Create a **Single Page Application**.
   - **Allowed Callback URLs**: `http://localhost:5173, http://localhost:5174, http://localhost:5175, http://localhost:5176`
   - **Allowed Logout URLs**: `http://localhost:5173, http://localhost:5174, http://localhost:5175, http://localhost:5176`
   - **Allowed Web Origins**: `http://localhost:5173, http://localhost:5174, http://localhost:5175, http://localhost:5176`
2. Create an **API**. The **API Identifier** value (e.g. `https://api.example.com`) is what you set as `audience` in every example, and as `AUTH0_AUDIENCE` on the server.
3. Note your tenant **Domain** (e.g. `your-tenant.auth0.com`) and the SPA's **Client ID**.

## Run order

Always start the server first:

```bash
cd examples/server
cp .env.example .env       # edit AUTH0_DOMAIN / AUTH0_AUDIENCE
npm install
npm run dev                # ws://localhost:3000
```

Then pick any client:

```bash
# in another terminal
cd examples/vanilla        # or react/, or vue/
cp .env.example .env       # edit VITE_AUTH0_*
npm install
npm run dev
```

For `wcstack-state/` see its [README](wcstack-state/README.md) — it has no bundler. Tenant values come from the example server's `/auth-config` endpoint at boot (see [docs/patterns/server-config-discovery.md](../docs/patterns/server-config-discovery.md)), so the only constant in the HTML is `CONFIG_URL` (defaults to `http://localhost:3000/auth-config`).

## Port assignments

| Project             | Port |
|---------------------|------|
| `server`            | 3000 (WebSocket) |
| `vanilla`           | 5173 |
| `react`             | 5174 |
| `vue`               | 5175 |
| `wcstack-state`     | 5176 (static server — pass the port to your chosen tool) |

All four client ports are distinct, so every example can run simultaneously against the one server. The default `ALLOWED_ORIGINS` in `examples/server/.env.example` already lists `5173`–`5176`. `wcstack-state` has no bundler, so its port is whatever you pass to the static server you run (the [wcstack-state README](wcstack-state/README.md) uses `5176`); pick another port only if you also add it to `ALLOWED_ORIGINS` and your Auth0 application's allowed URLs.

## What all four clients demonstrate

- Remote mode: token never reaches application JS.
- **Payload child pattern**: `<auth0-gate>` (auth) + `<auth0-session>` (transport) + a user-defined `<app-core-facade>` child (data-plane). The schema lives once on the facade class as `static wcBindable` and is shared with the server — no string registry, no `registerCoreDeclaration`.
- Per-user `AppCore` on the server with `count` / `connectedUser` properties and `increment` / `decrement` / `reset` commands; mirrored onto `<app-core-facade>` on each client.
- Each client binds **directly on `<app-core-facade>`** (the session writes property mirrors and command forwarders onto it).
- Login / logout flow with redirect callback handled automatically by `<auth0-gate>`.

## See also

- [`../README-REMOTE.md`](../README-REMOTE.md) — remote-mode user guide.
- [`../SPEC-REMOTE.md`](../SPEC-REMOTE.md) — wire protocol, server handler, error codes.
- [`shared/appCore.js`](shared/appCore.js) — Core declaration + server-side `AppCore` (universal: loads in Node and the browser).
- [`shared/appCoreFacade.js`](shared/appCoreFacade.js) — browser-only `<app-core-facade>` payload class + `defineAppCoreFacade()` helper. The server does not import this; only the bundled clients (vanilla / react / vue) do.
