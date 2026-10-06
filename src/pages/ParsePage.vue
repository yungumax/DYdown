<script setup>
import Icon from "../components/Icon.vue";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { animate, stagger } from "animejs";
import * as api from "../api";
import { KIND_LABELS, batchNaming, paddedSeq, pickDefaultQuality, singleNaming } from "../download-request.js";
import StepHeader from "../components/StepHeader.vue";

const props = defineProps({
  login: { type: Object, required: true },
  settings: { type: Object, default: null },
  /// 内容库点「去解析」时带过来的来源：{ url, stamp }，看到就自动解析
  pendingSource: { type: Object, default: null },
});
const emit = defineEmits(["toast", "goto"]);

const text = ref("");
const parsing = ref(false);

/** 主按钮磁吸：轻微朝鼠标偏移（±4px），移开弹回。只动 transform。 */
const magnetWrap = ref(null);
function magnetMove(event) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const el = magnetWrap.value;
  const r = el.getBoundingClientRect();
  const dx = ((event.clientX - r.left) / r.width - 0.5) * 8;
  const dy = ((event.clientY - r.top) / r.height - 0.5) * 6;
  el.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
}
function magnetLeave() {
  if (magnetWrap.value) magnetWrap.value.style.transform = "";
}
const done = ref(0);
const total = ref(0);
const items = ref([]);

/** 本次解析被跳过的重复来源，列在解析结果里 */
const parseSkipped = ref([]);
const selected = ref(new Set());
const okItems = computed(() => items.value.filter((item) => item.ok));
const failedItems = computed(() => items.value.filter((item) => !item.ok));

/** 已经解析出来的来源条数：单条作品算 1 */
function sourceCount(item) {
  return item.probe.kind === "post" ? 1 : item.probe.items.length;
}

function itemKey(item) {
  return item.probe ? `post:${item.probe.bid || item.input}` : item.input;
}

const steps = computed(() => {
  return [
    {
      index: 1,
      title: "解析来源",
      hint: parsing.value ? `解析中 ${done.value}/${total.value}` : "输入链接",
      // 状态跟着当前所在页面走：在选择页时第 1 步才算完成
      state: view.value === "select" ? "done" : "active",
      to: view.value === "select" ? "input" : "",
    },
    {
      index: 2,
      title: "选择内容",
      hint: view.value === "select"
        ? activeSource.value?.probe.kind === "post"
          ? "确认内容"
          : `已选 ${selectedCount.value} / 已加载 ${loadedCount.value}`
        : okItems.value.length
          ? `${okItems.value.length} 个来源待选择`
          : "等待解析",
      state: view.value === "select" ? "active" : "idle",
      // 有解析结果时第 2 步才可跳
      to: view.value !== "select" && items.value.length && !parsing.value ? "select" : "",
    },
  ];
});

// 支持的来源；图标用 iconfont 图标名（src/icons.js）
const sources = [
  { label: "单条视频", icon: "play" },
  { label: "抖音图集", icon: "photo" },
  { label: "个人主页", icon: "user" },
  { label: "整段口令", icon: "clipboard" },
  { label: "多行批量", icon: "listLine" },
];

