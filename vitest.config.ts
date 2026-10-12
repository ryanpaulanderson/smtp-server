import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"], testTimeout: 15000 },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          testTimeout: 45000,
          hookTimeout: 45000,
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/mail/note.ts", "src/mail/service.ts", "src/auth/policy.ts"],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
      reporter: ["text", "lcov"],
    },
  },
});
