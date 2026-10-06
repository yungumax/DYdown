/*
 * DYdown · 抖音视频无水印下载（本地解析与下载服务）
 *
 * 由 Electron 主进程内嵌启动（仅 127.0.0.1），也可独立运行：node server.cjs
 * - 静态托管 dist-web/（Vite 构建产物）
 * - 抖音解析：短链跳转 → ttwid Cookie → 分享页 _ROUTER_DATA
 * - 下载任务队列：并发控制 / 分文件进度 / 取消 / 重名处理，经 SSE 推送
 * - 设置持久化：DATA_DIR/settings.json（桌面壳指向 %APPDATA%/dydown）
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { Readable } = require("stream");
const { exec } = require("child_process");

const VERSION = "1.0.1";
const PUBLIC_DIR = path.join(__dirname, "dist-web");
const DATA_DIR = process.env.DYDOWN_DATA_DIR || path.join(process.cwd(), "data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const MANIFEST_FILE = path.join(DATA_DIR, "download-manifest.json");
const TMP_DIR = path.join(DATA_DIR, "tmp");
/* 登录头像本地缓存（主进程抓到后写入，前端走 /api/avatar 显示，避免 CDN 链接过期） */
const AVATAR_FILE = path.join(DATA_DIR, "avatar.jpg");
const REPO = "yungumax/DYdown";

fs.mkdirSync(DATA_DIR, { recursive: true });

/* 下载清单：bid → 落盘位置与文件名，「重命名已下载」按它找到旧文件 */
let manifest = {};
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8")) || {};
} catch {}
function saveManifest() {
  try {
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
  } catch {}
}

/* iPhone Safari UA：抖音分享页必须带移动端 UA 才返回完整数据 */
const UA_MOBILE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

/* ---------------- 设置 ---------------- */

const DEFAULT_SETTINGS = {
  output_dir: path.join(os.homedir(), "Downloads", "DYdown"),
  max_concurrent_tasks: 2,
  chunk_concurrency: 4,
  chunk_mb: 4,
  keep_temp: false,
  naming_template: "{index} {title}.{ext}",
  naming_presets: [],
  folder_template: "{author}/{year}-{month}",
  folder_presets: [],
  rename_conflict: "skip",
  image_format: "large",
  video_quality: "source",
  audio_quality: "best",
  download_text: true,
  retry_count: 3,
  speed_limit_mib: 0,
  resume_on_start: false,
  parse_preset: "标准",
  parse_batch: 8,
  parse_batch_wait_ms: 1000,
  parse_rest_every: 100,
  parse_rest_ms: 3000,
  log_level: "info",
  data_dir: "",
  update_check: false,
  onboarded: false,
  proxy: "",
  theme: "dark",
};

let settings = { ...DEFAULT_SETTINGS };
try {
  const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  settings = { ...DEFAULT_SETTINGS, ...saved };
} catch {
  /* 首次启动无设置文件 */
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error("[settings] 保存失败:", e.message);
  }
}

/* ---------------- 通用工具 ---------------- */

function sendJson(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(obj));
}

