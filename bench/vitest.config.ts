import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["bench/**/*.perf.ts"], testTimeout: 600_000 },
});
