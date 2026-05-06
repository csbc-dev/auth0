import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";

const sharedDir = fileURLToPath(new URL("../shared", import.meta.url));

export default defineConfig({
  plugins: [
    vue({
      template: {
        // Treat <auth0-*> and the user's payload tag as native custom elements
        // so Vue does not try to resolve them as Vue components.
        compilerOptions: {
          isCustomElement: (tag) => tag.startsWith("auth0-") || tag === "app-core-facade",
        },
      },
    }),
  ],
  server: {
    port: 5175,
    fs: { allow: [".", sharedDir] },
  },
});
