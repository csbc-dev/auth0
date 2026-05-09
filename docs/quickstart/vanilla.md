# Vanilla quick start (Local mode)

Two starting points depending on whether you're using a bundler. Pick the one that matches your project.

Prerequisites: complete the Auth0 setup in [../README.md#one-time-auth0-setup](../README.md#one-time-auth0-setup-do-this-before-any-quickstart) and have your `domain`, `client-id`, `audience` values ready.

---

## A. Zero-build (HTML + CDN)

Simplest possible setup. Open `index.html` in a static dev server (e.g. `npx serve`).

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Auth0 quick start (vanilla)</title>
  <!-- /auto registers the custom elements via bootstrapAuth() -->
  <script type="module" src="https://esm.run/@csbc-dev/auth0/auto"></script>
</head>
<body>
  <auth0-gate
    id="auth"
    domain="your-tenant.auth0.com"
    client-id="your-client-id"
    audience="https://api.example.com"
    redirect-uri="http://localhost:3000">
  </auth0-gate>

  <p id="status">…</p>
  <button id="login" hidden>Sign in</button>
  <auth0-logout target="auth" hidden id="logout">Sign out</auth0-logout>

  <script type="module">
    import { bind } from "https://esm.run/@wc-bindable/core";

    const auth = document.getElementById("auth");
    const statusEl = document.getElementById("status");
    const loginBtn = document.getElementById("login");
    const logoutBtn = document.getElementById("logout");

    loginBtn.addEventListener("click", () => auth.login());

    bind(auth, (name, value) => {
      if (name === "loading") statusEl.textContent = value ? "Loading…" : "Ready";
      if (name === "authenticated") {
        loginBtn.hidden = value;
        logoutBtn.hidden = !value;
        if (value) statusEl.textContent = `Signed in as ${auth.user?.name ?? "?"}`;
        else       statusEl.textContent = "Signed out";
      }
      if (name === "error" && value) statusEl.textContent = `Error: ${value.message ?? value}`;
    });
  </script>
</body>
</html>
```

That's it — `<auth0-gate>` initializes Auth0 on connect, handles the redirect callback automatically, and `bind()` keeps your DOM in sync.

---

## B. Vite + ESM (recommended for real apps)

```bash
npm create vite@latest my-app -- --template vanilla
cd my-app
npm install
npm install @csbc-dev/auth0 @auth0/auth0-spa-js @wc-bindable/core
```

Add credentials to `.env` (Vite reads `VITE_*` automatically):

```ini
VITE_AUTH0_DOMAIN=your-tenant.auth0.com
VITE_AUTH0_CLIENT_ID=your-client-id
VITE_AUTH0_AUDIENCE=https://api.example.com
```

`index.html`:

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Vanilla + Vite</title>
</head>
<body>
  <auth0-gate id="auth"></auth0-gate>

  <p id="status">…</p>
  <button id="login" hidden>Sign in</button>
  <auth0-logout target="auth" id="logout" hidden>Sign out</auth0-logout>

  <button id="fetch" hidden>Call API</button>
  <pre id="result"></pre>

  <script type="module" src="/src/main.js"></script>
</body>
</html>
```

`src/main.js`:

```js
import { bootstrapAuth } from "@csbc-dev/auth0";
import { bind } from "@wc-bindable/core";

bootstrapAuth();

const auth = document.getElementById("auth");
auth.setAttribute("domain",      import.meta.env.VITE_AUTH0_DOMAIN);
auth.setAttribute("client-id",   import.meta.env.VITE_AUTH0_CLIENT_ID);
auth.setAttribute("audience",    import.meta.env.VITE_AUTH0_AUDIENCE);
auth.setAttribute("redirect-uri", window.location.origin);

const statusEl = document.getElementById("status");
const loginBtn = document.getElementById("login");
const logoutBtn = document.getElementById("logout");
const fetchBtn = document.getElementById("fetch");
const resultEl = document.getElementById("result");

loginBtn.addEventListener("click", () => auth.login());

// Authenticated fetch — token comes from getToken(), never from data-wcs.
fetchBtn.addEventListener("click", async () => {
  const token = await auth.getToken();
  const res = await fetch("/api/me", { headers: { Authorization: `Bearer ${token}` } });
  resultEl.textContent = await res.text();
});

bind(auth, (name, value) => {
  if (name === "loading")       statusEl.textContent = value ? "Loading…" : statusEl.textContent;
  if (name === "authenticated") {
    loginBtn.hidden  = value;
    logoutBtn.hidden = !value;
    fetchBtn.hidden  = !value;
    statusEl.textContent = value ? `Signed in as ${auth.user?.name ?? "?"}` : "Signed out";
  }
  if (name === "error" && value) statusEl.textContent = `Error: ${value.message ?? value}`;
});
```

Run it:

```bash
npm run dev
```

Make sure the dev URL (e.g. `http://localhost:5173`) is in your Auth0 application's **Allowed Callback URLs / Logout URLs / Web Origins**.

---

## Patterns to know

### Authenticated fetch

Token is exposed only as a JS getter (intentionally not bindable). Call `await auth.getToken()` from an event handler:

```js
fetchBtn.addEventListener("click", async () => {
  const token = await auth.getToken();
  if (!token) return;             // not signed in / token unavailable
  const res = await fetch("/api/users", {
    headers: { Authorization: `Bearer ${token}` },
  });
});
```

`getToken()` returns the cached token if available and silently refreshes only when stale. You don't need to manage the token lifecycle yourself.

### Logout

`<auth0-logout target="auth-id">` is a built-in helper. For programmatic logout:

```js
auth.logout({ logoutParams: { returnTo: window.location.origin } });
```

### Reading state without `bind()`

If you only need an event hook (not full reactive sync), plain DOM listeners work too:

```js
auth.addEventListener("auth0-gate:authenticated-changed", (e) => {
  console.log("authenticated:", e.detail);
});
```

### Waiting for initialization

`<auth0-gate>` exposes `connectedCallbackPromise` that resolves once the Auth0 client is ready and the redirect callback (if any) has been processed:

```js
await auth.connectedCallbackPromise;
console.log(auth.authenticated);  // safe to read
```

---

## See also

- [../../README-LOCAL.md](../../README-LOCAL.md) — full attribute / property / method reference
- [../../examples/vanilla/](../../examples/vanilla/) — runnable Vite app (note: configured for remote mode; remove `remote-url` and the `<auth0-session>` block to convert it to local mode)
- [../../README.md](../../README.md) — package overview and mode selection
