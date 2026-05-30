import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { AuthConfig } from "../src/components/AuthConfig";
import { registerComponents } from "../src/registerComponents";

registerComponents();

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function abortablePendingResponse(): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    const signal = vi.mocked(globalThis.fetch).mock.calls.at(-1)?.[1]?.signal;
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
}

describe("AuthConfig (auth0-config)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("registered as a custom element", () => {
    expect(customElements.get("auth0-config")).toBe(AuthConfig);
  });

  it("exposes the expected bindable surface", () => {
    expect(AuthConfig.wcBindable.properties.map((p) => p.name))
      .toEqual(["domain", "clientId", "audience", "remoteUrl", "loading", "error"]);
    expect(AuthConfig.wcBindable.inputs).toEqual([{ name: "src", attribute: "src" }]);
    expect(AuthConfig.wcBindable.commands).toEqual([{ name: "load", async: true }]);
  });

  it("loads config from src and publishes values", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      domain: "tenant.example",
      clientId: "client-123",
      audience: "https://api.example",
      remoteUrl: "ws://localhost:3000",
    }));
    const el = document.createElement("auth0-config") as AuthConfig;

    const events: Array<[string, unknown]> = [];
    for (const type of [
      "auth0-config:domain-changed",
      "auth0-config:client-id-changed",
      "auth0-config:audience-changed",
      "auth0-config:remote-url-changed",
      "auth0-config:loading-changed",
      "auth0-config:error",
    ]) {
      el.addEventListener(type, (event) => events.push([type, (event as CustomEvent).detail]));
    }

    el.src = "/auth-config";
    await el.load();

    expect(fetchMock).toHaveBeenCalledWith("/auth-config", { signal: expect.any(AbortSignal) });
    expect(el.domain).toBe("tenant.example");
    expect(el.clientId).toBe("client-123");
    expect(el.audience).toBe("https://api.example");
    expect(el.remoteUrl).toBe("ws://localhost:3000");
    expect(el.loading).toBe(false);
    expect(el.error).toBeNull();
    expect(events).toContainEqual(["auth0-config:loading-changed", true]);
    expect(events).toContainEqual(["auth0-config:domain-changed", "tenant.example"]);
    expect(events).toContainEqual(["auth0-config:loading-changed", false]);
  });

  it("bubbles state events for delegated listeners", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      domain: "tenant.example",
      clientId: "client-123",
    }));
    const host = document.createElement("div");
    const el = document.createElement("auth0-config") as AuthConfig;
    const bubbled: Array<[string, unknown]> = [];
    host.addEventListener("auth0-config:domain-changed", (event) => {
      bubbled.push([event.type, (event as CustomEvent).detail]);
    });
    host.appendChild(el);
    document.body.appendChild(host);

    el.src = "/auth-config";
    await el.connectedCallbackPromise;

    expect(bubbled).toEqual([["auth0-config:domain-changed", "tenant.example"]]);
  });

  it("auto-loads when connected with src", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      domain: "tenant.example",
      clientId: "client-123",
    }));
    const el = document.createElement("auth0-config") as AuthConfig;

    el.src = "/auth-config";
    document.body.appendChild(el);
    await el.connectedCallbackPromise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(el.domain).toBe("tenant.example");
    expect(el.clientId).toBe("client-123");
  });

  it("coalesces upgrade-time src and connected callbacks into one load", async () => {
    const tag = `x-auth0-config-${crypto.randomUUID().replaceAll("-", "")}`;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      domain: "tenant.example",
      clientId: "client-123",
    }));
    class TestAuthConfig extends AuthConfig {}
    document.body.innerHTML = `<${tag} src="/auth-config"></${tag}>`;

    customElements.define(tag, TestAuthConfig);
    await customElements.whenDefined(tag);
    const el = document.querySelector(tag) as AuthConfig;
    await el.connectedCallbackPromise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(el.domain).toBe("tenant.example");
  });

  it("surfaces HTTP errors and clears loading", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    const el = document.createElement("auth0-config") as AuthConfig;
    el.src = "/auth-config";

    await el.load();

    expect(el.loading).toBe(false);
    expect(el.error?.message).toMatch(/HTTP 500/);
  });

  it("surfaces malformed JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not-json", { status: 200 }));
    const el = document.createElement("auth0-config") as AuthConfig;
    el.src = "/auth-config";

    await el.load();

    expect(el.loading).toBe(false);
    expect(el.error).toBeInstanceOf(Error);
  });

  it("validates the config response shape", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ domain: "tenant.example" }));
    const el = document.createElement("auth0-config") as AuthConfig;
    el.src = "/auth-config";

    await el.load();

    expect(el.loading).toBe(false);
    expect(el.error?.message).toMatch(/clientId/);
    expect(el.domain).toBe("");
  });

  it("reloads when src changes while connected", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ domain: "one.example", clientId: "one" }))
      .mockResolvedValueOnce(jsonResponse({ domain: "two.example", clientId: "two" }));
    const el = document.createElement("auth0-config") as AuthConfig;
    el.src = "/one";
    document.body.appendChild(el);
    await el.connectedCallbackPromise;

    el.src = "/two";
    await el.connectedCallbackPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith("/two", { signal: expect.any(AbortSignal) });
    expect(el.domain).toBe("two.example");
    expect(el.clientId).toBe("two");
  });

  it("clears loading when disconnected during an in-flight load", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => abortablePendingResponse());
    const el = document.createElement("auth0-config") as AuthConfig;
    el.src = "/auth-config";
    document.body.appendChild(el);
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(el.loading).toBe(true);
    el.remove();
    await el.connectedCallbackPromise;

    expect(el.loading).toBe(false);
  });

  it("clears loading when src is removed during an in-flight load", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => abortablePendingResponse());
    const el = document.createElement("auth0-config") as AuthConfig;
    el.src = "/auth-config";
    document.body.appendChild(el);
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(el.loading).toBe(true);
    el.removeAttribute("src");
    await el.connectedCallbackPromise;

    expect(el.loading).toBe(false);
  });

  it("does not let an aborted older load overwrite the latest config", async () => {
    const first = Promise.resolve(jsonResponse({ domain: "old.example", clientId: "old" }));
    const second = Promise.resolve(jsonResponse({ domain: "new.example", clientId: "new" }));
    vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(first as Promise<Response>)
      .mockReturnValueOnce(second as Promise<Response>);
    const el = document.createElement("auth0-config") as AuthConfig;
    el.src = "/auth-config";

    const firstLoad = el.load();
    const secondLoad = el.load();
    await Promise.all([firstLoad, secondLoad]);

    expect(el.domain).toBe("new.example");
    expect(el.clientId).toBe("new");
  });
});