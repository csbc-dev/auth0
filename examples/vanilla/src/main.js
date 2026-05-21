import { bootstrapAuth } from "@csbc-dev/auth0";
import { bind } from "@wc-bindable/core";
import { defineAppCoreFacade } from "../../shared/appCoreFacade.js";

bootstrapAuth();
defineAppCoreFacade();

const auth = document.getElementById("auth");
auth.setAttribute("domain", import.meta.env.VITE_AUTH0_DOMAIN);
auth.setAttribute("client-id", import.meta.env.VITE_AUTH0_CLIENT_ID);
auth.setAttribute("audience", import.meta.env.VITE_AUTH0_AUDIENCE);
// `||` (not `??`) so an empty `VITE_REMOTE_URL=` in .env also falls back to
// the default. With `??`, an empty string would pass through and silently
// flip <auth0-gate> into local mode (it treats `remote-url=""` as "unset").
auth.setAttribute("remote-url", import.meta.env.VITE_REMOTE_URL || "ws://localhost:3000");
auth.setAttribute("redirect-uri", window.location.origin);

const session    = document.getElementById("session");
const facade     = document.getElementById("facade");
const statusEl       = document.getElementById("status");
// Auth and session errors get their own elements so a session error does not
// overwrite an auth error (and vice versa) — matching the React / Vue
// examples, which render the two in separate <p> elements.
const authErrorEl    = document.getElementById("authError");
const sessionErrorEl = document.getElementById("sessionError");
const loginBtn   = document.getElementById("login");
const logoutBtn  = document.getElementById("logout");
const counterEl  = document.getElementById("counter");
const countEl    = document.getElementById("count");
const connectedUserEl = document.getElementById("connectedUser");

loginBtn.addEventListener("click", () => auth.login());
logoutBtn.addEventListener("click", () => auth.logout({ logoutParams: { returnTo: window.location.origin } }));

// Commands are installed by <auth0-session> as own-property forwarders on
// the facade once the proxy is built — no `session.proxy.invoke(...)` glue.
document.getElementById("inc").addEventListener("click", () => facade.increment?.());
document.getElementById("dec").addEventListener("click", () => facade.decrement?.());
document.getElementById("reset").addEventListener("click", () => facade.reset?.());

// Bind directly on the facade (the data-plane element). The session mirrors
// each property update from the proxy onto the facade — bind() picks it up
// from the user's declared event names.
bind(facade, (name, value) => {
  if (name === "count") countEl.textContent = String(value ?? 0);
  if (name === "connectedUser") connectedUserEl.textContent = String(value ?? "");
});

// Mirror the React / Vue examples' `errorText()`: Auth0 SDK errors arrive as
// `{ error, error_description }` plain objects (not Error instances), so a
// bare `value.message ?? value` would render "[object Object]". Prefer
// `message`, then `error`, then a String() fallback.
function errorText(value) {
  if (!value) return "";
  if (value instanceof Error) return value.message;
  if (typeof value === "object" && typeof value.error === "string") return value.error;
  return String(value);
}

const authState = { loading: true, authenticated: false };
const sessionState = { connecting: false, ready: false };

bind(auth, (name, value) => {
  if (name === "loading") authState.loading = value;
  if (name === "authenticated") authState.authenticated = value;
  if (name === "error") {
    if (value) {
      authErrorEl.hidden = false;
      authErrorEl.textContent = `Auth error: ${errorText(value)}`;
    } else {
      authErrorEl.hidden = true;
    }
  }
  render();
});

bind(session, (name, value) => {
  if (name === "connecting") sessionState.connecting = value;
  if (name === "ready") sessionState.ready = value;
  if (name === "error") {
    if (value) {
      sessionErrorEl.hidden = false;
      sessionErrorEl.textContent = `Session error: ${errorText(value)}`;
    } else {
      sessionErrorEl.hidden = true;
    }
  }
  render();
});

function render() {
  loginBtn.hidden = authState.loading || authState.authenticated;
  logoutBtn.hidden = !authState.authenticated;
  counterEl.hidden = !sessionState.ready;

  // Branch order matches the react / vue examples: ready is checked before
  // connecting (ready === true always implies connecting === false, so the
  // order is behaviourally equivalent — kept identical across the 4 examples).
  if (authState.loading) {
    statusEl.textContent = "Loading Auth0…";
  } else if (!authState.authenticated) {
    statusEl.textContent = "Signed out.";
  } else if (sessionState.ready) {
    statusEl.textContent = "Session ready.";
  } else if (sessionState.connecting) {
    statusEl.textContent = "Opening session…";
  } else {
    statusEl.textContent = "Authenticated, waiting for session…";
  }
}
