# Local mode threat model

Local mode is the default `@csbc-dev/auth0` shape: `<auth0-gate>` runs the Auth0 SPA SDK in the browser and application code may read an access token through `authEl.token` or `await authEl.getToken()`.

That is useful for REST and GraphQL backends that expect `Authorization: Bearer ...`, but it has a different security posture from remote mode. In local mode, any JavaScript that can run in the page can attempt to read the token.

## What local mode protects

The token is intentionally excluded from the `<auth0-gate>` bindable surface:

- It is not listed in `Auth.wcBindable.properties` or `AuthShell.wcBindable.properties`.
- It cannot be read through `data-wcs` bindings.
- Remote mode returns `null` from `.token` and throws from `getToken()`.

This prevents accidental framework-state or declarative-binding leakage. It does not make the token secret from same-page JavaScript in local mode, because local mode exists specifically to let application code attach the bearer to outbound HTTP requests.

## Main risk: XSS becomes token exfiltration

If an attacker can execute script in the application origin, they can call `getToken()` in local mode and send the returned bearer elsewhere. Treat local mode as an SPA bearer-token model with the normal XSS implications.

Practical mitigations live mostly in the application, not this package:

- Keep Auth0's default in-memory cache unless you have a specific reason to set `cache-location="localstorage"`.
- Use a strict Content Security Policy and avoid inline script sinks.
- Sanitize user-provided HTML before it reaches the DOM.
- Keep dependencies and build-time transforms under review.
- Request the narrowest `audience` and `scope` that your backend actually needs.

## Redirect and origin configuration

Auth0 redirect callback URLs, logout URLs, and web origins are part of the trust boundary. Configure them as narrowly as possible for each environment.

For local development examples, the allowed origins are explicit localhost ports. For production, avoid wildcard callback URLs and keep staging / production Auth0 applications separate unless your tenant policy intentionally centralizes them.

## When to prefer remote mode

Prefer remote mode when the application has a long-lived server-side Core or when exposing bearer tokens to arbitrary application JavaScript is not acceptable.

Remote mode keeps token handling inside `<auth0-gate>`:

- The token crosses the network only in the WebSocket handshake and in-band `auth:refresh`.
- Application JS binds to authenticated Core state, not to the token.
- `getToken()` throws and `.token` is `null`.

Remote mode is usually the better fit for multi-tenant SaaS dashboards, high-value administrative tools, and CSBC applications whose business logic already lives on the server.

Local mode remains the right fit for conventional SPAs that call stateless HTTP APIs and already use bearer-token authorization at the fetch layer.

## Non-goals

`@csbc-dev/auth0` does not attempt to hide a local-mode token from same-origin JavaScript. A browser component cannot both expose a bearer for application fetch calls and prevent that same application JavaScript from reading it.

The package boundary is therefore:

- Prevent accidental token exposure through the bindable / declarative surface.
- Make remote mode available when token confinement is required.
- Document the local-mode tradeoff plainly so integrators choose the right mode.