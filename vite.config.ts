import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  resolve: {
    alias: {
      ...(process.env.MIANSHI_REALTIME_SMOKE === '1' ? {
        '@/lib/realtimeTransport': fileURLToPath(new URL('./tests/fixtures/realtimeTransport.ts',import.meta.url)),
      } : {}),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  envPrefix: ["VITE_", "TAURI_ENV_*"],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1431,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    target: "chrome110",
    sourcemap: false,
  },
}));
