// 与后端通信的唯一入口。
//
// DYdown 的后端 = Electron 主进程内嵌的本地服务（server.js，仅 127.0.0.1）。
// 所有数据面走 HTTP（同源 fetch），窗口控制 / 剪贴板 / 目录选择 / 自动更新
// 走 preload 暴露的 window.dybridge。在纯浏览器里打开时（没有桌面壳）
// 对应能力自动降级，界面仍可独立预览。

const bridge = typeof window !== "undefined" ? window.dybridge : null;

export const hasBridge = !!bridge;

// HTTP 统一封装：后端错误约定为 { error: "中文消息" }，直接抛给界面 toast。
async function http(path, body) {
  const options = body !== undefined
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : undefined;
  const res = await fetch(path, options);
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* 非 JSON 响应按 HTTP 状态处理 */
  }
  if (!res.ok || data.error) {
    throw new Error(data.error || `请求失败（HTTP ${res.status}）`);
  }
  return data.data !== undefined ? data.data : data;
}

export async function appStatus() {
  return http("/api/status");
}

export async function appSettings() {
  return http("/api/settings");
}

export async function updateSettings(settings) {
  return http("/api/settings", { settings });
}

// 解析来源：抖音分享链接 / 整段口令 → post（单条作品）
export async function probeSource(input) {
  return http("/api/probe", { input });
}

export async function startDownload(req) {
  return http("/api/download-start", { req });
}

export async function cancelDownload(taskId) {
  return http("/api/download-cancel", { taskId });
}

export async function pauseDownload(taskId) {
  return http("/api/download-pause", { taskId });
}

export async function resumeDownload(taskId) {
  return http("/api/download-resume", { taskId });
}

export async function logout() {
  return http("/api/logout");
}

export async function chooseOutputDir() {
  if (bridge?.chooseDirectory) {
    const dir = await bridge.chooseDirectory();
    if (dir) return dir;
  }
  return http("/api/choose-dir");
}

// 「魔法变量」清单由后端提供，界面不再自己写一份——否则界面会列出后端不支持的变量。
export async function namingVariables() {
  return http("/api/naming-variables");
}

// 批量文件名预览：给每条内容算出文件名，与真实落盘共用同一个渲染器。
export async function previewNames(items, ext) {
  return http("/api/preview-names", { items, ext });
}

// 文件名预览走后端同一个渲染器，预览与真实落盘不会不一致。
export async function previewNaming(template, { date, publish_date, ext, dir } = {}) {
  return http("/api/preview-naming", { template, date, publish_date, ext, dir });
}

/// 启动续传：抖音任务体积小、直链时效短，暂不持久化分片，固定 0
export async function resumePending() {
  return 0;
}

export async function renameDownloaded(items, template, apply) {
  return http("/api/rename-downloaded", { items, template, apply });
}

export async function profileLoadAll(secUid) {
  return http("/api/profile-load-all", { secUid });
}

// 合集：解析某个合集的全部视频（弹可见窗口，用户在窗口里滚动加载）
export async function mixItems(mixId, name) {
  return http("/api/mix-items", { mixId, name });
}

export async function cleanupTemp() {
  return http("/api/cleanup-temp");
}

// 更新检测（设置页手动触发）。桌面壳走 electron-updater（带校验），
// 浏览器预览回退 GitHub API 只读检测。
export async function checkUpdates() {
  if (bridge?.checkUpdate) {
    try {
      return await bridge.checkUpdate();
    } catch (error) {
      return { current: "", latest: "", up_to_date: false, error: String(error) };
    }
  }
  try {
    return await http("/api/check-updates");
  } catch (error) {
    return { current: "", latest: "", up_to_date: false, error: String(error) };
  }
}

// 下载并安装更新（onProgress 收字节流进度；完成后由界面引导重启）
export async function downloadAndInstallUpdate(onProgress) {
  if (!bridge?.downloadUpdate) {
    throw new Error("浏览器预览不支持应用内更新，请到 GitHub Releases 下载");
  }
  let off = null;
  if (onProgress && bridge.onUpdateProgress) {
    off = bridge.onUpdateProgress(onProgress);
  }
  try {
    await bridge.downloadUpdate();
  } finally {
    if (off) off();
  }
}

// 安装已下载的更新并重启
export async function relaunchApp() {
  if (bridge?.installUpdate) {
    bridge.installUpdate();
    return;
  }
  throw new Error("浏览器预览不支持应用内更新");
}

// 兼容导出（App 启动时的静默检测路径已统一走 checkUpdates）
export async function updateCheckPlugin() {
  return null;
}

export async function exportDiagnostics() {
  return http("/api/export-diagnostics");
}

export async function openPath(path) {
  if (bridge?.openPath) return bridge.openPath(path);
  return http("/api/open-path", { path });
}

// 打开文件所在文件夹并选中该文件（资源管理器定位）
export async function revealPath(path) {
  if (bridge?.revealPath) return bridge.revealPath(path);
  return http("/api/reveal-path", { path });
}

// 任务进度推送：后端经 SSE（/api/events）推 task://update。
export function onTaskUpdate(handler) {
  const es = new EventSource("/api/events");
  es.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.task) handler(payload.task);
    } catch {
      /* 心跳等非任务消息忽略 */
    }
  };
  return Promise.resolve(() => es.close());
}

export async function readClipboard() {
  if (bridge?.readClipboard) {
    try {
      return await bridge.readClipboard();
    } catch {
      return "";
    }
  }
  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}

// ---- 窗口控制（自定义标题栏用）----

export async function minimizeWindow() {
  bridge?.minimizeWindow?.();
}

export async function toggleMaximizeWindow() {
  bridge?.toggleMaximizeWindow?.();
}

export async function closeWindow() {
  bridge?.closeWindow?.();
}

// Electron 里窗口底色由主进程设定，这里留空实现（保持导出兼容）
export async function setWindowBackground() {}

// 拖动窗口：桌面壳里由 CSS -webkit-app-region 处理（styles.css），
// 这里只做 no-op，浏览器预览无窗口可拖。
export async function startWindowDrag() {}

// ---- 登录（桌面壳：内嵌抖音登录窗口 + Cookie 收割）----

export async function webLoginOpen() {
  if (bridge?.webLoginOpen) return bridge.webLoginOpen();
  throw new Error("浏览器预览不支持登录，请在桌面版中使用");
}

export async function webLoginClose() {
  bridge?.webLoginClose?.();
}

export function onLoginSuccess(handler) {
  if (bridge?.onLoginSuccess) return bridge.onLoginSuccess(handler);
  return () => {};
}

/* 启动后后台补抓的昵称/头像（订阅后更新标题栏） */
export function onLoginProfile(handler) {
  if (bridge?.onLoginProfile) return bridge.onLoginProfile(handler);
  return () => {};
}
