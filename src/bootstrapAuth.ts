import { setConfig } from "./config.js";
import { registerComponents } from "./registerComponents.js";
import { IWritableConfig } from "./types.js";

/**
 * One-shot library initialisation: applies an optional partial config
 * and registers the `<auth0-gate>` / `<auth0-logout>` / `<auth0-session>`
 * custom elements.
 *
 * Configuration is bootstrap-only by design. `setConfig` is not part of
 * the public package exports (`src/index.ts`) — once components are
 * registered, `customElements.define` cannot be undone, so changing
 * `tagNames` post-bootstrap leaves a half-renamed element registry.
 * `triggerAttribute` / `autoTrigger` likewise affect the global click
 * listener installed at element connect time and would not retroactively
 * apply to live elements.
 *
 * Applications that need to reconfigure must do so before the FIRST call
 * to `bootstrapAuth`. There is no way to re-bootstrap with different
 * options after components are registered.
 */
export function bootstrapAuth(userConfig?: IWritableConfig): void {
  if (userConfig) {
    setConfig(userConfig);
  }
  registerComponents();
}
