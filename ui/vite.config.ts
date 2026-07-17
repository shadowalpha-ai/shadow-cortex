import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev mode proxies API calls to the running engine, so `npm run ui:dev`
// hot-reloads the dashboard against live engine state on port 7777.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:7777",
        changeOrigin: true,
      },
    },
  },
});
