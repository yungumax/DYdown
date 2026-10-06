import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// 前端构建产物交给 Electron 内嵌的本地服务（server.js）托管，
// base 用相对路径；构建输出到 dist-web/。
export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  base: "./",
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist-web",
    emptyOutDir: true,
    target: "chrome110",
    sourcemap: false,
  },
});
