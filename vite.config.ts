import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "docs",
    emptyOutDir: true,
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
