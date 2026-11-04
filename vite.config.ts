/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { serviceWorkerPlugin } from "./build/serviceWorkerPlugin";

export default defineConfig({
  // 相対パスで出力し、どのパス（claude.ai の Artifact、GitHub Pages のサブパスなど）に置いても動くようにする
  base: "./",
  plugins: [react(), serviceWorkerPlugin()],
  worker: { format: "es" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
