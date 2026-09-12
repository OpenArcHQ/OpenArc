import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const directory = path.dirname(fileURLToPath(import.meta.url));
const buildSha = /^[A-Za-z0-9._-]{1,64}$/u.test(process.env.VITE_COMMIT_SHA ?? "")
  ? (process.env.VITE_COMMIT_SHA ?? "local")
  : "local";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "openarc-build-marker",
      transformIndexHtml(html) {
        return html.replace(
          '<meta name="openarc-build-sha" content="local" />',
          `<meta name="openarc-build-sha" content="${buildSha}" />`,
        );
      },
    },
  ],
  publicDir: path.resolve(directory, "../../assets"),
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    ...(process.env.OPENARC_DEV_API_ORIGIN === "http://127.0.0.1:3003" ? {
      proxy: {
        "/v1/private": { target: process.env.OPENARC_DEV_API_ORIGIN, changeOrigin: false },
        "/v2/auth": { target: process.env.OPENARC_DEV_API_ORIGIN, changeOrigin: false },
        "/v1/operator/organizations": {
          target: process.env.OPENARC_DEV_API_ORIGIN,
          changeOrigin: false,
        },
      },
    } : {}),
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
});
