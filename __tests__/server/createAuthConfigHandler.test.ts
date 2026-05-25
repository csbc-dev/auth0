import { describe, it, expect, vi } from "vitest";
import {
  createAuthConfigHandler,
  resolveRemoteUrl,
} from "../../src/server/createAuthConfigHandler";

function createReq(overrides: Record<string, any> = {}) {
  return {
    method: "GET",
    url: "/auth-config",
    headers: {},
    socket: {},
    ...overrides,
  } as any;
}

function createRes() {
  const headers: Record<string, string> = {};
  return {
    statusCode: 200,
    headers,
    body: undefined as string | undefined,
    ended: false,
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v;
    },
    getHeader(k: string) {
      return headers[k.toLowerCase()];
    },
    writeHead(code: number, hdrs?: Record<string, string>) {
      this.statusCode = code;
      if (hdrs) for (const [k, v] of Object.entries(hdrs)) headers[k.toLowerCase()] = v;
    },
    end(b?: string) {
      this.body = b;
      this.ended = true;
    },
  } as any;
}

const base = { domain: "tenant.auth0.com", clientId: "spa-123", audience: "https://api" };

describe("createAuthConfigHandler", () => {
  it("serves the config JSON on GET with any-origin CORS when no allowlist", () => {
    const handle = createAuthConfigHandler({ ...base });
    const req = createReq({ headers: { origin: "https://anywhere.example" } });
    const res = createRes();

    expect(handle(req, res)).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.getHeader("access-control-allow-origin")).toBe("*");
    expect(res.getHeader("content-type")).toMatch(/application\/json/);
    expect(res.getHeader("cache-control")).toBe("private, max-age=60");

    const body = JSON.parse(res.body!);
    expect(body).toMatchObject({
      domain: "tenant.auth0.com",
      clientId: "spa-123",
      audience: "https://api",
    });
  });

  it("derives remoteUrl from Host (ws) by default", () => {
    const handle = createAuthConfigHandler({ ...base });
    const res = createRes();
    handle(createReq({ headers: { host: "example.com:3000" } }), res);
    expect(JSON.parse(res.body!).remoteUrl).toBe("ws://example.com:3000");
  });

  it("derives wss from X-Forwarded-Proto: https", () => {
    const handle = createAuthConfigHandler({ ...base });
    const res = createRes();
    handle(
      createReq({ headers: { host: "example.com", "x-forwarded-proto": "https" } }),
      res,
    );
    expect(JSON.parse(res.body!).remoteUrl).toBe("wss://example.com");
  });

  it("uses a string remoteUrl verbatim", () => {
    const handle = createAuthConfigHandler({ ...base, remoteUrl: "wss://fixed.example/ws" });
    const res = createRes();
    handle(createReq({ headers: { host: "ignored.example" } }), res);
    expect(JSON.parse(res.body!).remoteUrl).toBe("wss://fixed.example/ws");
  });

  it("calls a remoteUrl function with the request", () => {
    const fn = vi.fn(() => "wss://derived.example");
    const handle = createAuthConfigHandler({ ...base, remoteUrl: fn });
    const req = createReq({ headers: { host: "h.example" } });
    const res = createRes();
    handle(req, res);
    expect(fn).toHaveBeenCalledWith(req);
    expect(JSON.parse(res.body!).remoteUrl).toBe("wss://derived.example");
  });

  it("merges extend() fields and lets them override built-ins", () => {
    const handle = createAuthConfigHandler({
      ...base,
      extend: () => ({ featureFlags: { beta: true }, audience: "overridden" }),
    });
    const res = createRes();
    handle(createReq({ headers: { host: "h" } }), res);
    const body = JSON.parse(res.body!);
    expect(body.featureFlags).toEqual({ beta: true });
    expect(body.audience).toBe("overridden");
  });

  it("respects a custom path and cacheControl", () => {
    const handle = createAuthConfigHandler({
      ...base,
      path: "/config.json",
      cacheControl: "no-store",
    });
    const res = createRes();
    expect(handle(createReq({ url: "/config.json", headers: { host: "h" } }), res)).toBe(true);
    expect(res.getHeader("cache-control")).toBe("no-store");
  });

  it("matches the path even with a trailing query string", () => {
    const handle = createAuthConfigHandler({ ...base });
    const res = createRes();
    expect(handle(createReq({ url: "/auth-config?t=123", headers: { host: "h" } }), res)).toBe(
      true,
    );
    expect(res.statusCode).toBe(200);
  });

  it("returns false (untouched) for a non-matching path", () => {
    const handle = createAuthConfigHandler({ ...base });
    const res = createRes();
    expect(handle(createReq({ url: "/something-else" }), res)).toBe(false);
    expect(res.ended).toBe(false);
  });

  it("returns false for a non-GET/OPTIONS method on the path", () => {
    const handle = createAuthConfigHandler({ ...base });
    const res = createRes();
    expect(handle(createReq({ method: "POST" }), res)).toBe(false);
    expect(res.ended).toBe(false);
  });

  it("answers OPTIONS preflight with 204 and allowed methods", () => {
    const handle = createAuthConfigHandler({ ...base, allowedOrigins: ["https://app.example"] });
    const res = createRes();
    expect(
      handle(createReq({ method: "OPTIONS", headers: { origin: "https://app.example" } }), res),
    ).toBe(true);
    expect(res.statusCode).toBe(204);
    expect(res.getHeader("access-control-allow-methods")).toMatch(/GET/);
    expect(res.getHeader("access-control-allow-origin")).toBe("https://app.example");
    expect(res.getHeader("vary")).toBe("Origin");
  });

  it("echoes an allowed origin and serves the body", () => {
    const handle = createAuthConfigHandler({ ...base, allowedOrigins: ["https://app.example"] });
    const res = createRes();
    handle(createReq({ headers: { origin: "https://app.example", host: "h" } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.getHeader("access-control-allow-origin")).toBe("https://app.example");
    expect(res.getHeader("vary")).toBe("Origin");
  });

  it("returns 403 (no body) for a disallowed origin when an allowlist is set", () => {
    const handle = createAuthConfigHandler({ ...base, allowedOrigins: ["https://app.example"] });
    const res = createRes();
    expect(
      handle(createReq({ headers: { origin: "https://evil.example", host: "h" } }), res),
    ).toBe(true);
    expect(res.statusCode).toBe(403);
    expect(res.getHeader("access-control-allow-origin")).toBeUndefined();
    expect(res.body).toBeUndefined();
  });
});

describe("resolveRemoteUrl", () => {
  it("returns a non-empty string verbatim", () => {
    expect(resolveRemoteUrl("wss://x", createReq())).toBe("wss://x");
  });

  it("falls through an empty string to header derivation", () => {
    expect(resolveRemoteUrl("", createReq({ headers: { host: "h.example" } }))).toBe(
      "ws://h.example",
    );
  });

  it("infers wss from an encrypted socket", () => {
    expect(
      resolveRemoteUrl(undefined, createReq({ headers: { host: "h" }, socket: { encrypted: true } })),
    ).toBe("wss://h");
  });

  it("returns '' when no Host header is present", () => {
    expect(resolveRemoteUrl(undefined, createReq({ headers: {} }))).toBe("");
  });
});
