/*
 * DYdown 桌面版 · Electron 主进程
 * - 无边框窗口 + 自绘标题栏（拖拽/双击最大化由前端 CSS 处理）
 * - 内嵌本地服务（server.cjs，仅 127.0.0.1）托管界面与下载引擎
 * - electron-updater 自动更新（GitHub Releases，设置里开启后启动检测）
 */
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, clipboard, session, protocol } = require("electron");
const path = require("path");
const fs = require("fs");

/* 数据目录先于 server.cjs 加载时确定（设置/日志/诊断都在这里） */
process.env.DYDOWN_DATA_DIR = app.getPath("userData");

const COOKIES_PATH = path.join(app.getPath("userData"), "cookies.json");
/* 头像本地缓存：抖音 CDN 链接带签名会过期，抓到后存一份，前端走本地服务显示 */
const AVATAR_PATH = path.join(app.getPath("userData"), "avatar.jpg");
const UA_MOBILE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
/* 登录窗口用桌面 Chrome UA：默认 UA 带 Electron 标识会被抖音风控拦成 JSON 错误页 */
const UA_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const { autoUpdater } = require("electron-updater");
const { startServer } = require("./server.cjs");
/* 页面内 ID 收集器脚本（独立文件，避免转义问题） */
const EXTRACT_IDS_JS = fs.readFileSync(path.join(__dirname, "extract-ids.js"), "utf8");
/* 合集卡片 DOM 提取器（拦截器数据缺失时的兜底） */
const MIX_CARDS_JS = fs.readFileSync(path.join(__dirname, "mix-cards.js"), "utf8");
/* 登录态下从页面读头像 URL（多候选选择器；抖音头像 CDN 特征是 aweme-avatar） */
const PROFILE_AVATAR_JS =
  "(function(){try{var sels=['[data-e2e=\"user-info\"] img','img[src*=\"aweme-avatar\"]'];" +
  "for(var i=0;i<sels.length;i++){var e=document.querySelector(sels[i]);" +
  "if(e&&e.src&&/^https?:/.test(e.src))return e.src;}}catch(x){}return '';})()";
/* 登录态下从页面读昵称：优先专用容器；否则用"头像所在容器的文本以『昵称+关注N』开头"
   的规律提取（实测抖音精选页结构：文本流为 `{昵称}关注{n}粉丝{n}...`） */
const PROFILE_NICKNAME_JS =
  "(function(){try{" +
  "var e=document.querySelector('[data-e2e=\"user-info\"] .nickname');" +
  "var t=e&&e.textContent?e.textContent.trim():'';" +
  "if(t&&t.length<30&&t.indexOf('登录')<0)return t;" +
  "var av=document.querySelector('img[src*=\"aweme-avatar\"]');" +
  "if(av){var p=av;for(var d=0;d<4&&p;d++){p=p.parentElement;if(!p)break;" +
  "var x=(p.textContent||'').replace(/\\s+/g,'');" +
  "var m=x.match(/^(.{1,20}?)关注\\d/);if(m&&m[1])return m[1];}}" +
  "}catch(x){}return '';})()";

let win = null;
let serverPort = 3000;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* 全局导航防护：抖音页面里的"打开 App"代码会尝试调起自定义协议
   （bitbrowser://、douyin://、snssdk:// 之类），系统没有对应处理器就会弹商店对话框。
   这些唤醒可能走主框架、隐藏 iframe 或 XHR，所以要三层一起拦。 */

/* 允许通过的前缀；其余协议一律视为唤醒尝试 */
const ALLOWED_SCHEME = /^(https?|data|blob|devtools|about|ws|wss|chrome):/i;

function guardSession(ses) {
  /* 第一层：网络请求层直接取消自定义协议请求（iframe/XHR 都在此被拦） */
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (ALLOWED_SCHEME.test(details.url)) {
      callback({});
    } else {
      callback({ cancel: true });
    }
  });
}