function fetchWithTimeout(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

/* ---------------- 登录 Cookie（网页登录窗口收割，main.cjs 写入） ---------------- */

const COOKIES_FILE = path.join(DATA_DIR, "cookies.json");

function loadLogin() {
  try {
    const data = JSON.parse(fs.readFileSync(COOKIES_FILE, "utf8"));
    if (data.cookie) return data;
  } catch {}
  return null;
}

function loginCookieHeader() {
  const login = loadLogin();
  return login ? login.cookie : "";
}

/* 可选的桌面壳能力（个人主页 CDP 解析 / 退出登录清理），由 main.cjs 注入 */
let electronBridge = null;

function localDate(unixSecs) {
  const d = unixSecs ? new Date(unixSecs * 1000) : new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function padNum(n, width) {
  return String(n).padStart(Math.max(width || 0, 1), "0");
}

/* 命名渲染器：与界面预览共用同一套语义。
   vars: {title, author, bid, ..., index, index_pad, source_kind}；ext 为空时不追加扩展名。 */
function renderTemplate(template, vars, ext, { dir = false } = {}) {
  const merged = { ...vars };
  const segments = [];
  let usedExt = false;
  for (const raw of String(template ?? "").split(/[/\\]/)) {
    let out = "";
    let rest = raw;
    while (true) {
      const start = rest.indexOf("{");
      if (start === -1) {
        out += rest;
        break;
      }
      out += rest.slice(0, start);
      const end = rest.indexOf("}", start);
      if (end === -1) {
        out += rest.slice(start);
        break;
      }
      const token = rest.slice(start + 1, end);
      if (token === "ext") {
        usedExt = true;
        out += ext || "";
      } else if (token === "index" && merged.index !== undefined) {
        out += padNum(merged.index, merged.index_pad || 1);
      } else if (token in merged) {
        out += merged[token] === "" || merged[token] === undefined ? "" : String(merged[token]);
      } else {
        out += `{${token}}`;
      }
      rest = rest.slice(end + 1);
    }
    const cleaned = out
      /* 换行/回车/制表先压成单空格：裸换行能落盘但会让资源管理器
         的"打开/定位"全部失效（实测踩过） */
      .replace(/[\r\n\t]+/g, " ")
      .replace(dir ? /[":*?<>|]/g : /[\\/:*?"<>|]/g, "_")
      .trim()
      .replace(/\.+$/, "")
      .trim();
    if (cleaned && cleaned !== "." && cleaned !== "..") segments.push(cleaned);
  }
  if (!dir && ext && !usedExt) {
    if (segments.length) segments[segments.length - 1] += `.${ext}`;
    else segments.push(`douyin.${ext}`);
  }
  return segments.join(path.sep);
}

/* ---------------- ttwid Cookie（分享页 SSR 必需） ---------------- */

let ttwidCache = { value: "", ts: 0 };
async function getTtwid() {
  if (ttwidCache.value && Date.now() - ttwidCache.ts < 12 * 3600 * 1000) return ttwidCache.value;
  const res = await fetchWithTimeout(
    "https://ttwid.bytedance.com/ttwid/union/register/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA_MOBILE },
      body: JSON.stringify({
        region: "cn",
        aid: 1768,
        needFid: false,
        service: "www.ixigua.com",
        migrate_info: { ticket: "", source: "node" },
        cbUrlProtocol: "https",
        union: true,
      }),
    },
    12000
  );
  const setCookie = res.headers.get("set-cookie") || "";
  const m = setCookie.match(/ttwid=([^;]+)/);
  if (m) {
    ttwidCache = { value: "ttwid=" + m[1], ts: Date.now() };
    return ttwidCache.value;
  }
  return "";
}

/* ---------------- 抖音解析 ---------------- */

function extractUrl(text) {
  if (!text) return "";
  const s = String(text);
  const m = s.match(/https?:\/\/[^\s"'<>，,、】」）)】]+/);
  return m ? m[0] : "";
}

async function followRedirect(url) {
  const res = await fetchWithTimeout(url, {
    redirect: "follow",
    headers: { "User-Agent": UA_MOBILE, Accept: "text/html,application/xhtml+xml" },
  }, 15000);
  return res.url || url;
}

async function fetchShareItem(id, kind) {
  /* 登录态优先：cookies.json 里是收割的完整 cookie（含用户自己的 ttwid），
     与登录会话一致；拼匿名 ttwid 会造成会话不一致、老作品解析失败（实测踩过）。
     未登录时才用匿名 ttwid。 */
  let cookieHeader = loginCookieHeader();
  if (!cookieHeader) {
    try {
      cookieHeader = await getTtwid();
    } catch {
      /* 拿不到也继续试一次 */
    }
  }
  const res = await fetchWithTimeout(
    `https://www.iesdouyin.com/share/${kind}/${id}/`,
    {
      redirect: "follow",
      headers: {
        "User-Agent": UA_MOBILE,
        "Accept-Language": "zh-CN,zh;q=0.9",
        Accept: "text/html,application/xhtml+xml",
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
    },
    20000
  );
  const html = await res.text();
  const m = html.match(/window\._ROUTER_DATA\s*=\s*([\s\S]*?)<\/script>/);
  if (!m) throw new Error("解析失败：分享页没有返回数据，作品可能已删除或设为私密");
  let raw = m[1].trim();
  if (raw.endsWith(";")) raw = raw.slice(0, -1);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("解析失败：分享页数据格式异常，抖音接口可能已更新");
  }
  const loaders = (data && data.loaderData) || {};
  for (const key of Object.keys(loaders)) {
    const info = loaders[key] && loaders[key].videoInfoRes;
    const list = info && info.item_list;
    if (Array.isArray(list) && list.length) return list[0];
  }
  throw new Error("解析失败：作品可能已删除、设为私密，或抖音接口已更新");
}

function pickFirst(addr) {
  return (addr && Array.isArray(addr.url_list) && addr.url_list.filter(Boolean)) || [];
}

const DOUYIN_QUALITIES = [
  { value: "source", label: "原画（体积探测选最高）", available: true, hint: "" },
  { value: "4k", label: "4K 优先", available: true, hint: "" },
  { value: "2k", label: "2K 优先", available: true, hint: "" },
  { value: "1080p", label: "1080P 优先", available: true, hint: "" },
  { value: "720p", label: "720P（最省流量）", available: true, hint: "" },
];

/* 清晰度选项 → 允许的 ratio 候选链（链内仍按体积探测选最大）。
   "auto" 是旧版遗留值，按原画处理。 */
const QUALITY_RATIOS = {
  source: ["default", "4k", "2k", "1080p", "720p"],
  "4k": ["4k", "2k", "1080p", "720p"],
  "2k": ["2k", "1080p", "720p"],
  "1080p": ["1080p", "720p"],
  "720p": ["720p"],
  auto: ["default", "4k", "2k", "1080p", "720p"],
};

function ratiosForQuality(quality) {
  return QUALITY_RATIOS[quality] || QUALITY_RATIOS.source;
}

/* 视频直链多路提取：play_addr → download_addr → bit_rate 最高档 → long_video。
   不同形态的作品（长视频/番外/合作视频）地址可能藏在不同的字段里。 */
function videoAddrLists(video) {
  const lists = [];
  const push = (addr) => {
    const l = pickFirst(addr);
    for (const u of l) lists.push(u.replace("/playwm/", "/play/"));
  };
  push(video && video.play_addr);
  if (video && video.play_addr && video.play_addr.uri && !lists.length) {
    lists.push(
      `https://www.iesdouyin.com/aweme/v1/playwm/?video_id=${video.play_addr.uri}&ratio=1080p&line=0`
    );
  }
  push(video && video.download_addr);
  if (Array.isArray(video && video.bit_rate)) {
    const sorted = [...video.bit_rate].sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0));
    for (const b of sorted) push(b.play_addr);
  }
  if (Array.isArray(video && video.long_video)) {
    for (const lv of video.long_video) push(lv.play_addr);
  }
  return [...new Set(lists)];
}

/* 抖音原始 aweme 数据 → 前端条目结构（单条与主页批量共用） */
function itemFromAweme(item) {
  const video = item.video || {};
  const author = item.author || {};
  const images = Array.isArray(item.images)
    ? item.images.map((p) => pickFirst(p)[0]).filter(Boolean)
    : [];
  const isImages = images.length > 0;
  const title = String(item.desc || "").trim() || "无标题作品";
  const noWmList = videoAddrLists(video);

  return {
    bid: String(item.aweme_id || ""),
    mid: 0,
    title,
    author: author.nickname || "抖音用户",
    created_at: Number(item.create_time) || 0,
    pics: isImages ? images.length : 0,
    has_video: !isImages,
    duration: video.duration ? Math.round(video.duration / 1000) : 0,
    is_audio: false,
    is_retweet: false,
    video_uri: (video.play_addr && video.play_addr.uri) || "",
    media_urls: isImages ? [] : noWmList,
    music_urls: pickFirst(item.music && item.music.play_url),
    cover: pickFirst(video.origin_cover)[0] || pickFirst(video.cover)[0] || "",
    images,
  };
}

function buildPostProbe(item, fallbackId) {
  const entry = itemFromAweme(item);
  return {
    kind: "post",
    bid: String(item.aweme_id || fallbackId),
    mid: 0,
    uid: 0,
    title: entry.title,
    author: entry.author,
    cover: entry.cover,
    created_at: entry.created_at,
    note: "",
    total: 1,
    loaded: 1,
    exhausted: true,
    qualities: DOUYIN_QUALITIES,
    items: [entry],
  };
}

/* 个人主页：桌面壳隐藏窗口加载桌面页 → DOM 收集作品 ID → 逐条解析（并发 4）。
   不依赖接口签名（那条路被抖音封了），逐条走已验证的单条分享页链路。 */
const userKnown = new Map(); // secUid → Set(bid) 已下发给前端的作品（跨页去重）

/* 把一组视频 ID 逐条解析成条目（并发 4） */
async function resolveVideoIds(ids, known, onProgress) {
  const entries = [];
  let failed = 0;
  let doneCount = 0;
  const failedIds = [];
  let idx = 0;
  /* 分享页接口有频控：并发 2 + 每请求间隔 250ms（实测 71 个连续请求会大面积限流） */
  const worker = async (workerId) => {
    while (idx < ids.length) {
      const my = idx;
      idx += 1;
      const vid = ids[my];
      if (workerId > 0) await new Promise((r) => setTimeout(r, 250 * workerId));
      try {
        const probe = await probeFromInput(`https://www.douyin.com/video/${vid}`);
        const entry = probe.items[0];
        if (entry) {
          known.add(vid);
          entries.push(entry);
        } else {
          failedIds.push(vid);
        }
      } catch {
        failedIds.push(vid);
      }
      doneCount += 1;
      if (onProgress) onProgress(doneCount, ids.length);
      await new Promise((r) => setTimeout(r, 250));
    }
  };
  await Promise.all([worker(0), worker(1)]);
  /* 失败重试：串行 + 递增退避（绕开限流窗口） */
  if (failedIds.length) {
    console.log(`[resolve] 首轮失败 ${failedIds.length} 条，开始串行重试…`);
    for (const vid of failedIds) {
      try {
        await new Promise((r) => setTimeout(r, 800));
        const probe = await probeFromInput(`https://www.douyin.com/video/${vid}`);
        const entry = probe.items[0];
        if (entry) {
          known.add(vid);
          entries.push(entry);
        } else {
          failed += 1;
        }
      } catch {
        failed += 1;
      }
    }
  }
  return { entries, failed };
}

async function probeUserProfile(secUid) {
  if (!electronBridge || typeof electronBridge.loadAllViaWindow !== "function") {
    throw new Error("个人主页解析需要在桌面版中使用（网页预览不支持）");
  }
  /* 主页解析统一走「可见窗口」：抖音页面在自动窗口里渲染不稳定（作品数抖动），
     可见窗口由用户滚动驱动，100% 可靠且可控（实测结论）。
     数据来源优先用页面内拦截器捕获的完整作品数据（抖音自己的请求，无风控风险）。 */
  const data = await electronBridge.loadAllViaWindow(secUid);
  const pageItems = data.items || [];
  const ids = data.ids || [];
  if (!ids.length && !pageItems.length) {
    throw new Error(
      data.reason
        ? `解析失败：${data.reason}`
        : "没有收集到作品（请在窗口里滚动一下再点「完成加载」）"
    );
  }
  const known = userKnown.get(secUid) || new Set();
  userKnown.set(secUid, known);
  let entries = [];
  if (pageItems.length) {
    entries = pageItems
      .filter((a) => a && a.author && (!a.author.sec_uid || a.author.sec_uid === secUid))
      .map(itemFromAweme)
      .filter((e) => {
        if (!e.bid || known.has(e.bid)) return false;
        known.add(e.bid);
        return true;
      });
  }
  if (!entries.length) {
    /* 兜底：拦截器没数据时逐条解析 */
    const r = await resolveVideoIds(ids, known);
    entries = r.entries;
  }
  if (!entries.length) {
    throw new Error("解析失败：没有解析到任何作品（可能全部已下载或链接失效）");
  }
  const nickname = data.nickname || entries[0].author || "抖音用户";
  return {
    kind: "user",
    bid: secUid,
    mid: 0,
    uid: secUid,
    title: `${nickname} 的作品`,
    author: nickname,
    cover: entries[0].cover || "",
    created_at: entries[0].created_at || 0,
    note: `已加载 ${entries.length} 条作品；点「加载全部」可滚动加载更多。`,
    total: entries.length,
    loaded: entries.length,
    exhausted: false,
    qualities: DOUYIN_QUALITIES,
    items: entries,
  };
}

/* mix/list 或 series/list 条目 → 前端用的合集摘要
   （两套体系字段名不同：mix_id/mix_name/statis vs series_id/series_name/stats，
   这里做兼容映射；DOM 卡片的值（dom_info）是页面权威值，用于补缺） */
function mixFromApi(m) {
  const statis = m.statis || m.series_statis || m.stats || {};
  const dom = m.dom_info || {};
  const cover = pickFirst(m.cover_url)[0] || pickFirst(m.cover)[0] || "";
  const count =
    Number(statis.updated_to_episode || 0) ||
    Number(statis.has_updated_episode || 0) ||
    Number(statis.episode_count || 0) ||
    Number(statis.total_episodes || 0) ||
    Number(dom.episodes || 0) ||
    Number(m.total_episodes || 0) ||
    Number(m.episode_count || 0) ||
    (Array.isArray(m.ids) ? m.ids.length : 0);
  return {
    mix_id: String(m.mix_id || m.series_id || ""),
    name: String(m.mix_name || m.series_name || dom.name || "未命名合集").trim(),
    cover,
    count,
    play: Number(statis.play_vv || 0),
    desc: String(m.desc || m.series_desc || "").slice(0, 100),
    dom_fallback: !!m.dom_fallback,
  };
}

/* 合集列表：合集 tab 页面，用户在窗口里滚动加载全部合集 */
async function probeMixList(secUid) {
  if (!electronBridge || typeof electronBridge.mixListViaWindow !== "function") {
    throw new Error("合集解析需要在桌面版中使用（网页预览不支持）");
  }
  const data = await electronBridge.mixListViaWindow(secUid);
  const mixes = (data.mixes || []).map(mixFromApi).filter((m) => m.mix_id);
  if (!mixes.length) {
    throw new Error(
      data.reason || "没有读取到合集（该账号可能没有合集；请在窗口里滚动一下再点「完成加载」）"
    );
  }
  const nickname = data.nickname || "抖音用户";
  return {
    kind: "mix-list",
    bid: secUid,
    mid: 0,
    uid: secUid,
    title: `${nickname} 的合集`,
    author: nickname,
    cover: mixes[0].cover || "",
    created_at: 0,
    note: `共 ${mixes.length} 个合集；点「加载视频」拉取某个合集的全部视频。`,
    total: mixes.length,
    loaded: mixes.length,
    exhausted: true,
    qualities: DOUYIN_QUALITIES,
    items: [],
    mixes,
  };
}

/* 合集内视频：合集详情页，用户滚动右侧选集列表加载全部集数 */
/* mix/aweme、series/aweme 的响应 → 前端用的合集视频 probe（公共部分） */
function buildMixItemsProbe(data, mixName, bidPrefix) {
  const entries = (data.items || []).map(itemFromAweme).filter((e) => e.bid);
  if (!entries.length) {
    throw new Error(
      data.reason || "没有读取到合集视频（请在窗口里滚动右侧列表再点「完成加载」）"
    );
  }
  const nickname = data.nickname || (entries[0] && entries[0].author) || "抖音用户";
  const title = mixName || `${nickname} 的合集`;
  return {
    kind: "user",
    mix: true, /* 合集来源：前端据此隐藏「加载全部」等主页专用按钮 */
    bid: bidPrefix,
    mid: 0,
    uid: bidPrefix,
    title,
    author: nickname,
    cover: entries[0].cover || "",
    created_at: entries[0].created_at || 0,
    note: `合集共加载 ${entries.length} 集。`,
    total: entries.length,
    loaded: entries.length,
    exhausted: true,
    qualities: DOUYIN_QUALITIES,
    items: entries,
  };
}

async function probeMixItems(mixId, mixName) {
  if (!electronBridge || typeof electronBridge.mixItemsViaWindow !== "function") {
    throw new Error("合集解析需要在桌面版中使用（网页预览不支持）");
  }
  const data = await electronBridge.mixItemsViaWindow({ mixId });
  return buildMixItemsProbe(data, mixName, `mix_${mixId}`);
}

/* 从合集里点开的视频（modal_id + showSubTab=compilation）：按「该视频所属合集」解析。
   窗口加载这个视频页后，抖音自己会请求所属合集的 mix/aweme，hook 捕获。
   视频不属于任何合集时（页面没发合集请求）回退成单条视频解析。 */
async function probeVideoMix(secUid, videoId) {
  if (!electronBridge || typeof electronBridge.mixItemsViaWindow !== "function") {
    throw new Error("合集解析需要在桌面版中使用（网页预览不支持）");
  }
  const data = await electronBridge.mixItemsViaWindow({ secUid, videoId });
  const entries = (data.items || []).map(itemFromAweme).filter((e) => e.bid);
  if (!entries.length) {
    /* 视频不属于合集：回退单条解析，至少能下载这个视频 */
    const item =
      (await fetchShareItem(videoId, "video").catch(() => null)) ||
      (await fetchShareItem(videoId, "note"));
    return buildPostProbe(item, videoId);
  }
  return buildMixItemsProbe(data, "", `mixv_${videoId}`);
}

/* 输入（链接或整段口令）→ 探测结果。
   支持：v.douyin.com 短链、/video|note|slides/<id>、任意带 modal_id 参数的网页版链接
   （如 douyin.com/jingxuan?modal_id=xxx）、/user/<sec_uid> 个人主页。 */
async function probeFromInput(input) {
  const url = extractUrl(input);
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error("没有识别到链接：请粘贴抖音「分享 · 复制链接」的完整内容");
  }
  if (!/(?:^|\.)douyin\.com/i.test(new URL(url).hostname)) {
    throw new Error("目前仅支持抖音链接，其他平台敬请期待");
  }

  let real = url;
  if (/v\.douyin\.com/i.test(real)) {
    real = await followRedirect(real);
  }

  /* 合集上下文优先于单个视频：链接同时带 modal_id 与 showSubTab=compilation 时，
     那是「从合集里点开的视频」，按该视频所属合集解析；单纯合集 tab 解析合集列表 */
  const modal = real.match(/[?&]modal_id=(\d+)/);
  const userMatch = real.match(/\/user\/([A-Za-z0-9_-]+)/);
  if (/showSubTab=compilation/i.test(real) && userMatch) {
    if (modal) return probeVideoMix(userMatch[1], modal[1]);
    return probeMixList(userMatch[1]);
  }

  /* 网页版链接里的 modal_id（jingxuan/user/discover 等页面复制的地址） */
  if (modal) {
    const id = modal[1];
    const item =
      (await fetchShareItem(id, "video").catch(() => null)) ||
      (await fetchShareItem(id, "note"));
    return buildPostProbe(item, id);
  }

  /* 网页规范地址 /video|note|slides/<id> */
  const m = real.match(/\/(video|note|slides)\/(\d+)/);
  if (m) {
    const id = m[2];
    let item = null;
    if (m[1] === "video") {
      item = await fetchShareItem(id, "video").catch(() => fetchShareItem(id, "note"));
    } else {
      item = await fetchShareItem(id, "note").catch(() => fetchShareItem(id, "video"));
    }
    return buildPostProbe(item, id);
  }

  /* 合集详情页 /collection/<mix_id>（网页版合集播放页） */
  const cm = real.match(/\/collection\/(\d+)/);
  if (cm) {
    return probeMixItems(cm[1], "");
  }

  /* 个人主页 /user/<sec_uid>（合集 tab / 合集内视频已在前面分流） */
  if (userMatch) {
    return probeUserProfile(userMatch[1]);
  }

  throw new Error("未识别到作品或主页：请粘贴「分享 · 复制链接」的内容，或网页版视频/主页地址");
}

