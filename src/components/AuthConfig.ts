import { IWcBindable } from "../types.js";

type AuthConfigPayload = {
  domain: string;
  clientId: string;
  audience?: string;
  remoteUrl?: string;
};

function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function readString(value: unknown, name: keyof AuthConfigPayload, required: boolean): string {
  if (typeof value === "string") return value;
  if (!required && value === undefined) return "";
  throw new Error(
    `[@csbc-dev/auth0] <auth0-config>: config response field \`${name}\` must be a string.`,
  );
}

function parsePayload(value: unknown): AuthConfigPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("[@csbc-dev/auth0] <auth0-config>: config response must be a JSON object.");
  }

  const record = value as Record<string, unknown>;
  return {
    domain: readString(record.domain, "domain", true),
    clientId: readString(record.clientId, "clientId", true),
    audience: readString(record.audience, "audience", false),
    remoteUrl: readString(record.remoteUrl, "remoteUrl", false),
  };
}

/**
 * `<auth0-config>` — browser-side counterpart to `createAuthConfigHandler()`.
 *
 * Fetches a public Auth0 boot-config JSON document and exposes it as
 * wc-bindable state. It intentionally does not talk to `<auth0-gate>`
 * directly; applications wire the emitted values into whichever auth gate
 * they want via framework bindings, `@wc-bindable/core`, or `data-wcs`.
 */
export class AuthConfig extends HTMLElement {
  static hasConnectedCallbackPromise = true;

  static wcBindable: IWcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "domain",    event: "auth0-config:domain-changed" },
      { name: "clientId",  event: "auth0-config:client-id-changed" },
      { name: "audience",  event: "auth0-config:audience-changed" },
      { name: "remoteUrl", event: "auth0-config:remote-url-changed" },
      { name: "loading",   event: "auth0-config:loading-changed" },
      { name: "error",     event: "auth0-config:error" },
    ],
    inputs: [
      { name: "src", attribute: "src" },
    ],
    commands: [
      { name: "load", async: true },
    ],
  };

  static get observedAttributes(): string[] {
    return ["src"];
  }

  private _domain = "";
  private _clientId = "";
  private _audience = "";
  private _remoteUrl = "";
  private _loading = false;
  private _error: Error | null = null;
  private _connectedCallbackPromise: Promise<void> = Promise.resolve();
  private _abortController: AbortController | null = null;
  private _loadGeneration = 0;
  private _autoLoadQueued = false;
  private _autoLoadPromise: Promise<void> | null = null;

  get src(): string {
    return this.getAttribute("src") || "";
  }

  set src(value: string) {
    this.setAttribute("src", value);
  }

  get domain(): string {
    return this._domain;
  }

  get clientId(): string {
    return this._clientId;
  }

  get audience(): string {
    return this._audience;
  }

  get remoteUrl(): string {
    return this._remoteUrl;
  }

  get loading(): boolean {
    return this._loading;
  }

  get error(): Error | null {
    return this._error;
  }

  get connectedCallbackPromise(): Promise<void> {
    return this._connectedCallbackPromise;
  }

  connectedCallback(): void {
    if (this.src) {
      this._connectedCallbackPromise = this._queueAutoLoad();
    }
  }

  disconnectedCallback(): void {
    this._autoLoadQueued = false;
    this._autoLoadPromise = null;
    this._abortController?.abort();
    this._abortController = null;
    this._loadGeneration++;
    this._setLoading(false);
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue || name !== "src" || !this.isConnected) return;
    if (newValue) {
      this._connectedCallbackPromise = this._queueAutoLoad();
    } else {
      this._autoLoadQueued = false;
      this._autoLoadPromise = null;
      this._abortController?.abort();
      this._abortController = null;
      this._loadGeneration++;
      this._setLoading(false);
    }
  }

  async load(): Promise<void> {
    this._autoLoadQueued = false;
    const src = this.src;
    if (!src) return;

    const generation = ++this._loadGeneration;
    this._abortController?.abort();
    const abortController = new AbortController();
    this._abortController = abortController;

    this._setError(null);
    this._setLoading(true);

    try {
      const response = await fetch(src, { signal: abortController.signal });
      if (!response.ok) {
        throw new Error(`[@csbc-dev/auth0] <auth0-config>: config fetch failed: HTTP ${response.status}`);
      }
      const payload = parsePayload(await response.json());
      if (generation !== this._loadGeneration) return;
      this._setDomain(payload.domain);
      this._setClientId(payload.clientId);
      this._setAudience(payload.audience || "");
      this._setRemoteUrl(payload.remoteUrl || "");
      this._setLoading(false);
    } catch (err) {
      if (generation !== this._loadGeneration || abortController.signal.aborted) return;
      this._setError(normalizeError(err));
      this._setLoading(false);
    } finally {
      if (this._abortController === abortController) {
        this._abortController = null;
      }
    }
  }

  private _queueAutoLoad(): Promise<void> {
    if (this._autoLoadQueued && this._autoLoadPromise) return this._autoLoadPromise;

    this._autoLoadQueued = true;
    this._autoLoadPromise = Promise.resolve().then(async () => {
      if (!this._autoLoadQueued) return;
      this._autoLoadQueued = false;
      this._autoLoadPromise = null;
      if (!this.isConnected || !this.src) return;
      await this.load();
    });
    return this._autoLoadPromise;
  }

  private _dispatchValueEvent(type: string, value: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail: value, bubbles: true }));
  }

  private _setDomain(value: string): void {
    if (this._domain === value) return;
    this._domain = value;
    this._dispatchValueEvent("auth0-config:domain-changed", value);
  }

  private _setClientId(value: string): void {
    if (this._clientId === value) return;
    this._clientId = value;
    this._dispatchValueEvent("auth0-config:client-id-changed", value);
  }

  private _setAudience(value: string): void {
    if (this._audience === value) return;
    this._audience = value;
    this._dispatchValueEvent("auth0-config:audience-changed", value);
  }

  private _setRemoteUrl(value: string): void {
    if (this._remoteUrl === value) return;
    this._remoteUrl = value;
    this._dispatchValueEvent("auth0-config:remote-url-changed", value);
  }

  private _setLoading(value: boolean): void {
    if (this._loading === value) return;
    this._loading = value;
    this._dispatchValueEvent("auth0-config:loading-changed", value);
  }

  private _setError(value: Error | null): void {
    if (this._error === value) return;
    this._error = value;
    this._dispatchValueEvent("auth0-config:error", value);
  }
}