function guardWebContents(wc) {
  /* 第二层：所有框架（含子框架）的导航都只放行 http(s) */
  wc.on("will-navigate", (event, url) => {
    if (!/^https?:\/\//i.test(url)) event.preventDefault();
  });
  wc.on("will-frame-navigate", (event, url) => {
    if (!/^https?:\/\//i.test(url)) event.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
}

app.on("web-contents-created", (_e, wc) => {
  guardWebContents(wc);
  /* 第四层（根治）：注入脚本销毁抖音页面的 App 唤醒机制。
     之前的协议拦截在网络层是够的，但页面 JS 通过定时器反复设置
     location.href = 'bitbrowser://...'，每次都在系统层面弹出商店对话框。
     在 dom-ready 时注入脚本，从 DOM/JS 层面彻底禁用。 */
  wc.on("dom-ready", () => {
    wc.executeJavaScript(`(() => {
      if (window.__dydownProtocolGuard) return;
      window.__dydownProtocolGuard = true;
      /* 阻止 location 赋值为自定义协议 */
      const origLoc = window.location;
      const origAssign = origLoc.assign.bind(origLoc);
      const origReplace = origLoc.replace.bind(origLoc);
      const isCustom = (u) => { try { return !/^(https?:|about:|data:|blob:)/i.test(u); } catch { return false; } };
      origLoc.assign = (u) => { if (isCustom(u)) return; origAssign(u); };
      origLoc.replace = (u) => { if (isCustom(u)) return; origReplace(u); };
      /* 清除已有协议链接 + MutationObserver 持续清除新加的 */
      const clean = () => {
        document.querySelectorAll('a[href]').forEach((a) => {
          try { if (isCustom(a.href)) { a.removeAttribute('href'); a.style.pointerEvents = 'none'; } } catch {}
        });
      };
      clean();
      new MutationObserver(clean).observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
      /* 覆盖 window.open 防止自定义协议弹窗 */
      const origOpen = window.open.bind(window);
      window.open = (u, ...rest) => { if (isCustom(u)) return null; return origOpen(u, ...rest); };
    })();`).catch(() => {});
  });
});

/* 第三层：给常见唤醒协议注册空处理器，即使有漏网请求也不会落到系统层 */
function registerDummyProtocols() {
  for (const scheme of ["bitbrowser", "douyin", "snssdk", "snssdk1233", "aweme", "toutiao", "bytedance", "ixigua"]) {
    try {
      protocol.handle(scheme, () => new Response("", { status: 204 }));
    } catch {
      /* 已注册过则忽略 */
    }
  }
}

/* ---------------- 窗口 ---------------- */

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 940,
    minHeight: 600,
    frame: false,
    backgroundColor: "#0a0a0c",
    show: false,
    title: "DYdown",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.once("ready-to-show", () => {
    /* 兜底：渲染进程首帧信号异常时 3 秒后强制显示，窗口不至于永远空白 */
    setTimeout(() => {
      if (win && !win.isVisible()) win.show();
    }, 3000);
  });
  win.loadURL(`http://127.0.0.1:${serverPort}/`);
  win.on("closed", () => {
    win = null;
  });
}

/* ---------------- IPC ---------------- */

ipcMain.on("first-paint", () => {
  if (win && !win.isVisible()) win.show();
});
ipcMain.on("win:minimize", () => win?.minimize());
ipcMain.on("win:maximize-toggle", () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on("win:close", () => win?.close());

ipcMain.handle("clipboard:read", () => clipboard.readText());

ipcMain.handle("dialog:choose-dir", async () => {
  const result = await dialog.showOpenDialog(win, {
    title: "选择保存目录",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: win ? undefined : undefined,
  });
  if (result.canceled || !result.filePaths.length) return "";
  return result.filePaths[0];
});

ipcMain.handle("shell:open-path", async (_e, target) => {
  if (target && fs.existsSync(target)) {
    const err = await shell.openPath(target);
    return err || "";
  }
  return "";
});

ipcMain.handle("shell:reveal-path", (_e, target) => {
  if (target && fs.existsSync(target)) {
    shell.showItemInFolder(target);
  }
  return "";
});

/* ---------------- 登录与主页解析（桌面壳专属能力） ---------------- */

let loginWin = null;

/* 网页登录：打开抖音登录子窗口，轮询 Cookie，出现 sessionid 即收割保存 */
function openLoginWindow() {
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.show();
    loginWin.focus();
    return;
  }
  loginWin = new BrowserWindow({
    width: 430,
    height: 720,
    title: "抖音登录",
    autoHideMenuBar: true,
    backgroundColor: "#101014",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: "persist:dylogin",
    },
  });
  loginWin.webContents.setUserAgent(UA_DESKTOP);
  /* 加载首页：未登录时首页会自动弹出二维码登录层，比直连 /login 稳定 */
  loginWin.loadURL("https://www.douyin.com/");

  const ses = session.fromPartition("persist:dylogin");
  const poll = setInterval(async () => {
    try {
      if (!loginWin || loginWin.isDestroyed()) {
        clearInterval(poll);
        return;
      }
      const cookies = await ses.cookies.get({ url: "https://www.douyin.com/" });
      const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      if (/(^|;\s*)sessionid=/.test(cookieStr)) {
        const loginData = { cookie: cookieStr, nickname: "抖音用户", saved_at: Date.now() };
        try {
          const t = await loginWin.webContents.executeJavaScript(PROFILE_NICKNAME_JS);
          if (t && String(t).trim()) loginData.nickname = String(t).trim().slice(0, 30);
        } catch {}
        try {
          loginData.avatar = await loginWin.webContents.executeJavaScript(PROFILE_AVATAR_JS);
        } catch {}
        fs.writeFileSync(COOKIES_PATH, JSON.stringify(loginData, null, 2));
        clearInterval(poll);
        send("login-success", {
          logged_in: true,
          uname: loginData.nickname,
          face: loginData.avatar || "",
        });
        if (!loginWin.isDestroyed()) loginWin.close();
      }
    } catch {
      /* 轮询异常静默重试 */
    }
  }, 1500);
  loginWin.on("closed", () => {
    clearInterval(poll);
    loginWin = null;
  });
}

function closeLoginWindow() {
  if (loginWin && !loginWin.isDestroyed()) loginWin.close();
}

/* 已登录时后台刷新昵称+头像（头像 CDN 链接会过期，每次启动静默补抓一次）。
   隐藏窗口打开抖音首页读 DOM；读不到（未登录/页面结构变化）就保持原值。 */
async function refreshLoginProfile() {
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(COOKIES_PATH, "utf8"));
  } catch {
    return;
  }
  if (!data || !data.cookie) return;
  const win = new BrowserWindow({
    show: false,
    x: -2400,
    y: 0,
    skipTaskbar: true,
    focusable: false,
    width: 1200,
    height: 800,
    webPreferences: {
      partition: "persist:dylogin",
      contextIsolation: true,
      nodeIntegration: false,
      paintWhenInitiallyHidden: true,
      backgroundThrottling: false,
    },
  });
  const wc = win.webContents;
  wc.setUserAgent(UA_DESKTOP);
  const jsRun = (code, ms = 4000) =>
    Promise.race([
      wc.executeJavaScript(code).catch(() => null),
      new Promise((r) => setTimeout(() => r(null), ms)),
    ]);
  try {
    wc.loadURL("https://www.douyin.com/").catch(() => {});
    /* 头像先渲染、昵称文本流稍后出现：两项都拿到才提前结束（最多约 13 秒） */
    let face = "";
    let nick = "";
    for (let i = 0; i < 8 && !(face && nick); i++) {
      await new Promise((r) => setTimeout(r, 1600));
      if (win.isDestroyed()) break;
      if (!face) {
        const avatar = await jsRun(PROFILE_AVATAR_JS, 4000);
        if (avatar && String(avatar).startsWith("http")) face = String(avatar);
      }
      if (!nick) {
        const nickRaw = await jsRun(PROFILE_NICKNAME_JS, 3000);
        const t = String(nickRaw || "").trim().slice(0, 30);
        if (t) nick = t;
      }
    }
    if (face || nick) {
      const next = { ...data };
      if (face) next.avatar = face;
      if (nick) next.nickname = nick;
      next.profile_at = Date.now();
      /* 头像下载到本地缓存（CDN 链接带签名会过期，本地文件永不过期） */
      if (face) {
        try {
          const res = await fetch(face, { headers: { "User-Agent": UA_DESKTOP } });
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length > 100 && buf.length < 5 * 1024 * 1024) {
              fs.writeFileSync(AVATAR_PATH, buf);
              next.avatar_local = true;
            }
          }
        } catch {}
      }
      try {
        fs.writeFileSync(COOKIES_PATH, JSON.stringify(next, null, 2));
      } catch {}
      data = next;
      send("login-profile", { uname: next.nickname || "", face: next.avatar || "" });
    }
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