/* ---------------- 下载任务 ---------------- */

const tasks = new Map(); // id → { req, task, abort, lastSent }
const activeFileKeys = new Set(); // 正在写入的作品标识（同作品互斥）
const order = [];
let running = 0;
const sseClients = new Set();

function sendTask(task) {
  const payload = `data: ${JSON.stringify({ task })}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

/* 每个任务的推送节流，避免进度刷屏 */
function pushTask(ctx) {
  const now = Date.now();
  const finalState = ["done", "failed", "canceled", "paused"].includes(ctx.task.status);
  /* 状态发生变化的推送必须直达（暂停/继续的关键事件被 200ms 节流吞掉，
     前端就会拿着旧状态行动——"全部开始"漏恢复就是它害的，实测踩过） */
  const statusChanged = ctx.lastStatus !== ctx.task.status;
  if (!finalState && !statusChanged && now - (ctx.lastSent || 0) < 200) return;
  ctx.lastStatus = ctx.task.status;
  ctx.lastSent = now;
  sendTask(ctx.task);
}

function startDownload(req) {
  const id = crypto.randomUUID();
  const task = {
    id,
    title: req.title || "未命名作品",
    quality_label: req.quality_label || "",
    status: "queued",
    image_pct: 0,
    video_pct: 0,
    image_count: req.image_count || 0,
    video_count: req.video_count || 0,
    downloaded: 0,
    total: 0,
    speed_bps: 0,
    output_path: "",
    message: "排队中",
  };
  tasks.set(id, { req, task, abort: new AbortController(), lastSent: 0 });
  order.push(id);
  sendTask(task);
  pump();
  return id;
}

function cancelDownload(taskId) {
  const ctx = tasks.get(taskId);
  if (!ctx || ["done", "failed", "canceled"].includes(ctx.task.status)) return;
  /* 已暂停的任务没有活动连接，直接标记取消 */
  if (ctx.task.status === "paused") {
    ctx.task.status = "canceled";
    ctx.task.message = "已取消";
    sendTask(ctx.task);
    return;
  }
  ctx.canceled = true;
  ctx.abort.abort();
}

/* 暂停：排队中的直接落位；下载中的终止连接但保留分片（curl -C - 支持断点） */
function pauseDownload(taskId) {
  const ctx = tasks.get(taskId);
  if (!ctx) return;
  if (ctx.task.status === "queued") {
    ctx.paused = true;
    ctx.task.status = "paused";
    ctx.task.message = "已暂停";
    sendTask(ctx.task);
  } else if (["downloading", "saving"].includes(ctx.task.status)) {
    ctx.paused = true;
    ctx.task.message = "暂停中…";
    sendTask(ctx.task);
    try {
      if (ctx.curlChild && !ctx.curlChild.killed) ctx.curlChild.kill();
    } catch {}
    ctx.abort.abort();
  }
}

/* 继续：回队列重新排队；视频阶段会复用上次的目标文件并断点续传。
   AbortController 是一次性的——暂停时已触发，继续必须换新的，
   否则续传的第一次请求会立刻被打断、任务直接变已取消。
   状态判定宽容化：即使节流吞了 paused 事件（paused 标志还在），也能恢复。 */
function resumeDownload(taskId) {
  const ctx = tasks.get(taskId);
  if (!ctx) return;
  const st = ctx.task.status;
  const wasPaused = st === "paused" || (ctx.paused && !["done", "failed", "canceled"].includes(st));
  if (!wasPaused) return;
  ctx.paused = false;
  ctx.abort = new AbortController();
  ctx.task.status = "queued";
  ctx.task.message = "排队中";
  order.push(taskId);
  sendTask(ctx.task);
  pump();
}

function pump() {
  const max = Math.max(1, Number(settings.max_concurrent_tasks) || 2);
  while (running < max && order.length) {
    const id = order.shift();
    const ctx = tasks.get(id);
    if (!ctx) continue;
    /* 暂停过的排队任务：落位不再启动 */
    if (ctx.paused) {
      ctx.task.status = "paused";
      ctx.task.message = "已暂停";
      pushTask(ctx);
      continue;
    }
    running += 1;
    runTask(ctx)
      .catch(() => {})
      .finally(() => {
        running -= 1;
        pump();
      });
  }
}

function uniqueDest(dest, mode) {
  if (!fs.existsSync(dest) || mode === "overwrite") return { dest, skipped: false };
  if (mode === "skip") return { dest, skipped: true };
  const ext = path.extname(dest);
  const base = path.basename(dest, ext);
  const dir = path.dirname(dest);
  for (let i = 1; i < 1000; i += 1) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return { dest: candidate, skipped: false };
  }
  return { dest, skipped: true };
}

/* 优先用系统自带 curl.exe 下载：实测部分安全软件（火绒 HIPS）会定向拦截
   应用自身进程的大文件网络流与写入（连接被掐、文件消失），而 curl.exe
   完全不受影响；Win10 1803+ 原生自带。失败时回退 Node fetch。 */
const { spawn } = require("child_process");

function findCurl() {
  for (const p of ["C:\\Windows\\System32\\curl.exe", "C:\\Windows\\Sysnative\\curl.exe"]) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return "curl";
}

function downloadViaCurl(urlList, dest, ctx, onProgress, expectedTotal) {
  return new Promise((resolve, reject) => {
    const curl = findCurl();
    const cookie = loginCookieHeader();
    let idx = 0;
    let failStreak = 0; // 同一地址连续无进展次数

    const tryUrl = () => {
      if (ctx.canceled) return reject(Object.assign(new Error("已取消"), { name: "AbortError" }));
      if (ctx.paused) return reject(Object.assign(new Error("已暂停"), { name: "PausedError" }));
      if (idx >= urlList.length) return reject(new Error("所有下载地址均失败"));
      const url = urlList[idx];
      const args = [
        "-L",
        "--fail",
        "-s",
        "-S",
        "-C", "-", // 断点续传：从已有分片继续
        "-A", UA_MOBILE,
        "-e", "https://www.douyin.com/",
        "--connect-timeout", "20",
        "--speed-time", "40", "--speed-limit", "131072", // 40 秒均速低于 128KB/s 视为慢连接，主动掐掉重选节点（断点续传不丢进度）
        "-o", dest,
      ];
      if (cookie) args.push("-H", `Cookie: ${cookie}`);
      args.push(url);

      if (expectedTotal) ctx.task.total = Math.max(ctx.task.total, expectedTotal);
      /* 每 500ms 采样文件体积：差值即实时速度；有预期大小才算进度百分比 */
      let lastSize = 0;
      let lastPoll = Date.now();
      const poll = setInterval(() => {
        try {
          /* 暂停请求：立刻收掉 curl，走暂停分支 */
          if (ctx.paused && child && !child.killed) child.kill();
          const size = fs.statSync(dest).size;
          if (size > ctx.task.downloaded) ctx.task.downloaded = size;
          /* 收满声明大小：主动收掉 curl（某些流谎报大小后卡住不发结束） */
          if (expectedTotal && size >= expectedTotal) {
            try {
              if (child && !child.killed) child.kill();
            } catch {}
          }
          const now = Date.now();
          if (now - lastPoll >= 400) {
            ctx.task.speed_bps = Math.round(((size - lastSize) * 1000) / (now - lastPoll));
            lastSize = size;
            lastPoll = now;
            if (expectedTotal) onProgress(Math.min(100, (size / expectedTotal) * 100));
            pushTask(ctx);
          }
        } catch {}
      }, 300);

      const child = spawn(curl, args, { windowsHide: true });
      ctx.curlChild = child;
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (e) => {
        clearInterval(poll);
        reject(e); // curl 不存在等 → 调用方回退 fetch
      });
      let startSize = 0;
      try {
        startSize = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
      } catch {}
      child.on("exit", (code) => {
        clearInterval(poll);
        /* 暂停触发的退出：按暂停处理，绝不重启下载（否则暂停不生效） */
        if (ctx.paused) return reject(Object.assign(new Error("已暂停"), { name: "PausedError" }));
        if (ctx.canceled) return reject(Object.assign(new Error("已取消"), { name: "AbortError" }));
        let size = 0;
        try {
          size = fs.statSync(dest).size;
        } catch {}
        if (code === 0) {
          onProgress(100);
          return resolve();
        }
        /* 断点已到末尾（服务器 416）→ 文件其实已完成 */
        if (expectedTotal && size >= expectedTotal) {
          onProgress(100);
          return resolve();
        }
        /* 有新进展（文件在增长）→ 继续对同一 URL 断点续传，最多连续 3 次
           无进展才换下一个地址；无脑换 URL 会让续传永远从头开始 */
        if (size > startSize) {
          startSize = size;
          tryUrl();
          return;
        }
        failStreak += 1;
        if (failStreak < 3) {
          tryUrl();
          return;
        }
        failStreak = 0;
        idx += 1;
        tryUrl();
      });
    };
    tryUrl();
  });
}

async function downloadTo(urlList, dest, ctx, onProgress, expectedTotal) {
  /* 首选系统 curl；curl 本体不存在（spawn ENOENT）时回退 Node fetch 实现 */
  try {
    return await downloadViaCurl(urlList, dest, ctx, onProgress, expectedTotal);
  } catch (e) {
    if (e.name === "AbortError" || ctx.canceled) throw e;
    if (e.code !== "ENOENT") throw e; // curl 已运行但下载失败 → 直接抛出
  }
  const headers = {
    "User-Agent": UA_MOBILE,
    Referer: "https://www.douyin.com/",
    Accept: "*/*",
  };
  const retries = Math.max(0, Number(settings.retry_count) || 0);
  let lastError = new Error("没有可用的下载地址");
  let highWater = 0; // 已确认写入的最大字节数（进度只进不退）
  for (const url of urlList) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        /* 断点续传：已有分片就从断点继续（Range 追加），不删文件重来——
           大文件（原画长视频动辄数 GB）中途断流时，删除重建既慢又容易
           在杀毒软件扫描锁定时撞上 EPERM/ENOENT（实测踩过） */
        const existing = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
        const h = { ...headers };
        let append = false;
        if (existing > 0) {
          h.Range = `bytes=${existing}-`;
          append = true;
        }
        const res = await fetchWithTimeout(url, { headers: h, redirect: "follow", signal: ctx.abort.signal }, 60000);
        if (res.status === 416) {
          /* 断点已到文件末尾 = 文件其实已经下完了 */
          onProgress(100);
          return;
        }
        if (!res.ok && res.status !== 206) throw new Error(`资源不可用（HTTP ${res.status}）`);
        if (res.status === 200 && existing > 0) {
          /* 服务器不支持 Range，返回了完整内容 → 从头写 */
          append = false;
        }
        const segTotal = Number(res.headers.get("content-length")) || 0;
        const total = append ? existing + segTotal : segTotal;
        let received = append ? existing : 0;
        let lastTime = Date.now();
        let lastBytes = 0;
        let lastData = Date.now();
        if (total) ctx.task.total = Math.max(ctx.task.total, total);
        const out = fs.createWriteStream(dest, { flags: append ? "a" : "w" });
        const iter = Readable.fromWeb(res.body);
        await new Promise((resolve, reject) => {
          let settled = false;
          const done = (fn, arg) => {
            if (settled) return;
            settled = true;
            clearInterval(watch);
            fn(arg);
          };
          /* 卡死看门狗：20 秒无字节流动视为连接僵死——声明大小已收满按完成，
             否则掐断走断点续传。有些原画流谎报 content-length 后卡住不发
             结束信号，任务会永远挂在"下载中"（实测踩过） */
          const watch = setInterval(() => {
            if (Date.now() - lastData > 20000) {
              try { iter.destroy(); } catch {}
              try { out.destroy(); } catch {}
              done(reject, new Error("STREAM_STALLED"));
            }
          }, 5000);
          iter.on("data", (chunk) => {
            received += chunk.length;
            ctx.hadBytes = true;
            lastData = Date.now();
            /* 进度只许前进不许回退：换候选地址续传时 received 会从
               分片大小重新计，回退的百分比会让进度条来回抽动（实测踩过） */
            if (received > highWater) highWater = received;
            ctx.task.downloaded = highWater;
            /* 服务器给的 content-length 与实际流不符时（长视频原画常见），
               改按"未知总大小"展示（只显示已下载），进度条不再给假分母 */
            if (total && received > total) {
              ctx.task.total = 0;
            }
            const now = Date.now();
            if (now - lastTime > 400) {
              ctx.task.speed_bps = Math.round(((received - lastBytes) * 1000) / (now - lastTime));
              lastTime = now;
              lastBytes = received;
              if (total && ctx.task.total) onProgress(Math.min(100, (highWater / ctx.task.total) * 100));
              pushTask(ctx);
            }
            /* 声明大小的字节已全部收到：判定完成，不等可能永远不来的
               流结束事件（卡死场景），冲刷落盘后返回 */
            if (total && received >= total) {
              done(resolve);
              try { iter.destroy(); } catch {}
              try { out.end(); } catch {}
            }
          });
          iter.on("error", (e) => done(reject, e));
          out.on("error", (e) => done(reject, e));
          out.on("finish", () => done(resolve));
          iter.pipe(out);
        });
        onProgress(100);
        return;
      } catch (e) {
        if (e.name === "AbortError" || ctx.canceled) throw e;
        lastError = e;
        /* 文件中途消失 = 被安全软件（火绒 HIPS/360 等）拦截隔离，不是网络问题。
           标记后给出可操作的指引，避免用户被"路径过长"误导（实测踩过） */
        if (/ENOENT/i.test(String(e.message || e)) && !fs.existsSync(dest) && ctx.hadBytes) {
          ctx.quarantined = true;
          lastError = new Error("QUARANTINED");
        }
        /* 保留分片做断点续传，不再删除文件。
           写入中途文件消失（ENOENT）几乎都是杀毒软件实时扫描隔离大文件导致；
           等 3 秒让扫描释放，再从断点续传。 */
        if (attempt < retries) {
          const wait = /ENOENT|EPERM|EBUSY/i.test(String(lastError.message || lastError)) ? 3000 : 800;
          ctx.task.message = ctx.quarantined
            ? "文件被安全软件拦截，正在重试…"
            : "网络中断，稍后从断点续传…";
          pushTask(ctx);
          await new Promise((r) => setTimeout(r, wait * (attempt + 1)));
          if (!ctx.quarantined) ctx.task.message = "下载视频";
        }
      }
    }
  }
  throw lastError;
}

async function runTask(ctx) {
  const { req, task, abort } = ctx;
  /* 同目标文件互斥：同一视频的另一个任务还在写这个文件时不再叠加下载
     （否则两个流交错写同一文件，进度来回反复、内容损坏） */
  const fileKey = `${req.bid || req.page_url}`;
  try {
    if (activeFileKeys.has(fileKey)) {
      throw new Error("同一作品已在下载队列中，请勿重复添加");
    }
    activeFileKeys.add(fileKey);
    task.status = "downloading";
    task.message = "解析下载地址";
    pushTask(ctx);

    /* 有 bid 就走单条作品页（主页链接会拿到无直链的轻量列表）；
       page_url 仅作为无 bid 时的兜底 */
    const sourceUrl = req.bid
      ? `https://www.douyin.com/video/${req.bid}`
      : req.page_url || "";
    const item = (await probeFromInput(sourceUrl)).items[0];
    if (ctx.canceled) throw Object.assign(new Error("已取消"), { name: "AbortError" });
    if (item.has_video && (!item.media_urls || !item.media_urls.length)) {
      throw new Error("没有解析到视频地址（该作品可能已删除或不支持直链下载）");
    }

    /* 清晰度策略：ratio=default/4k/2k 的实际行为因作品而异（default 有时给原画、
       有时反而只有 720p），所以"智能"不看档位名——把每个候选都用 Range 请求
       探一下真实体积，谁大下载谁，探测失败的排到后面兜底。
       暂停后继续时复用首次的下载计划（URL 顺序 + 预期大小）——重新探测会因
       网络波动得到不同排序，导致断点续传对错档 URL、误判完成（实测踩过）。 */
    let ordered;
    let expectedSize;
    if (ctx.resumePlan) {
      ordered = ctx.resumePlan.ordered;
      expectedSize = ctx.resumePlan.expectedSize;
    } else {
    const ratios = ratiosForQuality(req.quality || settings.video_quality);
    const cands = [];
    const pushCand = (u) => {
      if (u && !cands.includes(u)) cands.push(u);
    };
    if (item.video_uri) {
      for (const r of ratios) {
        pushCand(
          `https://www.iesdouyin.com/aweme/v1/play/?video_id=${item.video_uri}&ratio=${r}&line=0`
        );
      }
    }
    for (const u of item.media_urls || []) {
      if (/[?&]ratio=/.test(u)) {
        for (const r of ratios) pushCand(u.replace(/([?&])ratio=[^&]+/, `$1ratio=${r}`));
      } else {
        pushCand(u);
      }
    }
    /* 按真实体积从大到小排：最大即源的最高档。
       体积探测要节制：每个候选都是一次对播放接口的请求，发多了会触发
       CDN 限流（下载流被反复掐断 → 进度回跳）。只探前 3 个候选
       （最高优先档 + 两个回落），其余按原顺序兜底；探测超时 6 秒。 */
    const loginCookie = loginCookieHeader();
    const sized = await Promise.all(
      cands.slice(0, 3).map(async (u) => {
        try {
          const res = await fetchWithTimeout(
            u,
            {
              headers: {
                "User-Agent": UA_MOBILE,
                Referer: "https://www.douyin.com/",
                Range: "bytes=0-1",
                ...(loginCookie ? { Cookie: loginCookie } : {}),
              },
              redirect: "follow",
            },
            6000
          );
          const cr = res.headers.get("content-range");
          if (cr) {
            const total = Number(String(cr).split("/")[1]);
            if (total) return { u, size: total };
          }
          return { u, size: Number(res.headers.get("content-length")) || 0 };
        } catch {
          return { u, size: 0 };
        }
      })
    );
    sized.sort((a, b) => b.size - a.size);
    ordered = [];
    for (const s of sized) if (s.size > 0) ordered.push(s.u);
    for (const u of cands) if (!ordered.includes(u)) ordered.push(u);
    /* 首选地址的声明大小：curl 下载进度分母 */
    expectedSize = sized.find((s) => s.u === ordered[0])?.size || 0;
    ctx.resumePlan = { ordered, expectedSize };
    }

    const vars = {
      ...(req.naming || {}),
      title: item.title,
      author: item.author,
      bid: item.bid,
      publish_date: localDate(item.created_at),
      date: localDate(),
      year: String(new Date((item.created_at || Date.now() / 1000) * 1000).getFullYear()),
      month: String(new Date((item.created_at || Date.now() / 1000) * 1000).getMonth() + 1).padStart(2, "0"),
      source_kind: item.has_video ? "单条作品" : "图集",
    };
    /* 路径长度保护：Windows 单文件名上限 255 字符、整路径 260 字符，
       超长标题（如微短剧）会让 fs.open 直接 ENOENT。逐段截断。 */
    const capSeg = (s, max) => (String(s).length > max ? String(s).slice(0, max) : String(s));
    const folderRel = renderTemplate(settings.folder_template, vars, "", { dir: true });
    const dirParts = folderRel
      .split(path.sep)
      .filter(Boolean)
      .map((seg) => capSeg(seg, 50));
    const dir = path.join(settings.output_dir, ...dirParts);
    fs.mkdirSync(dir, { recursive: true });

    const base = capSeg(renderTemplate(settings.naming_template, vars, ""), 80);
    const mode = settings.rename_conflict || "skip";
    const produced = [];
    const failedParts = [];
    let totalBytes = 0;

    const ensureNotSkipped = () => {
      if (ctx.canceled) throw Object.assign(new Error("已取消"), { name: "AbortError" });
    };

    if (item.has_video && item.media_urls && item.media_urls.length) {
      ensureNotSkipped();
      /* 暂停后继续：上次写了一半的文件直接复用（curl -C - 断点续传），
         不走重名避让——否则已存在的分片会被判"跳过" */
      let dest;
      if (ctx.resumableDest && fs.existsSync(ctx.resumableDest)) {
        dest = ctx.resumableDest;
      } else {
        const ud = uniqueDest(path.join(dir, `${base}.mp4`), mode);
        if (ud.skipped) throw new Error("已存在同名文件，按设置跳过");
        dest = ud.dest;
      }
      ctx.resumableDest = dest;
      task.message = "下载视频";
      task.total = 0;
      task.downloaded = 0;
      await downloadTo(ordered, dest, ctx, (pct) => {
        task.video_pct = pct;
      }, expectedSize);
      produced.push(dest);
      task.video_pct = 100;
      /* 视频流结束：速度归零并立刻可见，避免"下载完了速度还在动"的错觉 */
      task.speed_bps = 0;
      pushTask(ctx);
    }

    if (item.images && item.images.length) {
      const count = item.images.length;
      for (let i = 0; i < count; i += 1) {
        ensureNotSkipped();
        const { dest, skipped } = uniqueDest(path.join(dir, `${base}-${i + 1}.jpg`), mode);
        if (skipped) continue;
        task.message = `下载图集 ${i + 1}/${count}`;
        await downloadTo([item.images[i]], dest, ctx, () => {
          task.image_pct = ((i + 1) / count) * 100;
        });
        produced.push(dest);
        task.image_pct = ((i + 1) / count) * 100;
        task.speed_bps = 0;
        pushTask(ctx);
      }
    }

    /* 音乐与文案是附属产物：失败只记录，不拖垮已完成的视频/图集 */
    if (item.music_urls && item.music_urls.length && settings.audio_quality !== "none") {
      ensureNotSkipped();
      const { dest, skipped } = uniqueDest(path.join(dir, `${base}.mp3`), mode);
      if (!skipped) {
        task.message = "下载背景音乐";
        pushTask(ctx);
        try {
          await downloadTo(item.music_urls, dest, ctx, () => {});
          produced.push(dest);
        } catch {
          failedParts.push("背景音乐");
        }
        task.speed_bps = 0;
      }
    }

    if (settings.download_text) {
      ensureNotSkipped();
      task.status = "saving";
      task.message = "保存文案";
      pushTask(ctx);
      const { dest, skipped } = uniqueDest(path.join(dir, `${base}.txt`), mode);
      if (!skipped) {
        const content = [
          item.title,
          "",
          `作者：${item.author}`,
          `发布时间：${localDate(item.created_at)}`,
          `原链：${req.page_url || ""}`,
          "",
        ].join("\n");
        try {
          fs.writeFileSync(dest, content, "utf8");
          produced.push(dest);
        } catch {
          /* 文案写失败（常见为杀毒锁定）不拖垮已完成的媒体 */
          failedParts.push("文案");
        }
      }
    }

    if (!produced.length) throw new Error("没有可下载的内容");
    /* 登记下载清单：供「重命名已下载」按 bid 找到旧文件。
       files 记后缀（.mp4 / -2.jpg）而非全名——base 改名后缀不变，永不错位 */
    if (req.bid) {
      manifest[req.bid] = {
        dir,
        base,
        files: produced.map((f) => {
          const n = path.basename(f);
          return n.startsWith(base) ? n.slice(base.length) : n;
        }),
        title: item.title,
        updated: Date.now(),
      };
      saveManifest();
    }
    task.status = "done";
    task.message = failedParts.length
      ? `已完成（${failedParts.join("、")}保存失败，可重试补下）`
      : "已完成";
    task.output_path = produced[0];
    if (!task.total) task.total = task.downloaded;
    task.speed_bps = 0;
  } catch (e) {
    if (ctx.paused) {
      /* 用户暂停：保留分片与任务，等「继续」从断点接续 */
      task.status = "paused";
      task.message = "已暂停";
    } else if (e.name === "AbortError" || ctx.canceled) {
      task.status = "canceled";
      task.message = "已取消";
    } else {
      if (ctx.quarantined) {
        task.status = "failed";
        task.message = "下载文件被安全软件（火绒/360 等的防护）拦截删除。请在杀毒软件信任区添加本应用或保存目录后重试";
      } else {
        const raw = String(e.message || e);
        task.status = "failed";
        if (/EPERM|EBUSY/i.test(raw)) {
          task.message = "写入被其他程序占用（常见为杀毒软件扫描大文件）；分片已保留，重试将从断点续传";
        } else if (/ENOENT|ENAMETOOLONG|path too long/i.test(raw)) {
          task.message = "保存失败：路径过长或目录无法写入，请在设置中更换保存目录";
        } else {
          task.message = raw;
        }
      }
    }
    task.speed_bps = 0;
  } finally {
    activeFileKeys.delete(fileKey);
  }
  pushTask(ctx);
}

