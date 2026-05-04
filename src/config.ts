import { raiseError } from "./raiseError.js";
import { IConfig, IWritableConfig } from "./types.js";

interface IInternalConfig extends IConfig {
  autoTrigger: boolean;
  triggerAttribute: string;
  tagNames: {
    auth: string;
    authLogout: string;
    authSession: string;
  };
}

const _config: IInternalConfig = {
  autoTrigger: true,
  triggerAttribute: "data-authtarget",
  tagNames: {
    auth: "auth0-gate",
    authLogout: "auth0-logout",
    authSession: "auth0-session",
  },
};

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    deepFreeze((obj as Record<string, unknown>)[key]);
  }
  return obj;
}

function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    clone[key] = deepClone((obj as Record<string, unknown>)[key]);
  }
  return clone as T;
}

let frozenConfig: IConfig | null = null;

export const config: IConfig = _config as IConfig;

export function getConfig(): IConfig {
  if (!frozenConfig) {
    frozenConfig = deepFreeze(deepClone(_config));
  }
  return frozenConfig;
}

/**
 * Merge a partial config into the library's mutable defaults.
 *
 * Fields omitted from `partialConfig` keep their current value —
 * this is a partial update, NOT a replacement. In particular,
 * `tagNames` is merged key-by-key via `Object.assign`: passing
 * `{ tagNames: { auth: "x-auth" } }` rewrites only `tagNames.auth`
 * and leaves `tagNames.authLogout` / `tagNames.authSession` intact.
 * Callers that want to reset a field must pass the desired value
 * explicitly; there is no "unset" sentinel.
 *
 * Invalidates the frozen snapshot returned by `getConfig()` so the
 * next read reflects the mutation.
 */
export function setConfig(partialConfig: IWritableConfig): void {
  if (typeof partialConfig.autoTrigger === "boolean") {
    _config.autoTrigger = partialConfig.autoTrigger;
  }
  if (typeof partialConfig.triggerAttribute === "string") {
    // Reject empty / whitespace-only values. Downstream `target.closest(
    // \`[${triggerAttribute}]\`)` would build the selector `[]`, which
    // throws `SyntaxError: '[]' is not a valid selector` at click time —
    // far from the configuration call site. Failing fast here keeps the
    // diagnostic next to the bad input (typo, empty JSON-sourced config).
    if (partialConfig.triggerAttribute.trim() === "") {
      raiseError(
        "setConfig(): `triggerAttribute` must be a non-empty attribute name. " +
        "An empty string would produce the invalid selector `[]` at click time.",
      );
    }
    _config.triggerAttribute = partialConfig.triggerAttribute;
  }
  if (partialConfig.tagNames) {
    // Reject empty / whitespace-only tag names. `customElements.define("",
    // ...)` throws `SyntaxError: The provided name is not a valid custom
    // element name`, which surfaces during `registerComponents()` —
    // usually far from the offending `setConfig` call. Validate here so
    // the error points at the field the caller actually set.
    //
    // Explicitly skip `undefined` before the empty-string check AND
    // before the assignment. Sibling fields (`autoTrigger`,
    // `triggerAttribute`) naturally skip `undefined` via their
    // `typeof === "boolean" | "string"` guard; without an explicit skip
    // here, `Object.assign(_config.tagNames, { auth: undefined })` would
    // copy the own-enumerable `undefined` over a valid default and break
    // `customElements.define` / tagName comparisons downstream.
    for (const key of ["auth", "authLogout", "authSession"] as const) {
      const value = partialConfig.tagNames[key];
      if (value === undefined) continue;
      // Reject non-string values (null, numbers, objects, …) at the
      // configuration boundary. Without this guard a non-string would
      // be assigned straight onto `_config.tagNames[key]` and surface
      // later as a TypeError from `customElements.define`, far from
      // the offending setConfig call.
      if (typeof value !== "string") {
        raiseError(
          `setConfig(): \`tagNames.${key}\` must be a string; got ${value === null ? "null" : typeof value}.`,
        );
      }
      if (value.trim() === "") {
        raiseError(
          `setConfig(): \`tagNames.${key}\` must be a non-empty custom element name. ` +
          "customElements.define('') would reject it with SyntaxError.",
        );
      }
      // Validate against the basic HTML custom-element shape: a name
      // must start with an ASCII lower-case letter, be lower-case
      // throughout, and contain at least one ASCII hyphen with at
      // least one character on either side
      // (https://html.spec.whatwg.org/#valid-custom-element-name).
      // Without this, a typo like `tagNames.auth = "Auth0Gate"` only
      // surfaces inside `customElements.define`, which throws
      // `SyntaxError: The provided name is not a valid custom element
      // name` from `registerComponents()` — far from the offending
      // setConfig call. Catching it here keeps the diagnostic next to
      // the configuration mistake.
      //
      // The regex approximates the spec rather than implementing the
      // full PCEN (Potentially-Custom-Element-Name) production: it
      // covers `[a-z][a-z0-9]*(-[a-z0-9]+)+` which is the shape every
      // realistic deployment uses (`my-component`, `auth0-gate`,
      // `data-table-row`). Names containing emoji / extended Unicode
      // are technically PCEN-valid but vanishingly rare here, and the
      // simpler regex keeps the failure message actionable. A
      // mismatch falls through to `customElements.define`'s native
      // error in that edge case — same behaviour as before this
      // guard, just with the common 95% caught earlier.
      // Tag-name comparisons in `AuthLogout._findAuth` /
      // `AuthSession._resolveAuth` / `autoTrigger.handleClick` use
      // `tagName.toLowerCase() === config.tagNames.<…>`; enforcing
      // lower-case here at the configuration boundary keeps that
      // comparison correct without sprinkling defensive
      // `.toLowerCase()` calls across every consumer.
      if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(value)) {
        raiseError(
          `setConfig(): \`tagNames.${key}\` must be a valid lower-case custom element name ` +
          `(start with a letter, contain at least one hyphen, lower-case ASCII only); got "${value}".`,
        );
      }
      _config.tagNames[key] = value;
    }
  }
  frozenConfig = null;
}