function logoutCleanup() {
  session
    .fromPartition("persist:dylogin")
    .clearStorageData()
    .catch(() => {});
}



async function collectIdsViaDesktop(
  secUid,
  {
    show = false,
    timeoutMs = 20000,
    mode = "post",
    mixId = "",
    videoId = "",
  } = {}
) {
  /* mode: "post" 主页作品列表（默认）| "mix-list" 用户的合集列表
     | "mix-items" 合集内视频（mixId 走合集详情页；videoId 走"从合集点开的视频"页，
       抖音会自己请求该视频所属合集的 mix/aweme，hook 一并捕获） */
  const isMixList = mode === "mix-list";
  const isMixItems = mode === "mix-items";
  const targetUrl = isMixList
    ? `https://www.douyin.com/user/${secUid}?from_tab_name=main&showSubTab=compilation`
    : isMixItems
      ? mixId
        ? `https://www.douyin.com/collection/${mixId}/1`
        : `https://www.douyin.com/user/${secUid}?from_tab_name=main&modal_id=${videoId}&showSubTab=compilation`
      : `https://www.douyin.com/user/${secUid}`;
  const barText = isMixList
    ? "⏳ 正在自动加载全部合集（也可滚动辅助）；完成后点这里「完成加载」"
    : isMixItems
      ? "⏳ 正在自动加载全部集数（也可滚动辅助）；完成后点这里「完成加载」"
      : "⏳ 正在自动加载全部作品（也可滚动辅助）；完成后点这里「完成加载」";
  const win = new BrowserWindow({
    show: !!show,
    x: show ? 100 : -2400,
    y: show ? 100 : 0,
    skipTaskbar: !show,
    focusable: !!show,
    width: isMixItems ? 1280 : 1000,
    height: 760,
    title: show ? "DYdown · 自动加载中，完成后点「完成加载」" : undefined,
    webPreferences: {
      javascript: true,
      /* preload 里是页面内 API 拦截器（hook-api.js）：必须与页面共享上下文
         才能覆盖页面的 XMLHttpRequest/fetch。它不暴露任何 Node 能力
         （nodeIntegration 关闭），仅往 window 挂几个纯数据字段。 */
      contextIsolation: false,
      nodeIntegration: false,
      partition: "persist:dylogin",
      preload: path.join(__dirname, "hook-api.js"),
      /* 隐藏模式（探测用）也照常渲染，按钮才会出现 */
      paintWhenInitiallyHidden: true,
      backgroundThrottling: false,
    },
  });
  const wc = win.webContents;
  wc.setUserAgent(UA_DESKTOP);
  const idSet = new Set();
  let nickname = "";

  /* 页面内 JS：带超时的执行器 */
  const jsRun = (code, ms = 3000) =>
    Promise.race([
      wc.executeJavaScript(code).catch(() => null),
      new Promise((r) => setTimeout(() => r(null), ms)),
    ]);

  /* 从「用户作品容器」提取视频 ID（持久收集器脚本见 extract-ids.js） */
  const extract = () => jsRun(EXTRACT_IDS_JS.split("__TARGET__").join(secUid), 3000);

  /* 可见模式的滚动提示条：自动加载 + 用户可滚动辅助，完成后点条上的按钮回传 */
  if (show) {
    wc.on("dom-ready", () => {
      wc.executeJavaScript(
        '(function(){' +
        'if (document.getElementById("__dydown_bar")) return;' +
        'var bar = document.createElement("div");' +
        'bar.id = "__dydown_bar";' +
        'bar.style.cssText = "position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:#FE2C55;color:#fff;padding:16px 20px;text-align:center;font-size:16px;font-family:system-ui;cursor:pointer;user-select:none;box-shadow:0 -4px 20px rgba(0,0,0,.4);";' +
        'bar.textContent = ' + JSON.stringify(barText) + ';' +
        'bar.onclick = function(){ bar.textContent = "✓ 正在回传…"; bar.style.pointerEvents = "none"; window.__dydownDone = true; };' +
        'document.body.appendChild(bar);' +
        'var counter = document.createElement("div");' +
        'counter.id = "__dydown_counter";' +
        'counter.style.cssText = "position:fixed;bottom:64px;right:16px;z-index:2147483647;background:rgba(0,0,0,.78);color:#fff;padding:8px 14px;border-radius:999px;font-size:14px;font-family:system-ui;";' +
        'counter.textContent = "正在读取…";' +
        'document.body.appendChild(counter);' +
        '})();'
      ).catch(() => {});
    });
  }

  /* 页面内 API 拦截器由 preload（hook-api.js）在 document-start 注入，
     捕获抖音自己的接口响应 —— 我们全程不发自己的请求，无风控风险 */

  /* 注入目标作者：拦截器用它过滤主页上其他来源的 aweme/post 响应，
     让"已加载 N 条"的计数与回传数据完全一致（回传侧服务端还有一道过滤） */
  wc.on("dom-ready", () => {
    wc.executeJavaScript(
      "window.__dydownTargetSec = " + JSON.stringify(String(secUid || "")) + ";1"
    ).catch(() => {});
  });

  wc.loadURL(targetUrl).catch(() => {});
  wc.once("did-finish-load", () => {
    jsRun("document.title", 4000).then((t) => {
      /* "帝帝牛的抖音 - 抖音" → "帝帝牛"（拦截数据的作者字段更准，见下） */
      const nick = String(t || "")
        .replace(/的抖音\s*[-–—].*$/, "")
        .replace(/\s*[-–—]\s*抖音.*$/, "")
        .trim();
      if (nick && nick.length < 40) nickname = nick;
    }).catch(() => {});
  });

  /* 主循环：自动加载（滚到底 + 点「点击加载更多」）。
     可见模式由用户点「完成加载」结束；隐藏模式（探测）数据稳定即结束。 */
  await new Promise((r) => setTimeout(r, 3000)); /* 给页面初始化留时间 */
  /* 自动加载脚本：点「点击加载更多」按钮；没有按钮就先把滚动容器滚到底
     把它渲染出来（只认文本精确的按钮，不会误点关注/订阅等其他按钮） */
  const clickMoreJs =
    "(function(){var all=document.querySelectorAll('button');for(var i=0;i<all.length;i++){var t=(all[i].textContent||'').trim();if(t.length<16&&(t.indexOf('加载更多')>=0||t.indexOf('点击加载')>=0||t.indexOf('查看更多')>=0)){all[i].click();return 1;}}return 0;})()";
  const scrollBottomJs =
    "(function(){var all=document.querySelectorAll('*');for(var i=0;i<all.length;i++){var e=all[i];try{var s=getComputedStyle(e);if((s.overflowY==='auto'||s.overflowY==='scroll')&&e.scrollHeight>e.clientHeight+50){e.scrollTop=e.scrollHeight-e.clientHeight;}}catch(x){}}try{window.scrollTo(0,document.body.scrollHeight);}catch(x){}return 1;})()";
  const deadline = Date.now() + (show ? 30 * 60 * 1000 : timeoutMs);
  let stale = 0; /* 计数停止增长的轮数 */
  let lastCount = 0;
  let still = 0; /* 提示用：停止增长的轮数（≥3 轮提示可点完成） */
  let emptyRounds = 0; /* 完全没数据的轮数（页面加载失败时提前退出） */
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 900));
    if (win.isDestroyed()) break;

    try {
      const hit = await jsRun(clickMoreJs, 2500);
      if (!hit) {
        await jsRun(scrollBottomJs, 2500);
        await jsRun(clickMoreJs, 2500);
      }
    } catch {}

    let hookCount = 0;
    if (isMixList) {
      /* 合集数 = mix/list + series/list 两套体系的接口捕获数。
         接口按 sec_user_id 返回目标用户的合集，计数与回传数据完全一致；
         不用页面卡片计数（推荐位等其他入口的 collection 链接会让数字虚高） */
      const mixN = Number(await jsRun("window.__dydownMixCount || 0", 1500)) || 0;
      const seriesN = Number(await jsRun("window.__dydownSeriesCount || 0", 1500)) || 0;
      hookCount = mixN + seriesN;
    } else if (isMixItems) {
      /* 集数 = 拦截器捕获的 aweme_list 条数（与回传一致）；
         不用页面 video 链接计数（推荐视频会混进来虚高） */
      hookCount = Number(await jsRun("window.__dydownMixItemCount || 0", 1500)) || 0;
    } else {
      const raw = await extract();
      if (raw) {
        try {
          for (const id of JSON.parse(raw)) idSet.add(id);
        } catch {}
      }
      hookCount = Number(await jsRun("window.__dydownApiCount || 0", 1500)) || 0;
    }

    if (hookCount > lastCount) {
      lastCount = hookCount;
      stale = 0;
      still = 0;
      emptyRounds = 0;
    } else if (hookCount > 0 || idSet.size > 0) {
      stale += 1;
      still += 1;
      emptyRounds = 0;
    } else {
      emptyRounds += 1;
    }

    if (show) {
      /* 可见模式：底部条实时显示进度，用户点「完成加载」结束 */
      const done = still >= 3;
      const tip = isMixList
        ? hookCount > 0
          ? done
            ? `已加载 ${hookCount} 个合集，点这里「完成加载」回传`
            : `正在自动加载… 已加载 ${hookCount} 个合集`
          : "正在读取合集列表…"
        : isMixItems
          ? hookCount > 0
            ? done
              ? `已加载 ${hookCount} 集，点这里「完成加载」回传`
              : `正在自动加载… 已加载 ${hookCount} 集`
            : "正在读取集数列表…"
          : hookCount > 0
            ? done
              ? `已加载 ${hookCount} 条作品，点这里「完成加载」回传`
              : `正在自动加载… 已加载 ${hookCount} 条作品`
            : `已收集 ${idSet.size} 个作品，正在读取数据…`;
      jsRun(
        '(function(){var e=document.getElementById("__dydown_counter");if(e)e.textContent=' +
          JSON.stringify(tip) +
          ';return 1;})()',
        1500
      );
      const userDone = await jsRun("!!window.__dydownDone", 2000);
      if (userDone) {
        /* 点完成后可能有最后一批请求在途，等 1.5 秒让拦截器收全 */
        await new Promise((r) => setTimeout(r, 1500));
        break;
      }
    } else {
      /* 隐藏模式（探测用）：数据稳定 6 轮即完成；长时间无数据提前退出去报原因 */
      if (lastCount > 0 && stale >= 6) break;
      if (emptyRounds >= 14) break;
    }
  }

  /* 收集完成后：读页面内拦截器捕获的数据。
     这些是抖音自己请求的响应（带完整签名与浏览器指纹），零风控风险。 */
  let items = [];
  let mixes = [];
  const ids = [...idSet];
  if (isMixList) {
    /* 抖音的"合集"有两套体系，都要收：
       ① mix/list 的 mix_infos（传统合集）
       ② series/list 的 series_infos（系列/短剧，知识类账号多为这种）
       它们混在一起展示为同一份合集列表 */
    try {
      const raw = await jsRun("JSON.stringify(window.__dydownMixList || [])", 12000);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          mixes = arr.filter((m) => m && (m.mix_id || m.series_id));
        }
      }
    } catch {}
    try {
      const raw2 = await jsRun("JSON.stringify(window.__dydownSeriesList || [])", 12000);
      if (raw2) {
        const arr2 = JSON.parse(raw2);
        if (Array.isArray(arr2)) {
          const have = new Set(mixes.map((m) => String(m.mix_id || m.series_id || "")));
          for (const s of arr2) {
            const sid = String((s && (s.series_id || s.mix_id)) || "");
            if (!sid || have.has(sid)) continue;
            have.add(sid);
            mixes.push(s);
          }
        }
      }
    } catch {}
    /* 按作者过滤（拦截器可能混入推荐位/其他用户的合集） */
    if (secUid) {
      mixes = mixes.filter(
        (m) => !(m.author && m.author.sec_uid) || m.author.sec_uid === secUid
      );
    }
    /* DOM 卡片合并补充：页面卡片是权威的 id + 名称与展示顺序，
       hook 数据带集数/播放量；两边合并（不是只做兜底，否则会漏掉另一套体系） */
    let domCards = [];
    try {
      const rawDom = await jsRun(MIX_CARDS_JS, 8000);
      if (rawDom) {
        const arr = JSON.parse(rawDom);
        if (Array.isArray(arr)) domCards = arr.filter((c) => c && c.mix_id);
      }
    } catch {}
    if (domCards.length) {
      const domById = new Map(domCards.map((c) => [String(c.mix_id), c]));
      const have = new Set(mixes.map((m) => String(m.mix_id || m.series_id || "")));
      for (const c of domCards) {
        if (!have.has(String(c.mix_id))) {
          have.add(String(c.mix_id));
          mixes.push({
            mix_id: String(c.mix_id),
            mix_name: c.name,
            dom_fallback: true,
            statis: { updated_to_episode: c.episodes || 0 },
          });
        }
      }
      /* DOM 卡片是页面权威值（集数/名称），给 hook 条目补上缺的字段 */
      for (const m of mixes) {
        const c = domById.get(String(m.mix_id || m.series_id || ""));
        if (!c) continue;
        m.dom_info = { name: c.name, episodes: c.episodes || 0 };
      }
      /* 页面顺序对齐（DOM 卡片顺序 = 页面展示顺序） */
      const rank = new Map(domCards.map((c, i) => [String(c.mix_id), i]));
      mixes.sort((a, b) => {
        const ka = String(a.mix_id || a.series_id || "");
        const kb = String(b.mix_id || b.series_id || "");
        return (rank.has(ka) ? rank.get(ka) : 999) - (rank.has(kb) ? rank.get(kb) : 999);
      });
    }
    console.log(`[mix-list] 合集 ${mixes.length} 个（mix+series+DOM 合并）`);
  } else if (isMixItems) {
    try {
      const raw = await jsRun("JSON.stringify(window.__dydownMixItems || [])", 12000);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) items = arr;
      }
    } catch {}
    console.log(`[mix-items] 合集 ${mixId} 捕获 ${items.length} 集`);
  } else {
    try {
      const raw = await jsRun("JSON.stringify(window.__dydownApiItems || [])", 12000);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) items = arr;
      }
    } catch {}
    console.log(`[load-all] DOM 收集 ${ids.length} 个 ID，拦截器捕获 ${items.length} 条完整数据`);
  }

  /* 昵称优先取拦截数据的作者字段（比页面标题准确） */
  if (items.length) {
    const a0 = items[0] && items[0].author;
    if (a0 && a0.nickname) nickname = String(a0.nickname);
  } else if (mixes.length) {
    const m0 = mixes[0];
    if (m0.author && m0.author.nickname) nickname = String(m0.author.nickname);
  }

  /* 收集为空时读页面文本，给出准确原因 */
  let reason = "";
  const empty = isMixList ? !mixes.length : !idSet.size && !items.length;
  if (empty && !win.isDestroyed()) {
    try {
      const txt = await jsRun("(document.body ? document.body.innerText : '').slice(0, 600)", 2500);
      const t = String(txt || "");
      /* 错误页元素检测（该账号被限制/不存在时抖音渲染 error-page） */
      const hasErrPage = await jsRun('!!document.querySelector("[data-e2e=error-page]")', 2000);
      if (hasErrPage) reason = "抖音对该账号返回了错误页（账号可能不存在、被限制或需要重新登录）";
      else if (t.includes("用户不存在")) reason = "该账号不存在或已注销";
      else if (t.includes("验证")) reason = "触发了抖音安全验证，请重试";
      else if (t.includes("私密")) reason = "该账号已设为私密，无法查看作品";
      else if (isMixList) reason = "没有读取到合集（该账号可能没有合集，或页面未加载成功）";
      else if (t.includes("登录")) reason = "需要登录后查看，请先在应用内完成抖音登录";
    } catch {}
  }
  if (!win.isDestroyed()) {
    try { win.destroy(); } catch {}
  }
  return { ids, items, mixes, nickname, reason };
}

