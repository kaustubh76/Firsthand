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
        theme_color: "#0b0b0f",
        background_color: "#0b0b0f",
        display: "standalone",
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
      },
      workbox: { globPatterns: ["**/*.{js,css,html,svg}"] },
    }),
  ],
  build: { target: "es2022", sourcemap: true },
  server: { port: 5173 },
});
