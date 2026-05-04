import { Auth } from "./components/Auth.js";
import { AuthLogout } from "./components/AuthLogout.js";
import { AuthSession } from "./components/AuthSession.js";
import { config } from "./config.js";
import { ERROR_PREFIX } from "./raiseError.js";

/**
 * Register a custom element under `tagName`, OR verify that the
 * already-registered constructor is the one we expect.
 *
 * The naive `if (!customElements.get(tag)) define(tag, ctor)` shape
 * silently no-ops when a *different* constructor is already registered
 * under the same tag — typically caused by a duplicate package install
 * (two copies of `@csbc-dev/auth0` resolved through different
 * dependency paths in a monorepo), a micro-frontend that bundles its
 * own copy, or a downstream consumer that re-defined the tag manually.
 * The element appears in the DOM but reacts to none of THIS package's
 * code, producing an opaque "<auth0-gate> doesn't work" with no
 * console signal pointing at the root cause.
 *
 * Throwing here surfaces the duplication immediately at the
 * `bootstrapAuth()` / `registerComponents()` call site — far easier to
 * trace than a silent miswire discovered later. The cross-check via
 * `customElements.getName?.(ctor)` also catches the inverse case where
 * THIS package's constructor was already defined under a different
 * tag (e.g. `setConfig({ tagNames: { auth: "x-auth" } })` was called
 * after the first `bootstrapAuth()` and a second one ran with a fresh
 * tag name); both ends of the misregistration are equally
 * un-debuggable without the explicit error.
 */
function defineOrVerify(tagName: string, ctor: CustomElementConstructor): void {
  const existing = customElements.get(tagName);
  if (existing && existing !== ctor) {
    throw new Error(
      `${ERROR_PREFIX} registerComponents(): tag "${tagName}" is already ` +
      `registered with a different constructor. This usually means a ` +
      `duplicate copy of @csbc-dev/auth0 is loaded (monorepo dedup miss, ` +
      `micro-frontend bundling its own copy, or a manual customElements.define ` +
      `with the same tag). De-duplicate the install or pick a unique tag via ` +
      `setConfig({ tagNames: { ... } }) before calling bootstrapAuth().`,
    );
  }
  // `customElements.getName` is widely shipped but optional in older
  // Lit / jsdom shims; guard so the verify path degrades to a no-op
  // rather than throwing on a missing method, which would force every
  // test environment to polyfill it just to register the package.
  const getName = (customElements as unknown as {
    getName?: (c: CustomElementConstructor) => string | null;
  }).getName;
  if (typeof getName === "function") {
    const existingName = getName.call(customElements, ctor);
    if (existingName && existingName !== tagName) {
      throw new Error(
        `${ERROR_PREFIX} registerComponents(): constructor for "${tagName}" ` +
        `is already registered under a different tag "${existingName}". ` +
        `This usually means setConfig({ tagNames: { ... } }) was called ` +
        `after the first bootstrapAuth(). Pick the tag once at bootstrap ` +
        `time; renaming a registered custom element is not supported by the ` +
        `customElements registry.`,
      );
    }
  }
  if (!existing) {
    customElements.define(tagName, ctor);
  }
}

export function registerComponents(): void {
  defineOrVerify(config.tagNames.auth, Auth);
  defineOrVerify(config.tagNames.authLogout, AuthLogout);
  defineOrVerify(config.tagNames.authSession, AuthSession);
}