/* 「加载全部」：可见窗口自动滚动 + 自动点「点击加载更多」，完成后点「完成加载」回传 */
async function profileLoadAllViaWindow(secUid) {
  return collectIdsViaDesktop(secUid, { show: true });
}

/* 合集列表：合集 tab 页面，可见窗口自动加载，完成后点「完成加载」回传 */
async function mixListViaWindow(secUid) {
  return collectIdsViaDesktop(secUid, { show: true, mode: "mix-list" });
}

/* 合集内视频：mixId 走合集详情页；secUid+videoId 走"从合集点开的视频"页
   （modal_id 页面，抖音自己会请求该视频所属合集的接口） */
async function mixItemsViaWindow(opts = {}) {
  const mixId = String(opts.mixId || "");
  const secUid = String(opts.secUid || "");
  const videoId = String(opts.videoId || "");
  return collectIdsViaDesktop(secUid, { show: true, mode: "mix-items", mixId, videoId });
}

ipcMain.handle("login:open", () => {
  openLoginWindow();
  return true;
});
ipcMain.on("login:close", () => closeLoginWindow());

/* ---------------- 自动更新 ---------------- */

let progressAttached = false;

function setupUpdater() {
  autoUpdater.autoDownload = false; // 设置页手动触发下载，带进度
  autoUpdater.autoInstallOnAppQuit = true;
  if (!progressAttached) {
    autoUpdater.on("download-progress", (p) => {
      send("update-progress", { received: p.transferred || 0, total: p.total || 0 });
    });
    progressAttached = true;
  }
}

