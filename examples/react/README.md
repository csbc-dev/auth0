# React example

Vite + React 19 client that talks to the [example server](../server/) in **remote mode**, using [`@wc-bindable/react`](https://www.npmjs.com/package/@wc-bindable/react)'s `useWcBindable` hook.

## Setup

```bash
cp .env.example .env       # then edit VITE_AUTH0_*
npm install
npm run dev                # http://localhost:5174
```

Make sure the [example server](../server/) is running first.

## Things this example demonstrates

- `useWcBindable<Auth, AuthValues>()` — `<auth0-gate>` reactive surface.
- `useWcBindable<AuthSession, ...>()` — `<auth0-session>` `ready` / `connecting` / `error`.
- `useWcBindable<FacadeElement, FacadeValues>()` — bound directly on the **payload child** (`<app-core-facade>`), no `useEffect` + `bind(session.proxy)` bridge.
- `<app-core-facade>` is a schema-only custom element imported from `shared/appCore.js`; the session installs `count` / `lastUpdatedBy` mirrors and `increment` / `decrement` / `reset` command forwarders on it.
- TypeScript JSX intrinsic-element augmentation in [`src/auth0-gate.d.ts`](src/auth0-gate.d.ts) — including `app-core-facade` so `<app-core-facade ref={facadeRef} />` type-checks.
