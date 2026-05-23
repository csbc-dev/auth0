# Example WebSocket server

Authenticated WebSocket server for the example clients (vanilla / wcstack-state / react / vue), built on `@csbc-dev/auth0/server`.

This example uses the **low-level `handleConnection` API composed with a self-owned `http.Server`** (via `ws`'s `noServer: true` + manual `upgrade` handling), rather than the all-in-one `createAuthenticatedWSS` helper. That keeps the example in control of its own HTTP layer so it can also serve `/auth-config` on the same port. `RemoteShellProxy` is not constructed directly — it is the value `handleConnection` returns; the example forwards property events / command invocations through it implicitly.

It instantiates one [`AppCore`](../shared/appCore.js) per authenticated WebSocket — a tiny per-user counter — and forwards property events / command invocations through the `RemoteShellProxy` that `handleConnection` builds.

It also serves a small **`GET /auth-config`** endpoint on the same port so static / no-bundler clients (notably [`../wcstack-state/`](../wcstack-state/)) can bootstrap without baking tenant values into HTML. See [docs/patterns/server-config-discovery.md](../../docs/patterns/server-config-discovery.md) for the rationale and threat model.

## Setup

```bash
cp .env.example .env       # then fill in AUTH0_DOMAIN / AUTH0_CLIENT_ID / AUTH0_AUDIENCE
npm install
npm run dev
```

`AUTH0_AUDIENCE` must match the **API Identifier** of the API registered in your Auth0 tenant. The token's `aud` claim is verified against this value. `AUTH0_CLIENT_ID` is the SPA application's Client ID — the server itself never sends authenticated requests, but it advertises this value via `/auth-config` so static clients can pick it up.

`ALLOWED_ORIGINS` should include every example client origin you intend to open. Defaults cover `http://localhost:5173`–`5176` (vanilla 5173 / react 5174 / vue 5175 / wcstack-state 5176). The same allowlist gates BOTH the WebSocket upgrade AND the `/auth-config` CORS response — a request that would have been allowed to open a WebSocket is also allowed to read the config. Leaving it empty makes the server accept **any origin** for both the WebSocket and the config endpoint; that's intentional for localhost dev with multiple Vite ports, and startup logs a `fail-open` warning so it can't be deployed unnoticed.

`PUBLIC_WS_URL` is optional and overrides the URL advertised by `/auth-config`. When unset the server derives it per request from `Host` / `X-Forwarded-Proto` headers, so the same binary works on localhost, behind a reverse proxy, and on any reachable hostname without code changes. Set it explicitly only when the WS endpoint lives on a different host than the config endpoint.

## What this server does

- **WebSocket**: verifies every incoming upgrade — origin check + Auth0 token verification — **before** sending the `101 Switching Protocols` response, so bad tokens never see `open`. Reads the access token from the `Sec-WebSocket-Protocol` header. Constructs a fresh `AppCore` per connection (`createCores: user => new AppCore(user)`). Wires `onTokenRefresh` so `core.updateUser(user)` runs when the client performs in-band `auth:refresh`. Logs auth lifecycle events (`auth:success` / `auth:failure` / `auth:refresh` / `connection:close`).
- **HTTP `/auth-config`**: returns `{ domain, clientId, audience, remoteUrl }` as JSON. CORS-gated by `ALLOWED_ORIGINS`. `Cache-Control: private, max-age=60` — browser cache only, kept out of shared caches because the body's `remoteUrl` is request-derived; still lets a tenant rotation propagate within a minute. `remoteUrl` is derived from the request's `Host` (and `X-Forwarded-Proto` for TLS-aware scheme selection) unless `PUBLIC_WS_URL` is set. Other HTTP requests fall through to the standard `426 Upgrade Required` response.

## Notes

- The HTTP layer is small by design — one route plus the default 426 fallback. The server explicitly owns its `http.Server` and attaches `ws` via `noServer: true` + manual `upgrade` handling, so adding routes (`/healthz`, an Express / Fastify mount, additional config paths) is a matter of editing the existing `httpServer` rather than reaching into a `ws` internal. Production deployments that already have an HTTP server should follow the same composition pattern with `handleConnection` + `verifyAuth0Token` + `extractTokenFromProtocol` from `@csbc-dev/auth0/server`.
- **State is per-connection.** `createCores: user => new AppCore(user)` constructs a fresh `AppCore` for each authenticated WebSocket. `count` lives in JS memory on the server and is lost on disconnect (logout, page reload, network drop, server restart). The demo is intentional — it shows the wire shape without dragging in a database — but anything beyond a demo needs an explicit persistence layer (write to Redis / Postgres on each command and re-hydrate inside `createCores`). Re-connection (`AuthShell.reconnect` / `<auth0-session>`'s auto-restart) restores the wire but not the state.
- **Observing auth:refresh failures.** When an in-band `auth:refresh` is rejected, this server logs it (`[ws] auth:refresh-failure ...` via the `onEvent` hook) AND the client observes it as the `error` state on `<auth0-session>` (and, in this example, the per-client "Session error: ..." line). So the failure is visible on both sides without extra wiring.
- For production, add `sessionGraceMs` / `expParseFailurePolicy: "close"` per [README-REMOTE.md §Session expiry hardening](../../README-REMOTE.md#session-expiry-hardening).
- The `domain` / `clientId` / `audience` values are NOT secrets and are designed to ship to clients in any Auth0 SPA flow. The `/auth-config` endpoint is a delivery convenience, not a security boundary.
