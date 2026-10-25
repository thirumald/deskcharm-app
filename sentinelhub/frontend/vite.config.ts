import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// VITE_API_URL unset  -> in-browser simulator (no backend needed)
// VITE_API_URL=/api-proxy style setups can be added via the dev proxy below.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: process.env.SENTINEL_API ?? "http://localhost:8080", changeOrigin: true },
      "/hubs": { target: process.env.SENTINEL_API ?? "http://localhost:8080", changeOrigin: true, ws: true },
    },
  },
  build: { chunkSizeWarningLimit: 1500 },
});