/** Unix 秒 → 本地日期文本（表格时间列用，悬停看完整日期） */
function formatTime(unixSecs) {
  if (!unixSecs) return "—";
  const d = new Date(unixSecs * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 行的类型标签：转发 > 音频 > 视频 > N 图 > 纯文字 */
function typeLabel(entry) {
  if (entry.is_retweet) return "转发";
  if (entry.is_audio) return "音频";
  if (entry.has_video) return "视频";
  if (entry.pics > 0) return `${entry.pics} 图`;
  return "文字";
}

async function pasteFromClipboard() {
  const value = await api.readClipboard();
  if (!value) {
    emit("toast", "读取剪贴板失败，请手动粘贴");
    return;
  }
  text.value = text.value.trim() ? `${text.value.trim()}\n${value}` : value;
}

/// 内容库送来的来源：填进输入框、直接解析一次。
/// 用 stamp 判重（同一条点两次也要能重新解析），所以不"吃掉"这个值。
watch(
  () => props.pendingSource?.stamp,
  async (stamp) => {
    const url = props.pendingSource?.url;
    if (!stamp || !url) return;
    text.value = url;
    view.value = "input";
    await nextTick();
    if (!parsing.value) await parse();
  }
);

async function parse() {
  // 同一链接贴两次不必解析两遍；被跳过的记下来，回头列在解析结果里
  const skipped = [];
  const inputs = [];
  const seenLine = new Set();
  for (const raw of text.value.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (seenLine.has(line)) {
      skipped.push({ input: line, reason: "与前面的链接相同" });
      continue;
    }
    seenLine.add(line);
    inputs.push(line);
  }
  if (!inputs.length || parsing.value) return;

  // 按解析节奏分批：批内并发、批间等待、每 N 条休息，降低触发风控的概率
  parsing.value = true;
  items.value = [];
  selected.value = new Set();
  done.value = 0;
  total.value = inputs.length;

  const collected = [];
  const seenKeys = new Map();
  const batch = Math.max(1, props.settings?.parse_batch ?? 8);
  const batchWait = props.settings?.parse_batch_wait_ms ?? 1000;
  const restEvery = Math.max(1, props.settings?.parse_rest_every ?? 100);
  const restMs = props.settings?.parse_rest_ms ?? 3000;

  const probeOne = async (input) => {
    try {
      const probe = await api.probeSource(input);
      // 同一个来源（同一链接/同一博主的另一份入口）只保留第一次；
      // 键带来源类型：同一账号的「主页」与「合集 tab」是两份不同内容，不能互相顶掉
      const key = `${probe.kind}:${probe.kind === "post" ? probe.bid : probe.uid}`;
      if (seenKeys.has(key)) {
        skipped.push({
          input,
          reason: `与「${seenKeys.get(key)}」是同一个来源`,
        });
        done.value += 1;
        return;
      }
      seenKeys.set(key, probe.title || input);
      collected.push({
        input,
        ok: true,
        error: "",
        probe,
        quality: pickDefaultQuality(probe, props.settings),
      });
    } catch (error) {
      collected.push({ input, ok: false, error: String(error) });
    }
    done.value += 1;
    items.value = [...collected];
  };

  for (let start = 0; start < inputs.length; start += batch) {
    await Promise.all(inputs.slice(start, start + batch).map(probeOne));
    const finished = start + batch;
    if (finished >= inputs.length) break;
    if (finished % restEvery === 0 && restMs > 0) {
      await new Promise((r) => setTimeout(r, restMs));
    } else if (batchWait > 0) {
      await new Promise((r) => setTimeout(r, batchWait));
    }
  }

  parsing.value = false;
  parseSkipped.value = [...skipped];

  const failed = collected.filter((item) => !item.ok).length;
  if (failed) {
    emit("toast", `${collected.length - failed} 条解析成功，${failed} 条失败`);
  }
  if (skipped.length) {
    emit("toast", `已跳过 ${skipped.length} 个重复来源，明细见解析结果`);
  }

  // 解析成功的一律进「选择内容」页：单条与批量清单都在那里挑
  const firstOk = collected.find((item) => item.ok);
  if (firstOk) openSelect(firstOk.input);
}

function isSelected(row) {
  return selected.value.has(row.key);
}

function toggleEntry(row) {
  const next = new Set(selected.value);
  if (next.has(row.key)) next.delete(row.key);
  else next.add(row.key);
  selected.value = next;
}

// ---------- 选择内容页 ----------
// 解析结果不再塞在输入页里，而是独立一页：表格 + 分批加载。
// 首次解析只给第一页，「继续解析」用后端缓存接着往后拉。
const view = ref("input"); // input | select

// 选择页入场：工具条 + 表格行级联（列表以列表的方式出现）
watch(view, async (v) => {
  if (v !== "select" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  await nextTick();
  requestAnimationFrame(() => {
    const bar = document.querySelector(".select-bar");
    const rows = [...document.querySelectorAll(".batch-table tbody tr")].slice(0, 12);
    const targets = bar ? [bar, ...rows] : rows;
    if (targets.length) animate(targets, { opacity: [0, 1], translateY: [8, 0], duration: 420, delay: stagger(28), ease: "outExpo" });
  });
});

// 解析结果入口：结果条目逐个亮起（只在从无到有时演一次）
watch(
  () => items.value.length > 0,
  async (has) => {
    if (!has || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    await nextTick();
    requestAnimationFrame(() => {
      const cells = [...document.querySelectorAll(".parsed-bar > *")];
      if (cells.length) animate(cells, { opacity: [0, 1], translateY: [6, 0], duration: 340, delay: stagger(40), ease: "outExpo" });
    });
  }
);
const batchInput = ref(""); // 当前查看的来源

/** 已解析出的来源：单条与批量都能在选择页里看 */
const allSources = computed(() => okItems.value);

const activeSource = computed(() => {
  const list = allSources.value;
  return list.find((item) => item.input === batchInput.value) || list[0] || null;
});

/** 选择页要占满高度：顶部工具条与底部统计固定，只有表体滚动 */
const isSelectView = computed(() => view.value === "select" && !!activeSource.value);

/** 当前来源是批量清单（单条作品没有分页） */
const activeIsBatch = computed(() => !!activeSource.value && activeSource.value.probe.kind !== "post");

/** 表头：只有一个来源就显示它自己，多个来源显示来源数 */
const headerTitle = computed(() => {
  if (allSources.value.length === 1) return activeSource.value?.probe.title ?? "";
  const users = allSources.value.filter((item) => item.probe.kind !== "post");
  if (users.length === allSources.value.length) return `${allSources.value.length} 个用户主页`;
  return `${allSources.value.length} 个来源`;
});

const headerTag = computed(() => {
  if (allSources.value.length === 1) {
    const p = activeSource.value?.probe;
    return p?.mix ? "合集" : kindLabel(p?.kind ?? "");
  }
  return allSources.value.every((item) => item.probe.kind === "post") ? "抖音" : "";
});

/** 行悬停显示该行将落盘的文件名（与下载共用后端渲染器） */
function fileNameOf(row) {
  const name = fileNames.value[row.seq - 1];
  return name ? `${row.title}  |  文件名：${name}` : row.title;
}

const loadedCount = computed(() => tableRows.value.length);

/** 抖音单条无分页；提示语保留批量口径 */
const loadedHint = computed(() => {
  const probe = activeSource.value?.probe;
  if (!probe) return "";
  if (probe.total && activeIsBatch.value) return `已加载 ${loadedCount.value} / ${probe.total} 项`;
  return `已加载 ${loadedCount.value} 项`;
});

const selectedCount = computed(() => allRowsFlat.value.filter((row) => isSelected(row)).length);
const allLoadedSelected = computed(
  () => allRowsFlat.value.length > 0 && selectedCount.value === allRowsFlat.value.length
);

/** 全选/全不选只作用于"已加载"的部分，没拉下来的不会被选中 */
function toggleAllLoaded(checked) {
  const next = new Set(selected.value);
  for (const row of allRowsFlat.value) {
    if (checked) next.add(row.key);
    else next.delete(row.key);
  }
  selected.value = next;
}

// ---- 下载设置弹层绑定：多来源清单用共享的一档，单来源用来源自己的 ----
const multiQuality = ref("auto");
const multiImage = ref("large");

const IMAGE_CHOICES = [
  { value: "large", label: "原图（最佳画质）" },
  { value: "thumbnail", label: "压缩图（体积小）" },
];

const dlQuality = computed({
  get: () => (useShared.value ? multiQuality.value : activeSource.value?.quality ?? "auto"),
  set: (value) => {
    if (useShared.value) multiQuality.value = value;
    else if (activeSource.value) activeSource.value.quality = value;
  },
});

const dlImage = computed({
  get: () => multiImage.value,
  set: (value) => {
    multiImage.value = value;
  },
});

const dlQualities = computed(() =>
  useShared.value
    ? allSources.value[0]?.probe.qualities ?? []
    : activeSource.value?.probe.qualities ?? []
);

// 多个来源时，共享档位默认取第一个来源的推荐值
watch(allSources, () => {
  const first = allSources.value[0];
  if (!first) return;
  multiQuality.value = pickDefaultQuality(first.probe, props.settings);
});

/** 按来源把行分组，用来在表里画出分界：哪几行属于哪个来源 */
/** 来源条数之和与实际行数之差 = 被判重掉的内容数 */
const totalItemCount = computed(() =>
  allSources.value.reduce(
    (sum, source) => sum + (source.probe.kind === "post" ? 1 : source.probe.items.length),
    0
  )
);
const dedupedCount = computed(() => totalItemCount.value - tableRows.value.length);

const tableGroups = computed(() => {
  const groups = [];
  for (const row of tableRows.value) {
    const last = groups[groups.length - 1];
    if (last && last.source === row.source) last.rows.push(row);
    else groups.push({ source: row.source, rows: [row] });
  }
  // 内容被前面的来源覆盖完的来源不再显示分组行
  return groups.filter((group) => group.rows.length > 0);
});

/** 折叠的分组（按来源输入记）：点分组行收起/展开该来源的行 */
const collapsed = ref(new Set());

function isCollapsed(input) {
  return collapsed.value.has(input);
}

/** 分组勾选：全选只覆盖这一组，不影响别的来源 */
function groupChecked(group) {
  return group.rows.length > 0 && group.rows.every((row) => isSelected(row));
}

function groupPartial(group) {
  const picked = group.rows.filter((row) => isSelected(row)).length;
  return picked > 0 && picked < group.rows.length;
}

function toggleGroupSelect(group, checked) {
  const next = new Set(selected.value);
  for (const row of group.rows) {
    if (checked) next.add(row.key);
    else next.delete(row.key);
  }
  selected.value = next;
}

function toggleGroup(input) {
  const next = new Set(collapsed.value);
  if (next.has(input)) next.delete(input);
  else next.add(input);
  collapsed.value = next;
  // 展开时该组行级联亮起（收官动效；折叠瞬时收起）
  if (!collapsed.value.has(input) && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    nextTick(() =>
      requestAnimationFrame(() => {
        const rows = [...document.querySelectorAll(`tr[data-group="${CSS.escape(input)}"]`)].slice(0, 14);
        if (rows.length) animate(rows, { opacity: [0, 1], translateY: [6, 0], duration: 300, delay: stagger(22), ease: "outQuad" });
      }),
    );
  }
}

/** 只有一个来源时不必分组（表头已经写了它是谁） */
const showGroups = computed(() => allSources.value.length > 1);

/** 有内容可列就出表（单条作品也是表里的一行） */
const hasTable = computed(() => tableRows.value.length > 0);

function openSelect(input) {
  batchInput.value = input;
  view.value = "select";
}

/** 条目在来源内的唯一标识：用作品 bid */
function entryKey(probe, entry) {
  return `${probe.kind}:${entry.bid}`;
}

const useShared = computed(() => allSources.value.length > 1);

/**
 * 所有来源都摊成同一张表：批量清单出每条内容，单条作品出它自己这一行。
 * 多个来源混着贴也是同一张表，不再按来源切来切去。
 *
 * `seq` 是它在表里的序号（给人看），`abs` 是它在来源里的真实序号（给序号列与命名模板的
 * {index} 用）。抖音单条无时间线翻页，保留编号机制，编号取"最新 = 1、越旧越大"——
 * 列表只会在末尾追加更旧的内容，已加载条目的编号冻结、不会漂移；
 * 预览与下载用同一个值，不会一个号一个样。
 */
const tableRows = computed(() => {
  const rows = [];
  // 内容级判重：同一条内容可能被多个来源覆盖（主页与它的单条链接），只保留先出现的
  const seenItems = new Set();
  for (const source of allSources.value) {
    if (source.probe.kind === "post") {
      const ck = `item:${source.probe.bid}`;
      if (seenItems.has(ck)) continue;
      seenItems.add(ck);
      rows.push({
        key: source.input,
        seq: rows.length + 1,
        abs: 1,
        title: source.probe.title,
        owner: source.probe.author,
        entry: source.probe.items?.[0] ?? null,
        source,
      });
      continue;
    }
    source.probe.items.forEach((entry, position) => {
      const ck = `item:${entry.bid}`;
      if (seenItems.has(ck)) return;
      seenItems.add(ck);
      rows.push({
        key: entryKey(source.probe, entry),
        seq: rows.length + 1,
        // 序号由旧到新递增（最旧 = 1）：时间线按最新在前加载，已知总数时
        // 用 总数-位置 换算（稳定不漂移）；拿不到总数时退回加载序
        abs: source.probe.total > 0
          ? Math.max(source.probe.total - position, 1)
          : position + 1,
        title: entry.title,
        owner: entry.author || source.probe.author,
        entry,
        source,
      });
    });
  }
  return rows;
});

/** 行悬停时显示该行将落盘的文件名：由后端用与下载同一个渲染器算出 */
const fileNames = ref([]);
let nameSeq = 0;

function rowExt(row) {
  if (row.entry?.has_video) return "mp4";
  if ((row.entry?.pics ?? 0) > 0) return "jpg";
  return "txt";
}

async function refreshNames() {
  const rows = tableRows.value;
  const seq = ++nameSeq;
  if (!rows.length) {
    fileNames.value = [];
    return;
  }
  // 分组取每种类型的代表行即可（同名序号不同）；mock 下逐行取也很快
  try {
    const names = await Promise.all(
      rows.map((row) =>
        api.previewNaming(
          props.settings?.naming_template || "{title}.{ext}",
          {
            date: undefined,
            ext: rowExt(row),
            sample: {
              title: row.title,
              author: row.owner,
              bid: row.entry?.bid ?? row.source.probe.bid ?? "",
              index: row.abs,
              source_kind: row.source.probe.mix ? "合集" : (KIND_LABELS[row.source.probe.kind] ?? "抖音"),
            },
          }
        )
      )
    );
    if (seq === nameSeq) fileNames.value = names;
  } catch {
    if (seq === nameSeq) fileNames.value = [];
  }
}

watch(
  () => [tableRows.value.length, props.settings?.naming_template],
  refreshNames,
  { immediate: true }
);

/** 把给定行逐个入队 */
async function startRows(rows) {
  if (!rows.length) return 0;
  let started = 0;
  for (const row of rows) {
    try {
      const probe = row.source.probe;
      const single = probe.kind === "post";
      await api.startDownload({
        bid: row.entry?.bid ?? probe.bid,
        mid: row.entry?.mid ?? probe.mid,
        source: probe.kind,
        title: row.title,
        author: row.owner || probe.author,
        uid: probe.uid,
        quality: useShared.value ? multiQuality.value : row.source.quality ?? "auto",
        image: multiImage.value,
        audio_quality: props.settings?.audio_quality || "best",
        is_audio: !!row.entry?.is_audio,
        media_url: row.entry?.media_url || "",
        page_url: row.source.input,
        image_count: single ? (row.entry?.pics ?? 0) : row.entry?.pics ?? 0,
        video_count: row.entry?.has_video ? 1 : 0,
        quality_label: row.entry
          ? row.entry.is_audio
            ? "音频"
            : row.entry.has_video
            ? "视频"
            : row.entry.pics > 0
              ? `${row.entry.pics} 图`
              : "文字"
          : "作品",
        naming: single ? singleNaming(probe) : batchNaming(probe, row.entry, row.abs),
      });
      started += 1;
    } catch (error) {
      emit("toast", `${row.title}: ${error}`);
    }
  }
  if (started) {
    emit("toast", `已加入 ${started} 个下载任务`);
    emit("goto", "transfer");
  }
  return started;
}

/** 「加载全部」：弹出可见浏览器窗口让用户滚动到底部加载全部作品，
    完成后回传数据并刷新当前来源的列表。 */
const loadingAllViaWindow = ref(false);

async function loadAllViaWindow() {
  if (loadingAllViaWindow.value || !activeSource.value) return;
  loadingAllViaWindow.value = true;
  emit("toast", "已弹出窗口：正在自动加载全部作品（也可滚动辅助），完成后点窗口底部「完成加载」");
  try {
    const secUid = activeSource.value.probe.uid || activeSource.value.probe.bid;
    const res = await api.profileLoadAll(secUid);
    if (res.error) throw new Error(res.error);
    if (res.items && res.items.length) {
      const probe = activeSource.value.probe;
      const existing = new Set(probe.items.map((e) => e.bid));
      let fresh = 0;
      for (const entry of res.items) {
        if (existing.has(entry.bid)) continue;
        existing.add(entry.bid);
        probe.items.push(entry);
        fresh += 1;
      }
      probe.total = probe.items.length;
      probe.loaded = probe.items.length;
      const failed = res.failed || 0;
      emit(
        "toast",
        failed
          ? `加载完成：新增 ${fresh} 条（${failed} 条解析失败，可能已删除/私密），共 ${probe.items.length} 条`
          : `加载完成：新增 ${fresh} 条，共 ${probe.items.length} 条`
      );
    } else {
      emit("toast", "未加载到新作品");
    }
  } catch (error) {
    emit("toast", String(error.message || error));
  } finally {
    loadingAllViaWindow.value = false;
  }
}

/** ---- 合集解析 ----
    合集 tab 链接（?showSubTab=compilation）解析出的是合聚集（名称/集数/封面）。
    点某个合集的「加载视频」后，视频表就挂在它自己卡片下面（可折叠），不跳来源页。 */
const activeIsMixList = computed(() => activeSource.value?.probe.kind === "mix-list");
const loadingMix = ref(""); // 正在加载的 mix_id（按钮转圈）
const expandingAll = ref(false); // 展开全部进行中（再点按钮 = 取消）
const expandCancel = ref(false);
const expandProgress = ref({ done: 0, total: 0 });
const openMixes = ref(new Set()); // 已展开（显示视频表）的合集 id

function isMixOpen(mixId) {
  return openMixes.value.has(String(mixId));
}

function toggleMixOpen(mixId) {
  const next = new Set(openMixes.value);
  const key = String(mixId);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  openMixes.value = next;
}

/** 播放量格式化：5650.7万 / 1.2亿 */
function formatPlay(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return `${(v / 100000000).toFixed(1)}亿`;
  if (v >= 10000) return `${(v / 10000).toFixed(1)}万`;
  return String(v);
}

/** 某个合集已加载的视频 → 表格行（结构与全局表一致，勾选/下载直接复用）。
    按 probe 引用缓存：大合集（数百集）每次渲染重建数组会很卡；
    重新加载会整体替换 m.probe，缓存自动失效。 */
const mixRowsCache = new WeakMap();
function mixRows(m) {
  if (!m || !m.probe || !Array.isArray(m.probe.items)) return [];
  let rows = mixRowsCache.get(m.probe);
  if (!rows) {
    const probe = m.probe;
    rows = probe.items.map((entry, position) => ({
      key: `mix:${m.mix_id}:${entry.bid}`,
      seq: position + 1,
      abs: position + 1, /* 合集按集数顺序：第 1 集 = 1（命名模板的 {index} 也用这个） */
      title: entry.title,
      owner: entry.author || probe.author,
      entry,
      source: { input: `mix_${m.mix_id}`, probe },
    }));
    mixRowsCache.set(probe, rows);
  }
  return rows;
}

/** 加载单个合集的全部视频：弹出窗口自动滚动加载，完成后点窗口底部「完成加载」，
    视频表挂在该合集下并展开 */
async function loadMix(m) {
  if (!m || loadingMix.value || expandingAll.value) return;
  loadingMix.value = m.mix_id;
  emit(
    "toast",
    `已弹出窗口：正在自动加载「${m.name}」的全部视频（也可滚动辅助），完成后点窗口底部「完成加载」`
  );
  try {
    const probe = await api.mixItems(m.mix_id, m.name);
    m.probe = probe;
    const next = new Set(openMixes.value);
    next.add(String(m.mix_id));
    openMixes.value = next;
    emit("toast", `${m.name}：已加载 ${probe.items.length} 集，可勾选下载`);
  } catch (error) {
    emit("toast", String(error.message || error));
  } finally {
    loadingMix.value = "";
  }
}

/** 展开全部合集：串行加载（每个合集弹一个窗口，自动滚动加载，完成后点窗口底部
    「完成加载」；打完自动弹下一个）→ 视频各自挂到自己的合集下（保持折叠）。
    展开中再点按钮 = 取消（当前合集处理完即停止）。 */
async function expandAllMixes() {
  if (expandingAll.value) {
    expandCancel.value = true;
    emit("toast", "已请求取消，等当前合集处理完即停止");
    return;
  }
  const src = activeSource.value;
  if (!src || src.probe.kind !== "mix-list") return;
  const mixes = src.probe.mixes || [];
  if (!mixes.length) return;
  expandingAll.value = true;
  expandCancel.value = false;
  expandProgress.value = { done: 0, total: mixes.length };
  let ok = 0;
  let skipped = 0;
  let totalEpisodes = 0;
  for (let i = 0; i < mixes.length; i++) {
    if (expandCancel.value) break;
    const m = mixes[i];
    emit(
      "toast",
      `第 ${i + 1}/${mixes.length} 个合集：${m.name}（窗口会自动滚动加载，完成后点窗口底部「完成加载」）`
    );
    try {
      const probe = await api.mixItems(m.mix_id, m.name);
      m.probe = probe;
      ok += 1;
      totalEpisodes += probe.items.length;
    } catch {
      skipped += 1;
    }
    expandProgress.value = { done: i + 1, total: mixes.length };
  }
  const cancelled = expandCancel.value;
  expandingAll.value = false;
  expandCancel.value = false;
  emit(
    "toast",
    `${cancelled ? "已取消，" : ""}合集加载完成：${ok} 个合集共 ${totalEpisodes} 集${skipped ? `，${skipped} 个失败` : ""}。点合集卡片可展开查看`
  );
}

/** 该合集的行是否全选 */
function mixAllSelected(m) {
  const rows = mixRows(m);
  return rows.length > 0 && rows.every((row) => isSelected(row));
}

/** 全选/取消该合集的全部行 */
function toggleMixAll(m, checked) {
  const next = new Set(selected.value);
  for (const row of mixRows(m)) {
    if (checked) next.add(row.key);
    else next.delete(row.key);
  }
  selected.value = next;
}

/** 一键下载整个合集（全部行入队） */
async function downloadMix(m) {
  const rows = mixRows(m);
  if (!rows.length) return;
  await startRows(rows);
}

/** 当前视图内所有可勾选的行（合集视图额外摊平各合集已加载的视频） */
const allRowsFlat = computed(() => {
  const rows = [...tableRows.value];
  if (activeIsMixList.value) {
    for (const m of activeSource.value?.probe.mixes || []) {
      rows.push(...mixRows(m));
    }
  }
  return rows;
});

/** 「重命名已下载」两段式：第一下预演只报数不动盘，按钮变「确认改名」，
    第二下才真正按当前命名模板改已下载文件的编号与标题（不动目录层级）。
    只在批量来源显示，且跟着当前激活的来源走（切来源自动解除武装）。 */
const renameArmed = ref(false);
let renameTimer = 0;

watch(activeSource, () => {
  renameArmed.value = false;
  clearTimeout(renameTimer);
});

async function renameDownloaded() {
  if (!activeIsBatch.value || !hasTable.value) return;
  const items = tableRows.value.map((row) => ({
    bid: row.entry?.bid ?? row.source.probe.bid,
    naming: batchNaming(row.source.probe, row.entry ?? {}, row.abs),
  }));
  if (!items.length) return;
  try {
    const res = await api.renameDownloaded(
      items,
      props.settings?.naming_template,
      renameArmed.value
    );
    const { renamed, skipped, notFound } = res;
    if (!renameArmed.value) {
      emit("toast", `预演完成：将改名 ${renamed} 项，跳过 ${skipped} 项，找不到 ${notFound} 项`);
      renameArmed.value = true;
      clearTimeout(renameTimer);
      renameTimer = setTimeout(() => (renameArmed.value = false), 8000);
    } else {
      emit("toast", `已改名 ${renamed} 项，跳过 ${skipped} 项，找不到 ${notFound} 项`);
      renameArmed.value = false;
      clearTimeout(renameTimer);
    }
  } catch (error) {
    emit("toast", String(error.message || error));
  }
}
/** 下载：清单里勾选的行；合集视图下也包含各合集已加载的视频行 */
async function downloadSelected() {
  if (!allRowsFlat.value.length) return;
  const picked = allRowsFlat.value.filter((row) => isSelected(row));
  if (!picked.length) {
    emit("toast", "先勾选要下载的内容");
    return;
  }
  await startRows(picked);
}

/** 下载全部：不看勾选，把已加载的行全部入队（没拉完会提示先解析完） */
async function downloadAll() {
  if (!hasTable.value) return;
  if (activeIsBatch.value && !activeSource.value.probe.exhausted) {
    emit("toast", "还有未加载的内容，先点「解析全部」再下载全部");
    return;
  }
  await startRows([...tableRows.value]);
}

// 「下载设置」弹层（清晰度/图片规格）
const pickingDl = ref(false);
const dlPanel = ref(null);

function onDlDocumentDown(event) {
  if (pickingDl.value && dlPanel.value && !dlPanel.value.contains(event.target)) {
    pickingDl.value = false;
  }
}

function onDlKeydown(event) {
  if (event.key === "Escape") {
    pickingDl.value = false;
  }
}

onMounted(() => {
  document.addEventListener("mousedown", onDlDocumentDown);
  document.addEventListener("keydown", onDlKeydown);
});

onUnmounted(() => {
  document.removeEventListener("mousedown", onDlDocumentDown);
  document.removeEventListener("keydown", onDlKeydown);
});

/** 步骤条点击跳转 */
function gotoStep(target) {
  if (target === "input") {
    view.value = "input";
    return;
  }
  if (target === "select" && okItems.value.length) {
    openSelect(batchInput.value || okItems.value[0].input);
  }
}

/** 清空全部解析结果 */
function resetParsed() {
  items.value = [];
  parseSkipped.value = [];
  selected.value = new Set();
  text.value = "";
  view.value = "input";
}

function removeItem(input) {
  const index = items.value.findIndex((item) => item.input === input);
  if (index >= 0) items.value.splice(index, 1);
}

/** 来源类型的中文标签（复用 download-request 那份） */
function kindLabel(kind) {
  return KIND_LABELS[kind] || kind;
}
</script>

<template>
  <div class="parse-page" :class="{ 'fill-height': isSelectView }">
    <StepHeader :steps="steps" @select="gotoStep" />

    <!-- 选择内容：解析后的独立一页 -->
    <section v-if="view === 'select' && activeSource" class="card select-page">
      <header class="select-bar">
        <button class="back" title="返回解析" @click="view = 'input'">
          <Icon name="chevronLeft" />
        </button>
        <h2 class="select-title" :title="headerTitle">{{ headerTitle }}</h2>
        <span v-if="headerTag" class="kind-tag">{{ headerTag }}</span>

        <!-- 计数与动作成组右对齐：窄窗口整体换行后仍然贴右（标签则留在左） -->
        <div class="bar-right">
        <template v-if="useShared">
          <span class="loaded-hint num">共 {{ loadedCount }} 条</span>
        </template>
        <template v-else-if="activeIsMixList">
          <span class="loaded-hint num">共 {{ (activeSource.probe.mixes || []).length }} 个合集</span>

          <!-- 展开全部合集：逐个弹窗滚动加载每个合集的视频，最后合成一个来源 -->
          <button
            class="ghost"
            :class="{ on: expandingAll }"
            :title="
              expandingAll
                ? '再点一次取消（当前合集处理完即停止）'
                : '逐个加载全部合集的视频（每个合集都要在弹出窗口里滚动到底）'
            "
            @click="expandAllMixes"
          >
            {{ expandingAll ? `取消展开（${expandProgress.done}/${expandProgress.total}）` : "展开全部合集" }}
          </button>
        </template>
        <template v-else-if="activeIsBatch">
          <span class="loaded-hint num">{{ loadedHint }}</span>

          <!-- 加载全部（用户主页）：弹可见窗口让用户滚动加载，回传全部作品。
               合集来源（probe.mix）不显示：合集已整段加载，uid 也不是 secUid -->
          <button
            v-if="!activeSource.probe.mix"
            class="ghost"
            :disabled="loadingAllViaWindow"
            :title="'弹出窗口自动加载全部作品（窗口里也可滚动辅助）'"
            @click="loadAllViaWindow"
          >
            {{ loadingAllViaWindow ? "窗口加载中…" : "加载全部" }}
          </button>
        </template>

        <!-- 拉完才给"下载全部"：否则点下去只下载了已加载的那一部分 -->
        <button
          v-if="hasTable && (!activeIsBatch || activeSource.probe.exhausted)"
          class="ghost"
          @click="downloadAll"
        >
          下载全部
        </button>

        <!-- 重命名已下载：只在批量来源（个人主页等）出现，单条作品与合集列表不显示。
             两段式防误触：第一下预演只报数，第二下才真正改盘。 -->
        <button
          v-if="activeIsBatch && !activeIsMixList"
          class="ghost"
          :class="{ on: renameArmed }"
          :title="
            renameArmed
              ? '再次点击执行改名'
              : '按当前命名规则改已下载条目的编号与标题（不动目录层级）'
          "
          @click="renameDownloaded"
        >
          <Icon name="fileText" />
          {{ renameArmed ? "确认改名" : "重命名已下载" }}
        </button>

        <!-- 清晰度/图片规格收进弹层，工具条只留动作 -->
        <div ref="dlPanel" class="dl-settings">
          <button class="ghost" :class="{ on: pickingDl }" @click="pickingDl = !pickingDl">
            <Icon name="slidersH" />
            下载设置
          </button>

          <Transition name="picker">
            <div v-if="pickingDl" class="dl-pop pop-in">
              <label class="pop-field">
                <span>视频清晰度</span>
                <select v-model="dlQuality">
                  <option
                    v-for="quality in dlQualities"
                    :key="quality.value"
                    :value="quality.value"
                    :disabled="!quality.available"
                  >
                    {{ quality.label }}{{ quality.hint ? `（${quality.hint}）` : "" }}
                  </option>
                </select>
              </label>
              <label class="pop-field">
                <span>图片规格</span>
                <select v-model="dlImage">
                  <option v-for="image in IMAGE_CHOICES" :key="image.value" :value="image.value">
                    {{ image.label }}
                  </option>
                </select>
              </label>
              <p class="pop-note">
                只对本次下载生效；视频清晰度不可用时自动取最佳可用档。
              </p>
            </div>
          </Transition>
        </div>

        <button
          class="primary"
          :disabled="(hasTable || activeIsMixList) && !selectedCount"
          @click="downloadSelected"
        >
          {{ hasTable || activeIsMixList ? `下载所选 (${selectedCount})` : "加入下载" }}
        </button>
        </div>
      </header>

      <p v-if="activeSource.probe.note" class="note">{{ activeSource.probe.note }}</p>

      <!-- 合集列表：每个合集卡片下挂它自己的视频表（可折叠），点卡片头展开/收起 -->
      <div v-if="activeIsMixList" class="table-scroll">
        <div class="mix-list">
          <div
            v-for="m in activeSource.probe.mixes || []"
            :key="m.mix_id"
            class="mix-block"
            :class="{ open: isMixOpen(m.mix_id) }"
          >
            <div
              class="mix-card"
              :class="{ clickable: !!m.probe }"
              :title="m.probe ? (isMixOpen(m.mix_id) ? '收起视频列表' : '展开视频列表') : ''"
              @click="m.probe && toggleMixOpen(m.mix_id)"
            >
              <div class="mix-cover">
                <img
                  v-if="m.cover"
                  :src="m.cover"
                  alt=""
                  loading="lazy"
                  referrerpolicy="no-referrer"
                />
                <span v-else class="mix-cover-fallback">{{ (m.name || "合集").slice(0, 1) }}</span>
              </div>
              <div class="mix-info">
                <div class="mix-name" :title="m.desc || m.name">
                  <Icon
                    v-if="m.probe"
                    name="chevronRight"
                    class="mix-fold"
                    :class="{ open: isMixOpen(m.mix_id) }"
                  />
                  {{ m.name }}
                </div>
                <div class="mix-sub faint">
                  <span v-if="m.count">共 {{ m.count }} 集</span>
                  <span v-else>集数未知</span>
                  <span v-if="m.play"> · {{ formatPlay(m.play) }} 播放</span>
                  <span v-if="m.probe" class="mix-loaded">
                    · 已加载 {{ m.probe.items.length }} 集
                  </span>
                </div>
              </div>
              <button
                v-if="m.probe && m.probe.items.length"
                class="mini"
                :disabled="expandingAll"
                title="把该合集的视频全部加入下载队列"
                @click.stop="downloadMix(m)"
              >
                下载合集
              </button>
              <button
                class="mini"
                :disabled="!!loadingMix || expandingAll"
                :title="'弹出窗口自动加载这个合集的全部视频（窗口里也可滚动辅助）'"
                @click.stop="loadMix(m)"
              >
                {{ loadingMix === m.mix_id ? "窗口加载中…" : m.probe ? "重新加载" : "加载视频" }}
              </button>
            </div>

            <!-- 该合集的视频表（折叠区） -->
            <div v-if="m.probe && isMixOpen(m.mix_id)" class="mix-body">
              <table class="batch-table">
                <thead>
                  <tr>
                    <th class="col-check">
                      <input
                        type="checkbox"
                        :checked="mixAllSelected(m)"
                        title="全选该合集"
                        @change="toggleMixAll(m, $event.target.checked)"
                      />
                    </th>
                    <th class="col-idx">集数</th>
                    <th>标题</th>
                    <th class="col-type">类型</th>
                    <th class="col-time">发布时间</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in mixRows(m)"
                    :key="row.key"
                    :class="{ on: isSelected(row) }"
                    :title="row.title"
                  >
                    <td class="col-check">
                      <input
                        type="checkbox"
                        :checked="isSelected(row)"
                        @change="toggleEntry(row)"
                      />
                    </td>
                    <td class="col-idx num">{{ paddedSeq(row) }}</td>
                    <td class="col-title">{{ row.title }}</td>
                    <td class="col-type">{{ typeLabel(row.entry ?? {}) }}</td>
                    <td class="col-time num" :title="formatTime(row.entry?.created_at)">
                      {{ formatTime(row.entry?.created_at) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <div v-if="hasTable" class="table-scroll">
        <table class="batch-table">
          <thead>
            <tr>
              <th class="col-check">
                <input
                  type="checkbox"
                  :checked="allLoadedSelected"
                  title="全选已加载"
                  @change="toggleAllLoaded($event.target.checked)"
                />
              </th>
              <th class="col-idx">序号</th>
              <th>文案</th>
              <th class="col-type">类型</th>
              <th class="col-owner">博主</th>
              <th class="col-time">发布时间</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="group in tableGroups" :key="group.source.input">
              <tr
                v-if="showGroups"
                class="group-row"
                :class="{ folded: isCollapsed(group.source.input) }"
                :title="isCollapsed(group.source.input) ? '展开这个来源' : '收起这个来源'"
                @click="toggleGroup(group.source.input)"
              >
                <td colspan="6">
                  <input
                    type="checkbox"
                    class="group-check"
                    :checked="groupChecked(group)"
                    :indeterminate.prop="groupPartial(group)"
                    :title="`只选择「${group.source.probe.title}」`"
                    @click.stop
                    @change="toggleGroupSelect(group, $event.target.checked)"
                  />
                  <Icon name="chevronRight" class="fold-arrow" />
                  <span class="group-kind">{{ group.source.probe.mix ? "合集" : kindLabel(group.source.probe.kind) }}</span>
                  <span class="group-title" :title="group.source.probe.title">
                    {{ group.source.probe.title }}
                  </span>
                  <span class="num faint">{{ group.rows.length }} 条</span>
                </td>
              </tr>
              <tr
                v-for="row in group.rows"
                v-show="!isCollapsed(group.source.input)"
                :key="row.key"
                :data-group="group.source.input"
                :class="{ on: isSelected(row) }"
                :title="fileNameOf(row)"
              >
                <td class="col-check">
                  <input type="checkbox" :checked="isSelected(row)" @change="toggleEntry(row)" />
                </td>
                <td class="col-idx num">{{ paddedSeq(row) }}</td>
                <td class="col-title">{{ row.title }}</td>
                <td class="col-type">{{ typeLabel(row.entry ?? {}) }}</td>
                <td class="col-owner" :title="row.owner">{{ row.owner || "—" }}</td>
                <td class="col-time num" :title="formatTime(row.entry?.created_at)">
                  {{ formatTime(row.entry?.created_at) }}
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <!-- 底部统计只对批量清单有意义，单条作品不渲染这条空栏 -->
      <footer v-if="hasTable || activeIsMixList" class="select-foot">
        <span class="foot-count">已选 <b class="num">{{ selectedCount }}</b> 项</span>
        <span v-if="!activeIsMixList" class="foot-count">共 <b class="num">{{ loadedCount }}</b> 项</span>
        <span v-if="!activeIsMixList && dedupedCount > 0" class="foot-count faint">
          （已去重 <b class="num">{{ dedupedCount }}</b> 条）
        </span>
        <span class="spacer"></span>
        <span v-if="!activeIsMixList" class="foot-hint faint">序号由旧到新递增（最旧为 1），加载更多不会改变已有序号</span>
        <button class="mini" @click="toggleAllLoaded(true)">全选已加载</button>
      </footer>
    </section>

    <template v-else>

    <section class="card">
      <h1>解析链接</h1>
      <p class="lead">粘贴一条或多条抖音分享内容（单条直接回车也可），解析后再选择要下载的内容。</p>

      <textarea
        v-model="text"
        rows="7"
        spellcheck="false"
        placeholder="https://v.douyin.com/i2xJ4f6/&#10;https://www.douyin.com/jingxuan?modal_id=7692082786634632482&#10;https://www.douyin.com/user/MS4wLjABAAAAxxxxxxxx&#10;7.20 复制打开抖音，看看【作者】的作品 https://v.douyin.com/Ab2CdEf/"
        @keydown.ctrl.enter="parse"
        @keydown.meta.enter="parse"
      ></textarea>

      <p class="hint">
        每行一个来源；支持分享口令、网页版视频/图集链接（含 modal_id）、个人主页（批量解析最近作品）。
      </p>

      <div class="actions">
        <button class="ghost" @click="pasteFromClipboard">
          <Icon name="clipboard" />
          粘贴链接
        </button>
        <span class="spacer"></span>
        <span class="kbd">Ctrl + Enter</span>
        <span class="magnet" ref="magnetWrap" @pointermove="magnetMove" @pointerleave="magnetLeave">
          <button class="primary" :data-parsing="parsing ? '' : undefined" :disabled="parsing || !text.trim()" @click="parse">
            {{ parsing ? `解析中 ${done}/${total}` : "开始解析" }}
          </button>
        </span>
      </div>

      <div class="sources">
        <span class="sources-label">支持来源</span>
        <span v-for="source in sources" :key="source.label" class="source">
          <Icon :name="source.icon" />
          {{ source.label }}
        </span>
      </div>
    </section>

    <!-- 解析结果入口：成功的一律进「选择内容」页，这里只留入口与失败项 -->
    <section v-if="items.length" class="card results page-in">
      <header class="results-head">
        <h2>解析结果</h2>
        <span class="count num">{{ okItems.length }}</span>
        <span class="spacer"></span>
        <button class="ghost" @click="resetParsed">清空</button>
      </header>

      <div v-if="okItems.length" class="parsed-bar">
        <button
          v-for="item in okItems"
          :key="item.input"
          class="parsed-chip"
          :title="item.probe.title || item.input"
          @click="openSelect(item.input)"
        >
          <span class="kind">{{ KIND_LABELS[item.probe.kind] }}</span>
          <span class="chip-title">{{ item.probe.title || item.input }}</span>
          <span class="num faint">{{ sourceCount(item) }}</span>
        </button>
      </div>

      <div v-if="parseSkipped.length || dedupedCount > 0" class="skipped-box">
        <p class="skipped-head">
          去重结果
          <span class="num faint">
            {{ parseSkipped.length ? `跳过 ${parseSkipped.length} 个重复来源` : "" }}
            {{ parseSkipped.length && dedupedCount ? " · " : "" }}
            {{ dedupedCount ? `合并 ${dedupedCount} 条重复内容` : "" }}
          </span>
          <span v-if="parseSkipped.length > 5" class="skipped-more faint">（列表内可滚动）</span>
        </p>
        <ul class="skipped-list">
          <li v-for="(item, index) in parseSkipped" :key="`${item.input}-${index}`">
            <span class="skipped-input" :title="item.input">{{ item.input }}</span>
            <span class="skipped-reason">{{ item.reason }}</span>
          </li>
          <li v-if="dedupedCount > 0" class="skipped-merged">
            <span class="skipped-reason">
              另有 {{ dedupedCount }} 条内容与已有来源重复，已合并（不重复下载）
            </span>
          </li>
        </ul>
      </div>

      <ul v-if="failedItems.length" class="list">
        <li v-for="item in failedItems" :key="item.input" class="item failed">
          <div class="meta">
            <p class="title">{{ item.input }}</p>
            <p class="error">{{ item.error }}</p>
          </div>
          <button class="remove" title="移除" @click="removeItem(item.input)">✕</button>
        </li>
      </ul>

      <p v-if="!login.logged_in && okItems.length" class="login-tip">
        不登录也能下载公开作品，视频为无水印原档；登录后解析更稳定。
      </p>
    </section>
    </template>
  </div>
</template>

<style scoped>
.card {
  padding: 20px 22px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
}

h1 {
  margin: 0;
  font-size: 25px;
  font-weight: 700;
  letter-spacing: -0.2px;
}

.lead {
  margin: 7px 0 0;
  font-size: 13px;
  color: var(--muted);
}

/* 勾选框不算"输入框"：这条规则里的 width:100% 会把它拉成整行宽 */
textarea,
input:not([type="checkbox"]) {
  width: 100%;
  padding: 12px 14px;
  color: var(--text);
  background: var(--field);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  resize: vertical;
  line-height: 1.7;
  transition: border-color 0.15s ease;
}

textarea::placeholder,
input::placeholder {
  color: var(--faint);
}

textarea:focus,
input:focus {
  outline: none;
  border-color: var(--accent-line);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.hint {
  margin: 9px 0 0;
  font-size: 12px;
  color: var(--faint);
}

.magnet {
  display: inline-flex;
  transition: transform var(--motion) var(--ease-out);
}

.actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
}

.spacer {
  flex: 1;
}

.kbd {
  font-size: 11.5px;
  color: var(--faint);
}

.primary {
  padding: 9px 22px;
  font-weight: 600;
  color: #fff;
  background: var(--accent);
  border-radius: var(--radius-sm);
  transition: background 0.15s ease;
}

.primary:hover:not(:disabled) {
  background: var(--accent-dark);
}

.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ghost {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 14px;
  font-size: 12.5px;
  color: var(--text);
  background: var(--field);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}

.ghost:hover {
  border-color: var(--accent-line);
  background: var(--raised);
}

.ghost svg {
  width: 18px;
  height: 18px;
  color: var(--muted);
}

.sources {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  margin-top: 14px;
  padding-top: 13px;
  border-top: 1px solid var(--line-soft);
  font-size: 12px;
  color: var(--muted);
}

.sources-label {
  font-weight: 600;
  color: var(--text);
}

.source {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.source svg {
  flex: none;
  width: 17px;
  height: 17px;
  color: var(--accent);
}

/* 解析结果里的去重明细 */
.skipped-box {
  margin-top: 12px;
  padding: 10px 12px;
  background: var(--raised);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
}

.skipped-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
}

/* 明细不撑高整页：超过几行就在框内滚，整页该滚动的距离不受它影响 */
.skipped-list {
  margin: 7px 0 0;
  padding: 0;
  list-style: none;
  max-height: 108px;
  overflow-y: auto;
}

.skipped-list li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 0;
  font-size: 12px;
  color: var(--muted);
}

.skipped-input {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 58%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  color: var(--text);
}

.skipped-reason {
  flex: 1;
  min-width: 0;
  color: var(--faint);
  overflow-wrap: anywhere;
}

/* 输入页里的"已解析来源"入口 */
.parsed-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 0;
}

.parsed-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  padding: 7px 12px;
  font-size: 12.5px;
  color: var(--text);
  background: var(--field);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}

.parsed-chip:hover {
  border-color: var(--accent-line);
  background: var(--raised);
}

.parsed-chip .chip-title {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 「下载设置」弹层：清晰度/图片规格，工具条只留动作按钮 */
.dl-settings {
  position: relative;
  flex: none;
}

.dl-settings .ghost {
  gap: 7px;
  padding: 6px 11px;
  font-size: 12.5px;
}

.dl-settings .ghost svg {
  width: 18px;
  height: 18px;
}

.dl-settings .ghost.on {
  color: var(--accent);
  border-color: var(--accent-line);
  background: var(--raised);
}

.dl-pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 50;
  width: min(300px, calc(100vw - 60px));
  padding: 12px;
  text-align: left;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: 0 16px 44px rgba(0, 0, 0, 0.5);
}

.pop-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.pop-field + .pop-field {
  margin-top: 10px;
}

.pop-field span {
  font-size: 11.5px;
  color: var(--faint);
}

.pop-field select {
  width: 100%;
  height: 30px;
  padding: 0 9px;
  font-size: 12.5px;
  color: var(--text);
  background: var(--field);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}

.pop-note {
  margin: 10px 0 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--faint);
}

/* 选择页占满可用高度：顶部工具条与底部统计不随滚动移动 */
.fill-height {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.fill-height .select-page {
  flex: 1;
  min-height: 0;
}

/* 输入页竖向占满窗口：两张卡分摊高度，卡片本身的空白也就被填满了 */
.parse-page:not(.fill-height) {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

/* 解析链接卡：高度按内容，**不参与拉伸**，多余高度全给结果卡。 */
.parse-page:not(.fill-height) > .card {
  display: flex;
  flex: 0 1 auto;
  flex-direction: column;
  min-height: 300px;
}

.parse-page:not(.fill-height) > .card textarea {
  flex: 1 1 auto;
  min-height: 110px;
  height: 110px;
}

/* 解析结果卡：高度**只由分配决定**（flex-basis: 0），不被明细列表的内容撑高。 */
.parse-page:not(.fill-height) > .results {
  flex: 1 1 0;
  min-height: 260px;
}

.parse-page:not(.fill-height) > .results .skipped-box {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
}

.parse-page:not(.fill-height) > .results .skipped-list {
  flex: 1 1 auto;
  /* 至少露出 3 行（每行 26px），不够就在框内滚 */
  min-height: 80px;
  max-height: none;
}

/* 选择内容页：解析结果独立成一页，表格 + 分批加载 */
.select-page {
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
}

.select-bar .ghost,
.select-bar .primary {
  flex: none;
  padding: 6px 13px;
  font-size: 12.5px;
  border-radius: var(--radius-sm);
}

.select-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line-soft);
  /* 独立层叠上下文：弹层（每批/解析方式/下载设置）必须整体压过后方的表格，
     否则深色主题下弹层与表格行几乎同色，会被当成"透明/错乱"（实测踩过） */
  position: relative;
  z-index: 30;
}

/* 计数与动作成组：整组靠右（margin-left:auto），窄到放不下时整组换行 */
.bar-right {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

/* 窄版"每批 N"：不带下拉箭头（原生 select 的箭头去不掉，所以自绘菜单） */







.back {
  display: grid;
  flex: none;
  place-items: center;
  width: 28px;
  height: 28px;
  color: var(--muted);
  border-radius: var(--radius-sm);
}

.back:hover {
  color: var(--text);
  background: var(--hover);
}

.back svg {
  width: 20px;
  height: 20px;
}

/* 标题按内容占宽，一行布局下标题可伸缩：超出部分省略号（悬停看全名） */
.select-title {
  flex: 0 1 auto;
  max-width: calc(100% - 460px);
  min-width: 28px;
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.kind-tag {
  flex: none;
  /* 和标题靠拢：整行 gap 是 10px，这里收掉 4px */
  margin-left: -4px;
  padding: 2px 8px;
  font-size: 11px;
  color: var(--accent);
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
  border-radius: 999px;
}

.loaded-hint {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}

.table-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

/* ---- 合集列表（合集 tab 解析出的合集卡片；视频表挂在卡片下可折叠） ---- */
.mix-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 2px 2px 8px;
}
.mix-block {
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  background: var(--card);
  transition: border-color 0.15s ease;
}
.mix-block:hover,
.mix-block.open {
  border-color: var(--accent, #25f4ee);
}
.mix-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 14px;
}
.mix-card.clickable {
  cursor: pointer;
}
.mix-cover {
  width: 72px;
  height: 96px;
  flex: none;
  border-radius: 8px;
  overflow: hidden;
  background: rgba(127, 127, 127, 0.12);
  display: flex;
  align-items: center;
  justify-content: center;
}
.mix-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.mix-cover-fallback {
  font-size: 26px;
  font-weight: 700;
  opacity: 0.4;
}
.mix-info {
  flex: 1;
  min-width: 0;
}
.mix-name {
  font-size: 14.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 4px;
}
.mix-fold {
  width: 14px;
  height: 14px;
  flex: none;
  opacity: 0.55;
  transition: transform 0.18s ease;
}
.mix-fold.open {
  transform: rotate(90deg);
}
.mix-sub {
  margin-top: 5px;
  font-size: 12.5px;
}
.mix-loaded {
  color: var(--accent, #25f4ee);
}
.mix-body {
  border-top: 1px solid var(--line-soft, var(--line));
  background: rgba(127, 127, 127, 0.03);
}
.mix-body .batch-table {
  margin: 0;
}

.batch-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 12.5px;
}

.batch-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 9px 10px;
  font-weight: 600;
  color: var(--muted);
  text-align: left;
  background: var(--card);
  border-bottom: 1px solid var(--line);
}

/* 分组行：多来源时用它把各组分开，一眼看出哪几行属于哪个来源 */
.batch-table tr.group-row {
  cursor: pointer;
  user-select: none;
}

/* 分组选择框：和行内的勾选框左对齐，别被折叠点击抢走事件 */
.group-check {
  margin-right: 8px;
  vertical-align: -3px;
}

.fold-arrow {
  width: 15px;
  height: 15px;
  margin-right: 4px;
  color: var(--faint);
  vertical-align: -2px;
  transform: rotate(90deg);
  transition: transform 0.15s ease;
}

.batch-table tr.group-row.folded .fold-arrow {
  transform: rotate(0deg);
}

.batch-table tr.group-row.folded .group-title {
  color: var(--muted);
}

.batch-table tr.group-row:hover .fold-arrow {
  color: var(--accent);
}

.batch-table tr.group-row td {
  padding: 7px 10px 6px;
  background: var(--raised);
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line-soft);
}

.batch-table tbody tr.group-row:first-child td {
  border-top: none;
}

.batch-table tr.group-row:hover td {
  background: var(--raised);
}

.group-kind {
  margin-right: 8px;
  padding: 1px 7px;
  font-size: 11px;
  color: var(--accent);
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
  border-radius: 999px;
}

.group-title {
  margin-right: 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}

.batch-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--line-soft);
}

