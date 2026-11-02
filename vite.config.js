import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  worker: { format: "es" },
  build: {
    target: "es2022",
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        loops: resolve(import.meta.dirname, "loops/index.html"),
      },
    },
  },
});
