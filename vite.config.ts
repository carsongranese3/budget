import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy: { "/api": `http://127.0.0.1:${process.env.PORT ?? 5174}` } },
  build: { outDir: "../dist", emptyOutDir: true },
  test: { root: ".", include: ["{server,shared,web}/**/*.test.ts", "test/**/*.test.ts"] },
});
