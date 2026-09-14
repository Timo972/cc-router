import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Telemetry is off for the whole suite so tests neither read the
    // developer's ~/.cc-router/telemetry.json nor reach PostHog. Telemetry
    // tests opt back in by clearing the kill switch and pointing
    // TELEMETRY_PATH at their own fixture.
    env: {
      CC_ROUTER_TELEMETRY: "0",
      TELEMETRY_PATH: join(tmpdir(), "cc-router-vitest-telemetry.json"),
    },
    typecheck: {
      tsconfig: "./tsconfig.test.json",
    },
    globals: true,
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: [
        "src/proxy/**/*.ts",
        "src/config/**/*.ts",
        "src/utils/**/*.ts",
      ],
      exclude: [
        "src/cli/**",
        "src/ui/**",
        "src/__tests__/**",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
      },
    },
  },
});
