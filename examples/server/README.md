# Example WebSocket server

Authenticated WebSocket server for the example clients (vanilla / wcstack-state / react / vue), built on `@csbc-dev/auth0/server`.

It instantiates one [`AppCore`](../shared/appCore.js) per authenticated WebSocket — a tiny per-user counter — and forwards property events / command invocations through `RemoteShellProxy`.

## Setup

```bash
cp .env.example .env       # then edit AUTH0_DOMAIN / AUTH0_AUDIENCE
npm install
npm run dev
```

`AUTH0_AUDIENCE` must match the **API Identifier** of the API registered in your Auth0 tenant. The token's `aud` claim is verified against this value.

`ALLOWED_ORIGINS` should include every Vite dev origin you intend to open. Defaults cover `http://localhost:5173,5174,5175`. Leave it empty to disable the origin check (development only).

## What this server does

- Verifies every incoming WebSocket via `verifyClient` **before** the `101 Switching Protocols` upgrade — bad tokens never see `open`.
- Reads the access token from the `Sec-WebSocket-Protocol` header; never expects `Authorization` headers.
- Constructs a fresh `AppCore` per connection (`createCores: user => new AppCore(user)`).
- Wires `onTokenRefresh` so `core.updateUser(user)` runs when the client performs in-band `auth:refresh`.
- Logs auth lifecycle events (`auth:success` / `auth:failure` / `auth:refresh` / `connection:close`).

## Notes

- This server has no HTTP layer — it is WebSocket only. The example clients are served by Vite (or as a static file in the `wcstack-state` case).
- For production, add `sessionGraceMs` / `expParseFailurePolicy: "close"` per [README-REMOTE.md §Session expiry hardening](../../README-REMOTE.md#session-expiry-hardening).
