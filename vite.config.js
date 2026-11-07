import { resolve } from "node:path";
import { defineConfig } from "vite";

// Invite links (/i/<code>) all open the invite page, as vercel.json and
// scripts/serve-local.mjs rewrite them; this does the same for vite dev/preview.
const INVITE_LINK = /^\/i\/[A-Za-z0-9_-]+\/?(\?.*)?$/;
// Returns nothing on purpose: Vite runs a returned function as a post hook.
const rewriteInvites = (server) => {
  server.middlewares.use((req, _res, next) => {
    if (INVITE_LINK.test(req.url)) req.url = "/i/";
    next();
  });
};
const inviteLinks = { name: "irl-invite-links", configureServer: rewriteInvites, configurePreviewServer: rewriteInvites };

export default defineConfig({
  plugins: [inviteLinks],
  build: {
    target: "es2022",
    // Mediabunny (MP4 writer, ~700 kB) is a lazy chunk loaded only when someone
    // saves or shares a video; nothing else is near this size.
    chunkSizeWarningLimit: 800,
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        loops: resolve(import.meta.dirname, "loops/index.html"),
        friends: resolve(import.meta.dirname, "friends/index.html"),
        invite: resolve(import.meta.dirname, "i/index.html"),
        review: resolve(import.meta.dirname, "review/index.html"),
        how: resolve(import.meta.dirname, "how/index.html"),
      },
    },
  },
});
