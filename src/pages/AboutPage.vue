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
          <dd>与 WeBodown 同一套设计体系（抖音黑主题 · 浅色/深色主题 · 全套动效）</dd>
        </div>
      </dl>

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
</style>
