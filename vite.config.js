import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2022",
    // Mediabunny (MP4 writer, ~700 kB) is a lazy chunk loaded only when someone
    // saves or shares a video; nothing else is near this size.
    chunkSizeWarningLimit: 800,
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        loops: resolve(import.meta.dirname, "loops/index.html"),
      },
    },
  },
});
