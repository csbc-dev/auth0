# Vue 3 quick start (Local mode)

For Vue 3 + `<script setup>` + TypeScript. Plain JS works too — drop the type annotations.

Prerequisites: complete the Auth0 setup in [../README.md#one-time-auth0-setup](../README.md#one-time-auth0-setup-do-this-before-any-quickstart).

---

## Install

```bash
npm create vite@latest my-app -- --template vue-ts
cd my-app
npm install
npm install @csbc-dev/auth0 @auth0/auth0-spa-js @wc-bindable/vue
```

`.env`:

```ini
VITE_AUTH0_DOMAIN=your-tenant.auth0.com
VITE_AUTH0_CLIENT_ID=your-client-id
VITE_AUTH0_AUDIENCE=https://api.example.com
```

---

## Step 1 — Tell Vue these tags are custom elements

`vite.config.ts`:

```ts
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          // Skip Vue's component-resolution for our custom elements.
          isCustomElement: (tag) => tag.startsWith("auth0-"),
        },
      },
    }),
  ],
});
```

Without this, Vue prints "Failed to resolve component: auth0-gate" warnings and treats slots oddly.

---

## Step 2 — Register the custom elements

`src/main.ts`:

```ts
import { createApp } from "vue";
import { bootstrapAuth } from "@csbc-dev/auth0";
import App from "./App.vue";

bootstrapAuth();   // registers <auth0-gate>, <auth0-logout>

createApp(App).mount("#app");
```

---

## Step 3 — TypeScript template augmentation (TypeScript only)

Without this, Vue's template type-checker rejects `<auth0-gate :ref="..." />`. Create one file (any name); it's loaded by `tsconfig.json`'s `include` glob automatically.

`src/auth0-gate.d.ts`:

```ts
import type { Auth, AuthLogout } from "@csbc-dev/auth0";

declare module "@vue/runtime-core" {
  interface GlobalComponents {
    "auth0-gate": Auth;
    "auth0-logout": AuthLogout;
  }
}
```

Plain JS users: skip this step entirely.

---

## Step 4 — Use it

`src/App.vue`:

```vue
<script setup lang="ts">
import { useWcBindable } from "@wc-bindable/vue";
import type { Auth, AuthValues } from "@csbc-dev/auth0";

const env = import.meta.env;
const redirectUri = window.location.origin;

const { ref: authRef, values } = useWcBindable<Auth, AuthValues>();

function login()  { authRef.value?.login(); }
function logout() { authRef.value?.logout({ logoutParams: { returnTo: redirectUri } }); }
</script>

<template>
  <main>
    <auth0-gate
      :ref="authRef"
      :domain="env.VITE_AUTH0_DOMAIN"
      :client-id="env.VITE_AUTH0_CLIENT_ID"
      :audience="env.VITE_AUTH0_AUDIENCE"
      :redirect-uri="redirectUri"
    />

    <p v-if="values.loading">Loading Auth0…</p>
    <p v-if="values.error" style="color:red">
      {{ (values.error as any).message ?? String(values.error) }}
    </p>

    <template v-if="!values.loading && !values.authenticated">
      <button @click="login">Sign in</button>
    </template>

    <template v-if="values.authenticated">
      <p>Welcome, {{ values.user?.name }}</p>
      <button @click="logout">Sign out</button>
    </template>
  </main>
</template>
```

Run:

```bash
npm run dev
```

Make sure `http://localhost:5173` (or whatever Vite picks) is in your Auth0 SPA's **Allowed Callback URLs / Logout URLs / Web Origins**.

---

## Authenticated fetch

The token is intentionally NOT in the bindable surface. Call `getToken()` from a watcher or event handler:

```vue
<script setup lang="ts">
import { ref, watch } from "vue";
import { useWcBindable } from "@wc-bindable/vue";
import type { Auth, AuthValues } from "@csbc-dev/auth0";

const { ref: authRef, values } = useWcBindable<Auth, AuthValues>();
const data = ref<unknown>(null);

watch(() => values.authenticated, async (signedIn) => {
  if (!signedIn || !authRef.value) {
    data.value = null;
    return;
  }
  const token = await authRef.value.getToken();
  if (!token) return;
  const res = await fetch("/api/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  data.value = await res.json();
});
</script>
```

`getToken()` returns the cached token when fresh and silently refreshes only when needed.

---

## Patterns to know

### Triggering login programmatically

```ts
authRef.value?.login();                       // redirect (default)
authRef.value?.login({ appState: { ... } });
```

For popup mode, add `popup` to the element:

```vue
<auth0-gate :ref="authRef" popup ... />
```

### Reading state imperatively

```ts
authRef.value?.authenticated;
authRef.value?.user;
await authRef.value?.connectedCallbackPromise;   // wait for init
```

### Errors

`error` is reactive — render from `values.error`. Auth0 SDK failures **do not** reject; they show up as `error` while `loading` is cleared. Don't wrap `login()` in `try/catch`.

```vue
<p v-if="values.error" role="alert">
  {{ (values.error as any).error_description ?? values.error.message }}
</p>
```

---

## See also

- [../../README-LOCAL.md](../../README-LOCAL.md) — full attribute / property / method reference + error contract
- [../../README-LOCAL.md#vue](../../README-LOCAL.md#vue) — alternative integration patterns
- [../../examples/vue/](../../examples/vue/) — runnable Vite + Vue 3 app (configured for remote mode; drop `remote-url` and `<auth0-session>` to convert)
