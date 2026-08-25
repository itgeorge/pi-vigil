import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "acceptance",
          include: ["test/acceptance/**/*.test.ts"],
          setupFiles: ["test/acceptance/setup.ts"],
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
      {
        test: {
          name: "faux-acceptance",
          include: ["test/faux-acceptance/**/*.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