/* ---------------- 诊断与清理 ---------------- */

function cleanupTemp() {
  let count = 0;
  try {
    if (fs.existsSync(TMP_DIR)) {
      count = fs.readdirSync(TMP_DIR).length;
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TMP_DIR, { recursive: true });
  } catch {
    count = 0;
  }
  return count;
}

function exportDiagnostics() {
  const file = path.join(DATA_DIR, `diagnostics-${Date.now()}.txt`);
  const lines = [
    `DYdown v${VERSION}`,
    `平台: ${process.platform} ${process.arch}`,
    `数据目录: ${DATA_DIR}`,
    `任务数: ${tasks.size}`,
    "",
    "当前设置:",
    JSON.stringify(settings, null, 2),
  ];
  fs.writeFileSync(file, lines.join("\n"), "utf8");
  return file;
}

async function checkUpdatesFallback() {
  try {
    const res = await fetchWithTimeout(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { headers: { "User-Agent": "DYdown-Update-Check", Accept: "application/vnd.github+json" } },
      10000
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const latest = String(data.tag_name || "").replace(/^v/, "");
    const current = VERSION;
    const cmp = (v) => String(v).split(".").map((n) => parseInt(n, 10) || 0);
    const a = cmp(current);
    const b = cmp(latest);
    const upToDate = !latest || a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2])));
    return { current, latest, up_to_date: upToDate, error: "" };
  } catch (e) {
    return { current: VERSION, latest: "", up_to_date: false, error: String(e.message || e) };
  }
}

