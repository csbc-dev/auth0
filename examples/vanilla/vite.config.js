import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Allow importing ../shared/appCore.js — Vite's default fs.allow only covers
// the project root.
const sharedDir = fileURLToPath(new URL("../shared", import.meta.url));

export default defineConfig({
  server: {
    port: 5173,
    fs: { allow: [".", sharedDir] },
  },
});
