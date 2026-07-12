import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: [
        "src/analytics.ts",
        "src/auth.ts",
        "src/byte-utils.ts",
        "src/client.ts",
        "src/config.ts",
        "src/errors.ts",
        "src/models.ts",
        "src/text-utils.ts",
        "src/zip-utils.ts",
      ],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 85,
        statements: 85,
        perFile: true,
      },
    },
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