function cmpVersion(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

ipcMain.handle("update:check", async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    const latest = result && result.updateInfo ? result.updateInfo.version : "";
    const current = app.getVersion();
    return {
      current,
      latest,
      up_to_date: !latest || cmpVersion(current, latest) >= 0,
      error: "",
    };
  } catch (e) {
    return { current: app.getVersion(), latest: "", up_to_date: false, error: String(e.message || e) };
  }
});

ipcMain.handle("update:download", async () => {
  const downloaded = new Promise((resolve, reject) => {
    const ok = () => {
      cleanup();
      resolve(true);
    };
    const fail = (_e, err) => {
      cleanup();
      reject(new Error(String((err && err.message) || err)));
    };
    const cleanup = () => {
      autoUpdater.removeListener("update-downloaded", ok);
      autoUpdater.removeListener("error", fail);
    };
    autoUpdater.once("update-downloaded", ok);
    autoUpdater.once("error", fail);
  });
  await autoUpdater.downloadUpdate();
  await downloaded;
  return true;
});

ipcMain.on("update:install", () => {
  try {
    autoUpdater.quitAndInstall();
  } catch {
    /* 忽略重复触发 */
  }
});

/* ---------------- 单实例 & 启动 ---------------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    registerDummyProtocols();
    /* 防护覆盖所有会话（含未来动态创建的），任何窗口都拦自定义协议 */
    guardSession(session.defaultSession);
    guardSession(session.fromPartition("persist:dylogin"));
    app.on("session-created", (ses) => guardSession(ses));

    const server = startServer({
      host: "127.0.0.1",
      port: 0,
      quiet: true,
      electronBridge: {
        loadAllViaWindow: profileLoadAllViaWindow,
        mixListViaWindow,
        mixItemsViaWindow,
        logoutCleanup,
      },
    });
    await new Promise((resolve) => server.on("listening", resolve));
    serverPort = server.address().port;

    setupUpdater();
    createWindow();
    /* 已登录时后台补抓昵称/头像（不阻塞启动；头像 CDN 链接会过期，每次启动刷新） */
    setTimeout(() => {
      refreshLoginProfile().catch(() => {});
    }, 5000);
  });

  app.on("window-all-closed", () => app.quit());
}
