/* 调试（用后即删）：登录态搜索 4K，递归解析结果找带 4K/2K 档的作品 */
const { app, BrowserWindow } = require("electron");

const UA_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/* 递归收集 JSON 树里所有带 aweme_id+video 的对象 */
function collectAwemes(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectAwemes(item, out);
    return;
  }
  if (node && typeof node === "object") {
    if (node.aweme_id && node.video) out.push(node);
    for (const key of Object.keys(node)) {
      if (key === "video") continue;
      collectAwemes(node[key], out);
    }
  }
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: "persist:dylogin",
    },
  });
  const wc = win.webContents;
  wc.setUserAgent(UA_DESKTOP);
  wc.debugger.attach("1.3");
  wc.debugger.sendCommand("Network.enable", {});

  const seen = new Map();
  const found = new Map(); // aweme_id → {desc, gears}

  wc.debugger.on("message", async (_ev, method, params) => {
    if (method === "Network.responseReceived") {
      const r = params.response || {};
      if (/json/i.test(r.mimeType || "") && /douyin\.com/.test(r.url || "")) {
        seen.set(params.requestId, r.url);
      }
      return;
    }
    if (method !== "Network.loadingFinished") return;
    const url = seen.get(params.requestId);
    if (!url) return;
    seen.delete(params.requestId);
    try {
      const body = await wc.debugger.sendCommand("Network.getResponseBody", {
        requestId: params.requestId,
      });
      const json = JSON.parse(body.body);
      const awemes = [];
      collectAwemes(json, awemes);
      for (const a of awemes) {
        if (found.has(a.aweme_id)) continue;
        const gears = (a.video && a.video.bit_rate || []).map(
          (b) => b.gear_name || (b.play_addr && b.play_addr.uri) || "?"
        );
        const hit = /4k|2k/i.test(JSON.stringify(gears));
        found.set(a.aweme_id, {
          desc: String(a.desc || "").slice(0, 26),
          gears: gears.join(","),
          hit,
        });
        if (hit) console.log(`★ ${a.aweme_id} | ${String(a.desc || "").slice(0, 30)} | 档位: ${gears.join(",")}`);
      }
      if (awemes.length) console.log(`[SCAN] ${url.slice(0, 80)} +${awemes.length} (累计 ${found.size})`);
    } catch {}
  });

  wc.loadURL("https://www.douyin.com/search/4K%E8%B6%85%E6%B8%85?type=video").catch((e) =>
    console.log("LOAD-ERR", e.message)
  );
  setTimeout(() => wc.executeJavaScript("window.scrollBy(0, 1800)").catch(() => {}), 9000);
  setTimeout(() => wc.executeJavaScript("window.scrollBy(0, 1800)").catch(() => {}), 14000);

  setTimeout(() => {
    console.log("=== 带 4K/2K 档的作品 ===");
    let i = 0;
    for (const [id, f] of found) {
      if (f.hit && i < 8) {
        console.log(`★ ${id} | ${f.desc}`);
        i += 1;
      }
    }
    console.log(`=== 共扫描 ${found.size} 条，高档 ${i} 条 ===`);
    app.exit(0);
  }, 22000);
});
