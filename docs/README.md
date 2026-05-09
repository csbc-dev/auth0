# `@csbc-dev/auth0` — Documentation

Concise, snippet-style quick starts for using `<auth0-gate>` in **Local mode** (Auth0 SPA SDK runs in the browser; access token reachable via `el.token` / `await el.getToken()`).

For the WebSocket-backed deployment where the token never reaches application code, see [../README-REMOTE.md](../README-REMOTE.md).

## Quick starts

| Stack | Doc |
|---|---|
| Vanilla (HTML + ESM, with or without bundler) | [quickstart/vanilla.md](quickstart/vanilla.md) |
| React 18 / 19 (+ TypeScript) | [quickstart/react.md](quickstart/react.md) |
| Vue 3 (+ TypeScript) | [quickstart/vue.md](quickstart/vue.md) |

Each guide is ~5 minutes end-to-end. They share the same Auth0 setup below; do that once first.

## Patterns

Cross-cutting recipes that apply on top of any framework / mode.

| Pattern | Doc |
|---|---|
| Server-hosted Auth0 config (no env in static HTML) | [patterns/server-config-discovery.md](patterns/server-config-discovery.md) |

## When to pick Local vs Remote

| | Local mode (these docs) | Remote mode ([README-REMOTE.md](../README-REMOTE.md)) |
|---|---|---|
| Token reachable from app JS? | yes (`el.token` / `await el.getToken()`) | no (`el.token === null`, `getToken()` throws) |
| Backend shape | REST / GraphQL with `Authorization: Bearer ...` | WebSocket-attached server-side Cores |
| Use when | calling stateless HTTP APIs | server holds long-lived per-user state |

If you're integrating Auth0 with a regular REST API, **stay in Local mode** — that's what these docs cover.

## One-time Auth0 setup (do this before any quickstart)

In your Auth0 tenant:

1. **Single Page Application** (Applications → Applications → "+ Create Application")
   - **Allowed Callback URLs**: `http://localhost:5173` (or whatever your dev port is)
   - **Allowed Logout URLs**: `http://localhost:5173`
   - **Allowed Web Origins**: `http://localhost:5173`
2. **API** (Applications → APIs → "+ Create API"). The **Identifier** value (e.g. `https://api.example.com`) is what you set as `audience` in HTML / JSX. It does NOT have to be a real, fetchable URL — it's just an identifier.
3. Note these three values — you'll paste them into each quickstart:
   - **Domain** (e.g. `your-tenant.auth0.com`)
   - **Client ID** (the SPA application's identifier)
   - **API Identifier** (the `audience`)

> If you skip step 2 and don't set `audience`, Auth0 still works but issues an *opaque* access token usable only for the ID-token flow — you cannot attach it as `Bearer` to your own backend. Set it whenever your app calls a backend or needs RBAC `permissions` / `roles`.

## What goes in each quickstart

All three follow the same shape:

1. Install `@csbc-dev/auth0` + `@auth0/auth0-spa-js` (peer dep) + the framework adapter.
2. (TypeScript only) Declare `<auth0-gate>` in JSX / template via a one-off augmentation file.
3. Mount `<auth0-gate>` with `domain` / `client-id` / `audience`.
4. Read `authenticated` / `user` / `loading` / `error` reactively.
5. Call `el.login()` / `el.logout()` from buttons, and `await el.getToken()` for fetch.

The only thing that changes between frameworks is the binding mechanism (`bind()` vs `useWcBindable`).

## Background reading (optional)

- [../README.md](../README.md) — package overview
- [../README-LOCAL.md](../README-LOCAL.md) — full local-mode reference (state surface, error contract, redirect callback handling, all attributes)
- [../examples/](../examples/) — runnable example apps (note: they're remote-mode demos, but the auth element shape is identical)

## Conventions used in these docs

- Code snippets are **minimum viable**; once they work, refer to [../README-LOCAL.md](../README-LOCAL.md) for every attribute / event.
- All snippets assume Vite for the bundler, but anything that handles ESM (Webpack 5, Rollup, esbuild, Bun) works the same way.
- `import.meta.env.VITE_AUTH0_*` is used for credentials so they aren't hard-coded; adapt to your bundler's env-var convention.
