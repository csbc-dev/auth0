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

## Command-forwarder contract

`FacadeElement.increment` / `decrement` / `reset` are typed as **optional** because they are own-property assignments installed by `<auth0-session>` at connect time, not class methods on `AppCoreFacade` itself. The runtime ordering guarantees they are present whenever `sessionValues.ready === true`:

1. `<auth0-session>` resolves the payload child and obtains the transport.
2. It synchronously installs the command forwarders (`_installPayloadCommandForwarders`).
3. It synchronously registers `bind(proxy, ...)`.
4. Inside the first `bind` callback, it queues a microtask that flips `ready` to `true`.

The buttons are rendered inside `{sessionValues.ready && ...}`, so by the time a click handler runs the forwarders are installed. The `facadeRef.current?.increment?.()` expression still keeps the optional chains: the outer one guards a transiently null React ref, and the inner one keeps the type honest about the pre-connect state of the element. Both are zero-cost at runtime under the `ready` render guard.
