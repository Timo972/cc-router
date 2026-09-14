import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
