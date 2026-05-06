# Vue example

Vite + Vue 3 client that talks to the [example server](../server/) in **remote mode**, using [`@wc-bindable/vue`](https://www.npmjs.com/package/@wc-bindable/vue)'s `useWcBindable` composable.

## Setup

```bash
cp .env.example .env       # then edit VITE_AUTH0_*
npm install
npm run dev                # http://localhost:5175
```

Make sure the [example server](../server/) is running first.

## Things this example demonstrates

- `useWcBindable<Auth, AuthValues>()` — reactive `values` for `<auth0-gate>`.
- `useWcBindable<AuthSession, ...>()` — reactive `values` for `<auth0-session>`.
- `useWcBindable<FacadeElement, FacadeValues>()` — bound directly on the **payload child** (`<app-core-facade>`), no `watch` + `bind(session.proxy)` bridge.
- `<app-core-facade>` is a schema-only custom element imported from `shared/appCore.js`; the session installs `count` / `lastUpdatedBy` mirrors and command forwarders on it.
- `compilerOptions.isCustomElement` (in [vite.config.ts](vite.config.ts)) covers both `auth0-*` and `app-core-facade` so Vue does not try to resolve them as Vue components.
