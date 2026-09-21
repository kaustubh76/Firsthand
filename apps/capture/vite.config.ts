import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "FIRSTHAND Capture",
        short_name: "FIRSTHAND",
        description:
          "One tap: stamp what you capture with a passport of origin, price and consent.",
        theme_color: "#0a0b10",
        background_color: "#0a0b10",
        display: "standalone",
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml" },
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
      workbox: { globPatterns: ["**/*.{js,css,html,svg,png}"] },
    }),
  ],
  // The committed deploy tree (deploy/capture) is built without maps to keep the diff small.
  build: { target: "es2022", sourcemap: process.env["FH_SOURCEMAP"] !== "false" },
  // The Evidence tab imports experiments/results/*.json from the repo root.
  server: { port: 5173, fs: { allow: [".", "../../experiments/results"] } },
});
