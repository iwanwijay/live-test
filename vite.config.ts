import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  build: {
    outDir: path.resolve(__dirname, "static"), // Output kompilasi tetap ke folder static/
    emptyOutDir: true,
    target: "es2020",
  },
});
