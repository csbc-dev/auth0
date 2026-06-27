# `@csbc-dev/auth0` examples - conventions

This document is the standard every example under `examples/` must follow. The examples are remote-mode demos: they prove that one Auth0-authenticated WebSocket session can expose a server-side Core through the same bindable surface in vanilla JavaScript, React, Vue, and `@wcstack/state`.

The examples intentionally keep Auth0 setup visible. Redirect URLs, logout URLs, web origins, and CORS allowlists are part of the behavior being demonstrated, not incidental boilerplate.

## 1. The four browser targets

Every browser example drives the same authenticated data plane:

| Dir | Integration style | What it proves |
|---|---|---|
| `vanilla/` | `<auth0-gate>` + `<auth0-session>` + raw `bind()` | imperative DOM, no framework |
| `react/` | `<auth0-gate>` + `<auth0-session>` + `useWcBindable` | the official React adapter |
| `vue/` | `<auth0-gate>` + `<auth0-session>` + `useWcBindable` | the official Vue adapter |
| `wcstack-state/` | `<auth0-config>` + `<auth0-gate>` + `<auth0-session>` + `data-wcs` | declarative binding and runtime config discovery |

Do not add another framework folder without updating this document and `README.md`. The point is side-by-side comparison of the same Core, not framework coverage for its own sake.

## 2. Shared server, separate client origins

`examples/server/` is the single authenticated backend for all four clients. It owns:

1. `GET /auth-config`, served by `createAuthConfigHandler()` for clients that discover public Auth0 config at runtime.
2. WebSocket authentication, served by `createAuthenticatedWSS()`.
3. One per-user `AppCore` instance per authenticated WebSocket connection.

The browser examples are served on separate local origins (`5173`-`5176`) rather than through one static delivery server. That is deliberate: Auth0 redirect callbacks, logout URLs, web origins, and the server's `ALLOWED_ORIGINS` list are part of the integration contract. The examples should make those origins explicit so users can map them directly to their Auth0 tenant settings.

Each framework example may use Vite's dev server for authoring. If a future build-and-serve flow is added, it must preserve the same explicit origin story and update the Auth0 setup table in `README.md`.

## 3. The payload child pattern is canonical

All examples use this remote-mode shape:

```html
<auth0-gate id="auth" mode="remote" remote-url="..."></auth0-gate>
<auth0-session target="auth" core="app-core">
  <app-core-facade id="app-core"></app-core-facade>
</auth0-session>
```

The application Core declaration lives once on the facade class as `static wcBindable` and is shared with the server-side `AppCore`. The clients bind to `<app-core-facade>`, not directly to `RemoteCoreProxy` internals.

Keep the Auth0 layer and the application data layer distinct:

- `<auth0-gate>` owns Auth0 login/logout and token acquisition.
- `<auth0-session>` owns authenticated WebSocket connection and initial sync readiness.
- `<app-core-facade>` owns the demo application's bindable state and commands.

## 4. Token handling rules

Remote-mode examples must never expose the access token to application code.

- Do not call `authEl.getToken()` in remote examples; it throws by design.
- Do not bind `token` through `data-wcs`; it is not part of the element's bindable surface.
- Do not log bearer tokens, protocol strings, or `Sec-WebSocket-Protocol` values.
- Do not pass tokens through the app facade, React state, Vue refs, or wcstack state.

The only token handoff is inside `<auth0-gate>` during the WebSocket handshake and in-band `auth:refresh`. Application examples should show user state, connection state, and Core state, not bearer material.

## 5. Config discovery rules

When an example fetches public Auth0 config at runtime, use `<auth0-config>` and the server's `/auth-config` endpoint. The endpoint may expose `domain`, `clientId`, `audience`, and `remoteUrl`; these are public SPA configuration values, not secrets.

Hardcoding tenant values in example HTML should be limited to framework demos that intentionally use Vite environment variables. For static HTML and `wcstack-state`, prefer runtime discovery so the same file can move across local, staging, and production-like environments.

## 6. Demo-only shortcuts

Examples are allowed to simplify the application Core, but not the authentication boundary.

Allowed demo shortcuts:

- In-memory per-connection `AppCore` state.
- A tiny counter-style application Core.
- Localhost-only origin lists in `.env.example`.

Not allowed:

- Accepting unauthenticated WebSocket connections.
- Replacing Auth0 token verification with a client-supplied user object.
- Storing access tokens in localStorage for the examples unless the example is explicitly about `cache-location` tradeoffs.
- Copying test-only mock token generation into runnable examples.

## 7. Build and dependency expectations

Each example must continue to install and build independently from its own folder. Framework examples may depend on `@csbc-dev/auth0` as a package dependency, but shared demo primitives under `examples/shared/` must stay framework-neutral.

When changing the shared Core declaration, update both sides together:

- `examples/shared/appCore.js` for the server-side Core and shared declaration.
- `examples/shared/appCoreFacade.js` and `appCoreFacade.auto.js` for browser registration paths.
- All four clients if the visible state or commands change.

Run the relevant example build after changing its framework folder, and run the root unit tests after changing package source.