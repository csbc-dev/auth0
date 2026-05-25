import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthConfigHandlerOptions } from "../types.js";

const DEFAULT_PATH = "/auth-config";
const DEFAULT_CACHE_CONTROL = "private, max-age=60";

/**
 * Build a framework-agnostic HTTP request handler that serves the
 * **non-secret** Auth0 client config (`domain` / `clientId` /
 * `audience` / `remoteUrl`) as JSON.
 *
 * The returned function is a **predicate-style** handler: it returns
 * `true` once it has fully handled the request (so the caller should
 * `return` immediately), and `false` when the request is not for this
 * endpoint (so the caller continues its own routing). This lets it
 * compose inside a raw `node:http` request listener, or be adapted for
 * Express / Fastify, without the package owning the whole HTTP layer:
 *
 * ```js
 * const serveAuthConfig = createAuthConfigHandler({ domain, clientId, audience, allowedOrigins });
 * const httpServer = createServer((req, res) => {
 *   if (serveAuthConfig(req, res)) return;   // handled /auth-config (+ its OPTIONS)
 *   // ...your own routes (/_shared/, /healthz), 426 fallback...
 * });
 * ```
 *
 * It owns ONLY its own response — CORS headers, status, and body for
 * the config path. It is NOT a general CORS middleware and never writes
 * to `res` for paths it does not handle, so it co-exists with whatever
 * routing the application already has.
 *
 * Security note: the four values are designed to ship to every browser
 * in any Auth0 SPA flow (an SPA has no client secret). `allowedOrigins`
 * gates *which browser origins* can read the endpoint via CORS — it is
 * a delivery convenience, not a secrecy boundary. See
 * docs/patterns/server-config-discovery.md. When an allowlist is set,
 * requests without an `Origin` header are rejected with 403 as an
 * intentional parity rule with the WebSocket handshake path.
 */
export function createAuthConfigHandler(
  options: AuthConfigHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => boolean {
  const path = options.path ?? DEFAULT_PATH;
  const cacheControl = options.cacheControl ?? DEFAULT_CACHE_CONTROL;
  const allowedOrigins = options.allowedOrigins ?? [];

  return function handle(req: IncomingMessage, res: ServerResponse): boolean {
    // Route on the pathname only, so a trailing query string (a
    // cache-buster like `/auth-config?t=…`) still resolves the endpoint.
    // Base is a dummy origin — only the path is read.
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== path) return false;

    const method = req.method ?? "GET";
    // Only GET (config) and OPTIONS (preflight) are ours. Anything else
    // on this path (POST, etc.) is left for the caller to reject, rather
    // than silently swallowed by returning `true`.
    if (method !== "GET" && method !== "OPTIONS") return false;

    const origin = req.headers.origin;
    const originAllowed =
      allowedOrigins.length === 0 || (!!origin && allowedOrigins.includes(origin));

    // CORS headers, scoped to THIS response. Empty allowlist = any
    // origin (dev only — mirrors the WebSocket layer's permissive dev
    // default); a populated allowlist echoes only listed origins.
    if (allowedOrigins.length === 0) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    } else if (origin && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }

    if (method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.statusCode = 204;
      res.end();
      return true;
    }

    // GET. Apply the same origin policy as the WebSocket upgrade so the
    // two surfaces share one rule. This 403 is for behavioural symmetry,
    // not secrecy (a non-browser client can spoof Origin); the CORS
    // header above is what actually stops a browser on a disallowed
    // origin from reading the body.
    if (allowedOrigins.length > 0 && !originAllowed) {
      res.statusCode = 403;
      res.end();
      return true;
    }

    const body: Record<string, unknown> = {
      domain: options.domain,
      clientId: options.clientId,
      audience: options.audience,
      remoteUrl: resolveRemoteUrl(options.remoteUrl, req),
    };
    // Merge caller extensions last so they can override built-ins.
    if (options.extend) {
      Object.assign(body, options.extend(req));
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", cacheControl);
    res.statusCode = 200;
    res.end(JSON.stringify(body));
    return true;
  };
}

/**
 * Resolve the WebSocket URL advertised in the config body.
 *
 * - `string` (non-empty) → used verbatim.
 * - function → called with the request.
 * - `undefined` / empty string → derived from `Host` and (when present)
 *   `X-Forwarded-Proto`; TLS is inferred from that header or from an
 *   encrypted underlying socket. Returns `""` when no `Host` header is
 *   present (HTTP/1.0 edge case) — `<auth0-gate>` treats an empty
 *   `remote-url` as unset.
 *
 * Exported for direct testing and reuse; `createAuthConfigHandler` calls
 * it for the default branch.
 */
export function resolveRemoteUrl(
  remoteUrl: AuthConfigHandlerOptions["remoteUrl"],
  req: IncomingMessage,
): string {
  if (typeof remoteUrl === "string" && remoteUrl) return remoteUrl;
  if (typeof remoteUrl === "function") return remoteUrl(req);

  const host = req.headers.host;
  if (!host) return "";
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const secure =
    forwardedProto === "https" ||
    (req.socket as { encrypted?: boolean } | undefined)?.encrypted === true;
  return `${secure ? "wss" : "ws"}://${host}`;
}
