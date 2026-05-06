<script setup lang="ts">
import { computed } from "vue";
import { useWcBindable } from "@wc-bindable/vue";
import type { Auth, AuthSession, AuthValues } from "@csbc-dev/auth0";

interface SessionValues {
  ready: boolean;
  connecting: boolean;
  error: Error | null;
}

interface FacadeValues {
  count: number;
  lastUpdatedBy: string;
}
interface FacadeElement extends HTMLElement, FacadeValues {
  increment?: (...args: unknown[]) => Promise<unknown>;
  decrement?: (...args: unknown[]) => Promise<unknown>;
  reset?: (...args: unknown[]) => Promise<unknown>;
}

const env = import.meta.env;
const redirectUri = window.location.origin;

function errorText(err: unknown): string {
  if (!err) return "";
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "error" in err) {
    return String((err as { error: string }).error);
  }
  return String(err);
}

const authBinding    = useWcBindable<Auth, AuthValues>();
const sessionBinding = useWcBindable<AuthSession, SessionValues>();
// Bind directly on the payload child — the session mirrors property
// updates onto it, so `useWcBindable` against the facade observes the
// live Core surface with no manual proxy bridging.
const facadeBinding  = useWcBindable<FacadeElement, FacadeValues>();

const auth    = authBinding.values;
const session = sessionBinding.values;
const facade  = facadeBinding.values;

const status = computed(() => {
  if (auth.loading)              return "Loading Auth0…";
  if (!auth.authenticated)       return "Signed out.";
  if (session.ready)             return "Session ready.";
  if (session.connecting)        return "Opening session…";
  return "Authenticated, waiting for session…";
});

function login() { authBinding.ref.value?.login(); }
function logout() {
  authBinding.ref.value?.logout({ logoutParams: { returnTo: redirectUri } });
}
function increment() { facadeBinding.ref.value?.increment?.(); }
function decrement() { facadeBinding.ref.value?.decrement?.(); }
function reset()     { facadeBinding.ref.value?.reset?.(); }
</script>

<template>
  <main>
    <h1>Vue — remote mode</h1>

    <auth0-gate
      :ref="authBinding.ref"
      id="auth"
      :domain="env.VITE_AUTH0_DOMAIN"
      :client-id="env.VITE_AUTH0_CLIENT_ID"
      :audience="env.VITE_AUTH0_AUDIENCE"
      :remote-url="env.VITE_REMOTE_URL ?? 'ws://localhost:3000'"
      :redirect-uri="redirectUri"
    />
    <auth0-session :ref="sessionBinding.ref" target="auth">
      <app-core-facade :ref="facadeBinding.ref" />
    </auth0-session>

    <section>
      <p class="muted">{{ status }}</p>
      <p v-if="auth.error" class="err">Auth error: {{ errorText(auth.error) }}</p>
      <p v-if="session.error" class="err">Session error: {{ errorText(session.error) }}</p>

      <button v-if="!auth.loading && !auth.authenticated" @click="login">Sign in</button>
      <button v-if="auth.authenticated" @click="logout">Sign out</button>
    </section>

    <section v-if="session.ready">
      <p>Count: <strong>{{ facade.count ?? 0 }}</strong></p>
      <p class="muted">Last updated by: {{ facade.lastUpdatedBy ?? "" }}</p>
      <div class="row">
        <button @click="increment">+1</button>
        <button @click="decrement">−1</button>
        <button @click="reset">Reset</button>
      </div>
    </section>
  </main>
</template>

<style>
main { font: 14px/1.5 system-ui, sans-serif; max-width: 480px; margin: 2rem auto; padding: 0 1rem; }
section { margin: 1rem 0; padding: 1rem; border: 1px solid #ddd; border-radius: 6px; }
button { font: inherit; padding: 0.4rem 0.8rem; }
.row > * + * { margin-left: 0.5rem; }
.muted { color: #666; }
.err { color: #b00; }
</style>
