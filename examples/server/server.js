import { createAuthenticatedWSS } from "@csbc-dev/auth0/server";
import { AppCore } from "../shared/appCore.js";

const port = Number(process.env.PORT ?? 3000);
const auth0Domain = process.env.AUTH0_DOMAIN;
const auth0Audience = process.env.AUTH0_AUDIENCE;
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!auth0Domain || !auth0Audience) {
  console.error("AUTH0_DOMAIN and AUTH0_AUDIENCE are required (see .env.example)");
  process.exit(1);
}

await createAuthenticatedWSS({
  port,
  auth0Domain,
  auth0Audience,
  allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : undefined,
  createCores: (user) => new AppCore(user),
  onTokenRefresh: (core, user) => core.updateUser(user),
  onEvent: (event) => {
    switch (event.type) {
      case "auth:success":
        console.log(`[ws] auth:success ${event.user?.email ?? event.user?.sub}`);
        break;
      case "auth:failure":
        console.warn(`[ws] auth:failure ${event.error?.message}`);
        break;
      case "auth:refresh":
        console.log(`[ws] auth:refresh ${event.user?.email ?? event.user?.sub}`);
        break;
      case "auth:refresh-failure":
        console.warn(`[ws] auth:refresh-failure ${event.error?.message}`);
        break;
      case "connection:close":
        console.log(`[ws] connection:close`);
        break;
    }
  },
});

console.log(`@csbc-dev/auth0 example server listening on ws://localhost:${port}`);
console.log(`  domain:   ${auth0Domain}`);
console.log(`  audience: ${auth0Audience}`);
console.log(`  origins:  ${allowedOrigins.length ? allowedOrigins.join(", ") : "(any)"}`);
