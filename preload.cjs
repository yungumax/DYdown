/*
 * DYdown 桌面版 · 预加载脚本
 * 向渲染进程暴露安全桥：剪贴板、窗口控制、目录选择、文件定位、自动更新
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dybridge", {
  isDesktop: true,

  readClipboard: () => ipcRenderer.invoke("clipboard:read"),

  minimizeWindow: () => ipcRenderer.send("win:minimize"),
  toggleMaximizeWindow: () => ipcRenderer.send("win:maximize-toggle"),
  closeWindow: () => ipcRenderer.send("win:close"),

  chooseDirectory: () => ipcRenderer.invoke("dialog:choose-dir"),
  openPath: (p) => ipcRenderer.invoke("shell:open-path", p),
  revealPath: (p) => ipcRenderer.invoke("shell:reveal-path", p),

  firstPaint: () => ipcRenderer.send("first-paint"),

  checkUpdate: () => ipcRenderer.invoke("update:check"),
  downloadUpdate: () => ipcRenderer.invoke("update:download"),
  installUpdate: () => ipcRenderer.send("update:install"),

  webLoginOpen: () => ipcRenderer.invoke("login:open"),
  webLoginClose: () => ipcRenderer.send("login:close"),
  onLoginSuccess: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("login-success", listener);
    return () => ipcRenderer.removeListener("login-success", listener);
  },
  /* 启动后后台补抓的昵称/头像（头像 CDN 链接会过期，每次启动刷新一次） */
  onLoginProfile: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("login-profile", listener);
    return () => ipcRenderer.removeListener("login-profile", listener);
  },

  onUpdateProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("update-progress", listener);
    return () => ipcRenderer.removeListener("update-progress", listener);
  },
});
