<script setup>
import Icon from "../components/Icon.vue";
defineProps({
  version: { type: String, default: "" },
});
</script>

<template>
  <div>
    <section class="card">
      <div class="identity">
        <Icon name="download" class="mark" />
        <div>
          <h1>DYdown</h1>
          <p class="ver num">v{{ version || "—" }}</p>
        </div>
      </div>

      <p class="desc">
        抖音无水印视频下载工具，支持单条视频与图集解析、多行批量下载，
        粘贴整段分享口令即可，本地直连抖音接口，不经过任何第三方服务。
      </p>

      <dl class="rows">
        <div class="row">
          <dt>技术栈</dt>
          <dd>Electron · Node.js · Vue 3</dd>
        </div>
        <div class="row">
          <dt>下载能力</dt>
          <dd>无水印视频 mp4 · 图集原图 · 背景音乐 mp3 · 文案 txt · 并发下载</dd>
        </div>
        <div class="row">
          <dt>内容来源</dt>
          <dd>抖音分享链接 · 整段分享口令（自动提取链接）</dd>
        </div>
        <div class="row">
          <dt>界面</dt>
          <dd>抖音黑主题 · 浅色 / 深色主题 · 全套动效</dd>
        </div>
      </dl>

      <div class="guide">
        <h2>使用说明</h2>
        <ol>
          <li>
            <b>下载单条视频 / 图集</b>
            <p>
              复制抖音的分享链接或整段分享口令，粘贴到「解析」输入框，点「开始解析」；
              在解析结果里勾选要下载的内容，点「下载所选」。
            </p>
          </li>
          <li>
            <b>批量下载某个博主</b>
            <p>
              粘贴用户主页链接解析后，点「加载全部」——弹出的窗口会自动加载全部作品
              （也可以用鼠标滚轮辅助），加载完点窗口底部「完成加载」回传，再全选或挑着下载。
            </p>
          </li>
          <li>
            <b>下载合集 / 系列</b>
            <p>
              粘贴主页「合集」标签页的链接（或从合集里点开视频后复制的链接），解析后会列出全部合集；
              点某个合集的「加载视频」拉取它的全部集数，或点「展开全部合集」逐个加载。
              视频列表就展开在合集卡片下方，可折叠、可整段「下载合集」。
            </p>
          </li>
          <li>
            <b>下载管理</b>
            <p>
              「传输」页查看进度，可暂停 / 继续单个任务，也可「全部暂停 / 全部开始」；
              中断的任务支持断点续传。
            </p>
          </li>
          <li>
            <b>登录（可选）</b>
            <p>
              点标题栏右上角「免登录」扫码登录。登录后主页与合集解析更稳定、清晰度档位更完整
              （登录默认 4K 优先，未登录默认 1080P 优先）。
            </p>
          </li>
          <li>
            <b>设置与更新</b>
            <p>
              「设置」页可修改保存目录、清晰度、命名规则等；「检查更新」检测到新版本后
              可在应用内一键下载并升级。
            </p>
          </li>
        </ol>
      </div>

      <p class="disclaimer">
        仅供个人学习与离线观看使用，请遵守抖音用户协议，不要用于传播或商业用途。
        内容版权归原作者所有。
      </p>
    </section>
  </div>
</template>

<style scoped>
.card {
  padding: 22px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
}

.identity {
  display: flex;
  align-items: center;
  gap: 13px;
}

.mark {
  width: 48px;
  height: 48px;
}

h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.2px;
}

.ver {
  margin: 2px 0 0;
  font-size: 12.5px;
  color: var(--faint);
}

.desc {
  margin: 16px 0 0;
  font-size: 13px;
  line-height: 1.75;
  color: var(--muted);
  max-width: 62ch;
}

.rows {
  margin: 18px 0 0;
}

.row {
  display: flex;
  gap: 16px;
  padding: 12px 0;
  border-top: 1px solid var(--line-soft);
}

dt {
  flex: none;
  width: 86px;
  font-size: 12.5px;
  color: var(--muted);
}

dd {
  margin: 0;
  font-size: 13px;
}

.disclaimer {
  margin: 18px 0 0;
  padding: 11px 13px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--muted);
  background: var(--raised);
  border-radius: var(--radius-sm);
}

/* 使用说明：编号步骤，一步一个小标题 + 一句话 */
.guide {
  margin-top: 20px;
  padding-top: 18px;
  border-top: 1px solid var(--line-soft);
}

.guide h2 {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 700;
}

.guide ol {
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.guide li {
  font-size: 13px;
  line-height: 1.65;
}

.guide li b {
  display: block;
  font-size: 13.5px;
  margin-bottom: 2px;
}

.guide li p {
  margin: 0;
  color: var(--faint);
}
</style>
