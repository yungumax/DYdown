import { createApp } from "vue";
import App from "./App.vue";
import "./styles.css";

// 桌面壳以隐藏方式启动，等首帧真正画完再显示窗口（main.js 里监听 ready-to-show）。
// mount 是同步的，但浏览器还没绘制这一帧；连续两次 rAF 后即为首帧已提交，
// 渲染进程发个信号过去，壳层随即显示窗口——一出现就有内容。
createApp(App).mount("#app");

requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    window.dybridge?.firstPaint?.();
  });
});
