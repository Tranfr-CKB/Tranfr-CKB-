import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The SDK lives outside this package; without dedupe its "@ckb-ccc/core"
    // import would resolve to the repo root's copy, giving two sets of classes.
    // Dedupe also lets the build run with only demo/node_modules installed,
    // which is what the Vercel build does.
    dedupe: ["@ckb-ccc/core"],
  },
  build: {
    // Published under ISC with the sources in the repo; maps make a production
    // stack trace readable.
    sourcemap: true,
    // The wallet connector bundle is inherently large and changes rarely:
    // split it so app changes don't invalidate it in the browser cache.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("@ckb-ccc")) return "ckb-ccc";
          if (id.includes("react")) return "react";
        },
      },
    },
    chunkSizeWarningLimit: 1200,
  },
  server: {
    fs: { allow: [repoRoot] },
  },
});