.batch-table tbody tr:hover td {
  background: var(--raised);
}

.batch-table tr.on td {
  background: var(--accent-soft);
}

.col-check {
  width: 36px;
}

.col-idx {
  width: 58px;
  color: var(--faint);
}

.col-type {
  width: 64px;
  text-align: center;
  color: var(--muted);
}

/* 表头文字对齐要压过 .batch-table th 的 left */
.batch-table th.col-owner,
.batch-table td.col-owner {
  width: 130px;
  text-align: center;
}

.batch-table th.col-time,
.batch-table td.col-time {
  width: 96px;
  text-align: center;
  color: var(--muted);
}

.col-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.select-foot {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 11px 16px;
  border-top: 1px solid var(--line-soft);
}

.foot-count {
  font-size: 12.5px;
  color: var(--muted);
}

.foot-count b {
  color: var(--text);
  font-weight: 600;
}

.foot-hint {
  font-size: 11.5px;
}

/* 解析结果 */
.results {
  margin-top: 16px;
}

.results-head {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 8px;
}

h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
}

.count {
  font-size: 12px;
  color: var(--faint);
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  background: var(--raised);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
}

.item.failed {
  background: var(--fail-bg);
  border-color: var(--fail-line);
}

.meta {
  flex: 1;
  min-width: 0;
}