/* ---------------- 静态资源 ---------------- */

function serveStatic(req, res, pathname) {
  let p = decodeURIComponent(pathname);
  if (p === "/" || p === "") p = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.toLowerCase().startsWith(PUBLIC_DIR.toLowerCase())) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("404 Not Found");
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(buf);
  });
}

/* ---------------- HTTP 服务 ---------------- */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function openInShell(kind, target) {
  if (process.platform === "win32") {
    exec(kind === "reveal" ? `explorer /select,"${target}"` : `start "" "${target}"`, () => {});
  }
}

const NAMING_VARIABLES = [
  ["title", "作品文案", "标题与作者", "抖音文案前 30 字"],
  ["author", "作者名", "标题与作者", "发视频的人"],
  ["bid", "作品ID", "作品标识", "抖音作品 aweme_id"],
  ["mid", "数字ID", "作品标识", "作品数字 ID"],
  ["uid", "作者UID", "作品标识", "作者的数字 ID"],
  ["publish_date", "发布日期", "时间", "作品发布那天"],
  ["date", "下载日期", "时间", "任务创建那天"],
  ["year", "发布年", "时间", "如 2025"],
  ["month", "发布月", "时间", "如 10（补零）"],
  ["source_kind", "来源类型", "来源与格式", "单条作品 / 图集"],
  ["index", "序号", "来源与格式", "批次内由旧到新；单条为 1"],
  ["ext", "扩展名", "来源与格式", "mp4 / jpg / mp3 / txt"],
].map(([token, label, section, hint]) => ({ token, label, section, hint }));

