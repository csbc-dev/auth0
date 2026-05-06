import { bootstrapAuth } from "@csbc-dev/auth0";
import { bind } from "@wc-bindable/core";
import { defineAppCoreFacade } from "../../shared/appCoreFacade.js";

bootstrapAuth();
defineAppCoreFacade();

const auth = document.getElementById("auth");
auth.setAttribute("domain", import.meta.env.VITE_AUTH0_DOMAIN);
auth.setAttribute("client-id", import.meta.env.VITE_AUTH0_CLIENT_ID);
auth.setAttribute("audience", import.meta.env.VITE_AUTH0_AUDIENCE);
auth.setAttribute("remote-url", import.meta.env.VITE_REMOTE_URL ?? "ws://localhost:3000");
auth.setAttribute("redirect-uri", window.location.origin);

const session    = document.getElementById("session");
const facade     = document.getElementById("facade");
const statusEl   = document.getElementById("status");
const errorEl    = document.getElementById("error");
const loginBtn   = document.getElementById("login");
const logoutBtn  = document.getElementById("logout");
const counterEl  = document.getElementById("counter");
const countEl    = document.getElementById("count");
const lastUserEl = document.getElementById("lastUser");

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
  if (name === "lastUpdatedBy") lastUserEl.textContent = String(value ?? "");
});

const authState = { loading: true, authenticated: false };
const sessionState = { connecting: false, ready: false };

bind(auth, (name, value) => {
  if (name === "loading") authState.loading = value;
  if (name === "authenticated") authState.authenticated = value;
  if (name === "error") {
    if (value) {
      errorEl.hidden = false;
      errorEl.textContent = `Auth error: ${value.message ?? value}`;
    } else {
      errorEl.hidden = true;
    }
  }
  render();
});

bind(session, (name, value) => {
  if (name === "connecting") sessionState.connecting = value;
  if (name === "ready") sessionState.ready = value;
  if (name === "error" && value) {
    errorEl.hidden = false;
    errorEl.textContent = `Session error: ${value.message ?? value}`;
  }
  render();
});

function render() {
  loginBtn.hidden = authState.loading || authState.authenticated;
  logoutBtn.hidden = !authState.authenticated;
  counterEl.hidden = !sessionState.ready;

  if (authState.loading) {
    statusEl.textContent = "Loading Auth0…";
  } else if (!authState.authenticated) {
    statusEl.textContent = "Signed out.";
  } else if (sessionState.connecting) {
    statusEl.textContent = "Opening session…";
  } else if (sessionState.ready) {
    statusEl.textContent = "Session ready.";
  } else {
    statusEl.textContent = "Authenticated, waiting for session…";
  }
}