.title {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 勾选状态变化：整行底色过渡已有；序号与标题列给一次轻弹 */
.batch-table tbody tr.on td:first-child {
  animation: cell-pop 240ms var(--ease-out);
}

@keyframes cell-pop {
  0% { transform: scale(0.96); }
  60% { transform: scale(1.03); }
  100% { transform: none; }
}

.note {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 10px 0 2px;
  padding: 8px 12px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 9%, transparent);
  border: 1px solid color-mix(in srgb, var(--warn) 26%, transparent);
  border-radius: var(--radius-sm);
}

.note::before {
  content: "!";
  flex: none;
  width: 15px;
  height: 15px;
  align-self: center;
  display: grid;
  place-items: center;
  font-size: 10.5px;
  font-weight: 700;
  color: var(--warn);
  border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent);
  border-radius: 50%;
}

.error {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--err);
}

.remove {
  flex: none;
  width: 30px;
  height: 30px;
  font-size: 12px;
  color: var(--faint);
  border-radius: var(--radius-sm);
}

.remove:hover {
  color: var(--err);
  background: var(--fail-bg);
}

.login-tip {
  margin: 14px 0 0;
  padding: 9px 12px;
  font-size: 12px;
  color: var(--accent-dark);
  background: var(--accent-soft);
  border-radius: var(--radius-sm);
}