const NAMING_SAMPLE = {
  title: "示例作品标题",
  author: "抖音作者",
  bid: "7340000000000000000",
  mid: "0",
  uid: "0",
  date: localDate(),
  publish_date: "2025-10-01",
  year: "2025",
  month: "10",
  source_kind: "单条作品",
  index: 1,
  index_pad: 1,
};

function startServer(opts = {}) {
  const port = Number(opts.port ?? process.env.PORT ?? 3000);
  const host = opts.host || process.env.HOST || "0.0.0.0";
  if (opts.electronBridge) electronBridge = opts.electronBridge;
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const p = u.pathname;
    try {
      if (p === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        res.write(": connected\n\n");
        for (const ctx of tasks.values()) {
          res.write(`data: ${JSON.stringify({ task: ctx.task })}\n\n`);
        }
        sseClients.add(res);
        const beat = setInterval(() => {
          try {
            res.write(": beat\n\n");
          } catch {}
        }, 15000);
        req.on("close", () => {
          clearInterval(beat);
          sseClients.delete(res);
        });
        return;
      }
      if (req.method === "POST" && p === "/api/probe") {
        const body = await readBody(req);
        const data = await probeFromInput(body.input || "");
        return sendJson(res, 200, { data });
      }
      if (req.method === "POST" && p === "/api/profile-load-all") {
        const body = await readBody(req);
        const secUid = body.secUid || "";
        if (!secUid) return sendJson(res, 200, { error: "缺少 secUid" });
        if (!electronBridge || typeof electronBridge.loadAllViaWindow !== "function") {
          return sendJson(res, 200, { error: "需要在桌面版中使用" });
        }
        try {
          /* 弹窗让用户滚动：DOM 收集 ID + 页面内拦截器捕获完整作品数据 */
          const data = await electronBridge.loadAllViaWindow(secUid);
          const ids = data.ids || [];
          const pageItems = data.items || []; /* 拦截器捕获的原始 aweme 数据 */
          if (!ids.length && !pageItems.length) {
            return sendJson(res, 200, {
              error: data.reason
                ? `没有收集到作品：${data.reason}`
                : "没有收集到作品（请在窗口里滚动一下再点「完成加载」）",
            });
          }
          const known = userKnown.get(secUid) || new Set();
          userKnown.set(secUid, known);
          let entries;
          let failed;
          if (pageItems.length) {
            /* 拦截器数据优先：那是抖音自己请求的响应（完整字段 + 无风控风险）。
               按作者 sec_uid 过滤：用户在窗口里点进别人主页时，那个人的作品
               也会被拦截器捕获，必须剔除。 */
            entries = pageItems
              .filter((a) => a && a.author && (!a.author.sec_uid || a.author.sec_uid === secUid))
              .map(itemFromAweme)
              .filter((e) => {
                if (!e.bid || known.has(e.bid)) return false;
                known.add(e.bid);
                return true;
              });
            const got = new Set(entries.map((e) => e.bid));
            failed = ids.filter((id) => !got.has(id)).length;
          } else {
            /* 兜底：拦截器没捕获到（用户没滚动触发请求等）时逐条解析 */
            const r = await resolveVideoIds(ids, known);
            entries = r.entries;
            failed = r.failed;
          }
          const nickname = data.nickname || (entries[0] && entries[0].author) || "抖音用户";
          console.log(`[load-all] ${secUid.slice(0, 16)}… 收集 ${ids.length} 个 ID，解析成功 ${entries.length}，失败 ${failed}`);
          return sendJson(res, 200, {
            data: {
              items: entries,
              nickname,
              count: entries.length,
              failed,
              collected: ids.length,
            },
          });
        } catch (e) {
          return sendJson(res, 200, { error: String(e.message || e) });
        }
      }
      if (req.method === "POST" && p === "/api/mix-items") {
        /* 解析某个合集的全部视频（可见窗口 + 用户滚动右侧选集列表） */
        const body = await readBody(req);
        const mixId = String(body.mixId || "");
        if (!mixId) return sendJson(res, 200, { error: "缺少 mixId" });
        try {
          const data = await probeMixItems(mixId, String(body.name || ""));
          return sendJson(res, 200, { data });
        } catch (e) {
          return sendJson(res, 200, { error: String(e.message || e) });
        }
      }
      if (req.method === "POST" && p === "/api/download-start") {
        const body = await readBody(req);
        const id = startDownload(body.req || {});
        return sendJson(res, 200, { data: id });
      }
      if (req.method === "POST" && p === "/api/download-cancel") {
        const body = await readBody(req);
        cancelDownload(body.taskId || "");
        return sendJson(res, 200, { data: true });
      }
      if (req.method === "POST" && p === "/api/download-pause") {
        const body = await readBody(req);
        pauseDownload(body.taskId || "");
        return sendJson(res, 200, { data: true });
      }
      if (req.method === "POST" && p === "/api/download-resume") {
        const body = await readBody(req);
        resumeDownload(body.taskId || "");
        return sendJson(res, 200, { data: true });
      }
      /* 「重命名已下载」：按当前命名模板给已下载条目改名（只改文件名，不动目录层级）。
         apply=false 为预演，只统计不改盘。 */
      if (req.method === "POST" && p === "/api/rename-downloaded") {
        const body = await readBody(req);
        const items = Array.isArray(body.items) ? body.items : [];
        const template = body.template || settings.naming_template;
        const apply = !!body.apply;
        let renamed = 0;
        let skipped = 0;
        let notFound = 0;
        for (const it of items) {
          const rec = it.bid && manifest[it.bid];
          if (!rec || !rec.dir || !Array.isArray(rec.files) || !rec.files.length) {
            notFound += 1;
            continue;
          }
          /* 旧版清单记录的是完整文件名：base 与实际名一致时迁移为后缀模型 */
          if (rec.base && rec.files.every((f) => f.startsWith(rec.base))) {
            rec.files = rec.files.map((f) => f.slice(rec.base.length));
          }
          const newBase = renderTemplate(template, it.naming || {}, "");
          const oldBase = rec.base || "";
          let itemRenamed = 0;
          let itemSkipped = 0;
          for (const suffix of rec.files) {
            const from = path.join(rec.dir, oldBase + suffix);
            const to = path.join(rec.dir, newBase + suffix);
            if (!fs.existsSync(from)) continue;
            if (from === to || fs.existsSync(to)) {
              itemSkipped += 1;
              continue;
            }
            if (apply) {
              try {
                fs.renameSync(from, to);
                itemRenamed += 1;
              } catch {
                itemSkipped += 1;
              }
            } else {
              itemRenamed += 1;
            }
          }
          if (itemRenamed) renamed += 1;
          else if (itemSkipped) skipped += 1;
          else notFound += 1;
          if (apply && itemRenamed) rec.base = newBase;
        }
        if (apply) saveManifest();
        return sendJson(res, 200, { data: { renamed, skipped, notFound } });
      }
      if (p === "/api/avatar") {
        /* 本地头像缓存（登录后由主进程抓取写入）；文件不存在返回 404 */
        try {
          const buf = fs.readFileSync(AVATAR_FILE);
          res.writeHead(200, {
            "Content-Type": "image/jpeg",
            "Cache-Control": "no-cache",
          });
          return res.end(buf);
        } catch {
          res.writeHead(404);
          return res.end();
        }
      }
      if (p === "/api/status") {
        const login = loadLogin();
        const hasAvatar = !!(login && login.avatar_local && fs.existsSync(AVATAR_FILE));
        return sendJson(res, 200, {
          data: {
            version: VERSION,
            login: {
              logged_in: !!login,
              uname: (login && login.nickname) || "",
              /* 本地缓存头像（带抓取时间戳防缓存）；没有本地文件则空 */
              face: hasAvatar ? `/api/avatar?t=${(login && login.profile_at) || 0}` : "",
              mid: 0,
              vip: false,
              vip_label: "",
            },
            output_dir: settings.output_dir,
            data_dir: DATA_DIR,
          },
        });
      }
      if (req.method === "POST" && p === "/api/logout") {
        try {
          fs.unlinkSync(COOKIES_FILE);
        } catch {}
        if (electronBridge && typeof electronBridge.logoutCleanup === "function") {
          try {
            electronBridge.logoutCleanup();
          } catch {}
        }
        return sendJson(res, 200, {
          data: { logged_in: false, uname: "", face: "", mid: 0, vip: false, vip_label: "" },
        });
      }
      if (p === "/api/settings" && req.method === "GET") {
        return sendJson(res, 200, {
          data: { settings, version: VERSION, data_dir: DATA_DIR },
        });
      }
      if (req.method === "POST" && p === "/api/settings") {
        const body = await readBody(req);
        if (body.settings && typeof body.settings === "object") {
          settings = { ...settings, ...body.settings };
          saveSettings();
          pump();
        }
        return sendJson(res, 200, {
          data: { settings, version: VERSION, data_dir: DATA_DIR },
        });
      }
      if (req.method === "POST" && p === "/api/preview-naming") {
        const body = await readBody(req);
        const vars = {
          ...NAMING_SAMPLE,
          ...(body.date ? { date: body.date } : {}),
          ...(body.publish_date ? { publish_date: body.publish_date } : {}),
        };
        const out = renderTemplate(
          body.template || "",
          vars,
          body.dir ? "" : body.ext || "jpg",
          { dir: !!body.dir }
        );
        return sendJson(res, 200, { data: out });
      }
      if (req.method === "POST" && p === "/api/preview-names") {
        const body = await readBody(req);
        const items = Array.isArray(body.items) ? body.items : [];
        const names = items.map((item) =>
          renderTemplate(
            settings.naming_template,
            { ...NAMING_SAMPLE, ...(item.vars || {}) },
            body.ext || "txt"
          )
        );
        return sendJson(res, 200, { data: names });
      }
      if (p === "/api/naming-variables") {
        return sendJson(res, 200, { data: NAMING_VARIABLES });
      }
      if (req.method === "POST" && p === "/api/choose-dir") {
        return sendJson(res, 200, { data: settings.output_dir });
      }
      if (req.method === "POST" && p === "/api/open-path") {
        const body = await readBody(req);
        openInShell("open", body.path || "");
        return sendJson(res, 200, { data: true });
      }
      if (req.method === "POST" && p === "/api/reveal-path") {
        const body = await readBody(req);
        openInShell("reveal", body.path || "");
        return sendJson(res, 200, { data: true });
      }
      if (req.method === "POST" && p === "/api/cleanup-temp") {
        return sendJson(res, 200, { data: cleanupTemp() });
      }
      if (req.method === "POST" && p === "/api/export-diagnostics") {
        return sendJson(res, 200, { data: exportDiagnostics() });
      }
      if (p === "/api/check-updates") {
        return sendJson(res, 200, { data: await checkUpdatesFallback() });
      }
      if (req.method === "GET" && p === "/api/health") {
        return sendJson(res, 200, { code: 0, name: "DYdown", version: VERSION });
      }
      if (req.method === "GET") return serveStatic(req, res, p);
      res.writeHead(405);
      res.end();
    } catch (e) {
      const msg = e && e.name === "AbortError" ? "网络请求超时，请稍后重试" : String(e.message || e);
      console.error(`[api-error] ${p}: ${msg}`);
      sendJson(res, 200, { error: msg });
    }
  });
  server.listen(port, host, () => {
    if (opts.quiet) return;
    console.log(`  DYdown 已启动: http://127.0.0.1:${port}`);
  });
  return server;
}

/* 独立网页模式：node server.cjs（Electron 模式下由 main.cjs 调用） */
if (require.main === module) startServer();

module.exports = { startServer };
