# Example WebSocket server

Authenticated WebSocket server for the example clients (vanilla / wcstack-state / react / vue), built on `@csbc-dev/auth0/server`.

It instantiates one [`AppCore`](../shared/appCore.js) per authenticated WebSocket — a tiny per-user counter — and forwards property events / command invocations through `RemoteShellProxy`.

It also serves a small **`GET /auth-config`** endpoint on the same port so static / no-bundler clients (notably [`../wcstack-state/`](../wcstack-state/)) can bootstrap without baking tenant values into HTML. See [docs/patterns/server-config-discovery.md](../../docs/patterns/server-config-discovery.md) for the rationale and threat model.

## Setup

```bash
cp .env.example .env       # then fill in AUTH0_DOMAIN / AUTH0_CLIENT_ID / AUTH0_AUDIENCE
npm install
npm run dev
```

`AUTH0_AUDIENCE` must match the **API Identifier** of the API registered in your Auth0 tenant. The token's `aud` claim is verified against this value. `AUTH0_CLIENT_ID` is the SPA application's Client ID — the server itself never sends authenticated requests, but it advertises this value via `/auth-config` so static clients can pick it up.

`ALLOWED_ORIGINS` should include every Vite dev origin you intend to open. Defaults cover `http://localhost:5173,5174,5175`. The same allowlist gates BOTH the WebSocket upgrade AND the `/auth-config` CORS response — a request that would have been allowed to open a WebSocket is also allowed to read the config. Leave it empty to disable both checks (development only).

## What this server does

- **WebSocket**: verifies every incoming WebSocket via `verifyClient` **before** the `101 Switching Protocols` upgrade — bad tokens never see `open`. Reads the access token from the `Sec-WebSocket-Protocol` header. Constructs a fresh `AppCore` per connection (`createCores: user => new AppCore(user)`). Wires `onTokenRefresh` so `core.updateUser(user)` runs when the client performs in-band `auth:refresh`. Logs auth lifecycle events (`auth:success` / `auth:failure` / `auth:refresh` / `connection:close`).
- **HTTP `/auth-config`**: returns `{ domain, clientId, audience, remoteUrl }` as JSON. CORS-gated by `ALLOWED_ORIGINS`. `Cache-Control: public, max-age=60` so a tenant rotation propagates within a minute. Other HTTP requests fall through to the standard `426 Upgrade Required` response.

## Notes

- The HTTP layer is small by design — one route plus the default 426 fallback. It's wired to the underlying `http.Server` that the `ws` library creates when you pass `port`. Production deployments that need richer HTTP routing should compose `WebSocketServer({ noServer: true })` against an Express / Fastify / standard-http server of their own and apply this package's `verifyClient` and `handleConnection` directly.
- For production, add `sessionGraceMs` / `expParseFailurePolicy: "close"` per [README-REMOTE.md §Session expiry hardening](../../README-REMOTE.md#session-expiry-hardening).
- The `domain` / `clientId` / `audience` values are NOT secrets and are designed to ship to clients in any Auth0 SPA flow. The `/auth-config` endpoint is a delivery convenience, not a security boundary.