.mini {
  padding: 3px 10px;
  font-size: 11.5px;
  color: var(--muted);
  background: var(--field);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}

.mini:hover {
  color: var(--text);
  border-color: var(--accent-line);
}

/* 「每批 N」上的下拉箭头，以及「继续解析 + 解析方式」按钮 */

/* 下拉箭头：菜单打开时转 180°（过渡与旋转复合在同一属性上） */


/* 边框画在容器上、两个按钮透明无边框：箭头因此看起来是在按钮里面 */














</style>

<style scoped>
/* 第六轮追加：来源类型徽标出现时轻弹 */
.kind-tag {
  animation: tag-pop 280ms var(--ease-out-expo);
}

@keyframes tag-pop {
  0% { transform: scale(0.85); opacity: 0; }
  60% { transform: scale(1.06); opacity: 1; }
  100% { transform: none; opacity: 1; }
}
</style>


<style scoped>
/* 第七轮追加：表格行悬停左缘指示线。两个踩过的坑：
   1) 悬停行背景设在 td 上（tr:hover td），td 的不透明背景会盖住 tr 的
      inset shadow——线画在 tr 上只能露出边角。线必须挂在
      td:first-child 上才整行可见。
   2) 不给 box-shadow 挂过渡——快速划过多行时余晖叠成一排碎粉线。 */
.batch-table tbody tr:hover td:first-child {
  box-shadow: inset 2px 0 0 var(--accent);
}
</style>

<style scoped>
/* 第七轮追加：解析进行中主按钮扫光（reduced-motion 全局关） */
.primary[data-parsing] {
  position: relative;
  overflow: hidden;
}

.primary[data-parsing]::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(105deg, transparent 42%, rgba(255, 255, 255, 0.22) 50%, transparent 58%);
  animation: parse-shimmer 1.2s linear infinite;
}

@keyframes parse-shimmer {
  from { transform: translateX(-130%); }
  to { transform: translateX(130%); }
}
</style>
