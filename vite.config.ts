import { defineConfig } from "vite";

export default defineConfig({
    // Relative, so the build works from any path a Pages site is served under.
    base: "./",
    build: {
        outDir: "dist",
        target: "es2022"
    }
});
