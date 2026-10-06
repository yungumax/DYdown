<script setup>
// 登录对话框：与 WeBodown 同款结构。抖音采用"网页登录"——
// 主进程开一个抖音官方登录子窗口，用户扫码/验证码登录后自动收割 Cookie，
// 应用不接触密码；凭据只存本机（%APPDATA%/dydown/cookies.json）。
import Icon from "./Icon.vue";
import { onBeforeUnmount, onMounted, ref } from "vue";
import * as api from "../api";

const props = defineProps({
  login: { type: Object, required: true },
});
const emit = defineEmits(["close", "logout", "confirmed"]);

const opening = ref(false);
const hint = ref("");

async function openWebLogin() {
  if (opening.value) return;
  opening.value = true;
  hint.value = "已打开抖音登录窗口，扫码或验证码登录后会自动回到本应用";
  try {
    await api.webLoginOpen();
  } catch (error) {
    hint.value = String(error.message || error);
  } finally {
    opening.value = false;
  }
}

function onDocKeydown(event) {
  if (event.key === "Escape") emit("close");
}

onMounted(() => document.addEventListener("keydown", onDocKeydown));
onBeforeUnmount(() => document.removeEventListener("keydown", onDocKeydown));
</script>

<template>
  <div class="backdrop" @click.self="emit('close')">
    <div class="dialog pop-in">
      <div class="identity">
        <Icon name="login" class="mark" />
        <div>
          <h1>登录抖音账号</h1>
          <p class="sub">登录后凭据只存本机，应用不接触密码</p>
        </div>
        <button class="close" title="关闭" @click="emit('close')">
          <Icon name="close" />
        </button>
      </div>

      <ul class="points">
        <li>
          <Icon name="check" class="pt" />
          <span>官方登录窗口，扫码 / 手机验证码均可</span>
        </li>
        <li>
          <Icon name="check" class="pt" />
          <span>登录后个人主页解析与作品可用性更稳定</span>
        </li>
        <li>
          <Icon name="check" class="pt" />
          <span>不登录也能下载公开作品（免登录模式）</span>
        </li>
      </ul>

      <p v-if="hint" class="hint">{{ hint }}</p>

      <div class="actions">
        <button v-if="login.logged_in" class="ghost" @click="emit('logout')">
          退出登录
        </button>
        <button v-else class="primary" :disabled="opening" @click="openWebLogin">
          <Icon name="user" />
          打开登录窗口
        </button>
        <button class="ghost" @click="emit('close')">
          {{ login.logged_in ? "完成" : "暂不登录" }}
        </button>
      </div>

      <p class="state">
        当前状态：<b :class="login.logged_in ? 'ok' : 'bad'">
          {{ login.logged_in ? `已登录（${login.uname || "抖音用户"}）` : "未登录" }}
        </b>
      </p>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  background: var(--shade);
  z-index: 60;
}

.dialog {
  width: min(440px, calc(100vw - 60px));
  padding: 22px 24px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
}

.dialog > * {
  animation: empty-rise 380ms var(--ease-out) both;
}

.dialog > *:nth-child(2) {
  animation-delay: 70ms;
}

.dialog > *:nth-child(3) {
  animation-delay: 140ms;
}

.dialog > *:nth-child(4) {
  animation-delay: 210ms;
}

.identity {
  display: flex;
  align-items: center;
  gap: 13px;
}

.mark {
  width: 40px;
  height: 40px;
  color: var(--accent);
}

h1 {
  margin: 0;
  font-size: 19px;
  font-weight: 700;
  letter-spacing: -0.2px;
}

.sub {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--faint);
}

.close {
  margin-left: auto;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  color: var(--faint);
  border-radius: var(--radius-sm);
}

.close:hover {
  color: var(--text);
  background: var(--hover);
}

.close svg {
  width: 17px;
  height: 17px;
}

.points {
  list-style: none;
  margin: 16px 0 0;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--raised);
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
}

.points li {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 12.5px;
  color: var(--text);
}

.pt {
  flex: none;
  width: 16px;
  height: 16px;
  color: var(--ok);
}

.hint {
  margin: 12px 0 0;
  padding: 9px 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--accent-ink);
  background: var(--accent-soft);
  border-radius: var(--radius-sm);
}

.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 18px;
}

.actions button {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.primary {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 20px;
  font-weight: 600;
  color: #fff;
  background: var(--accent);
  border-radius: var(--radius-sm);
}

.primary:hover {
  background: var(--accent-dark);
}

.primary svg {
  width: 17px;
  height: 17px;
}

.ghost {
  padding: 8px 13px;
  font-size: 12.5px;
  color: var(--muted);
  background: var(--field);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}

.ghost:hover {
  color: var(--text);
  border-color: var(--accent-line);
  background: var(--raised);
}

.state {
  margin: 14px 0 0;
  font-size: 12px;
  color: var(--faint);
}

.state b.ok {
  color: var(--ok);
}

.state b.bad {
  color: var(--err);
}
</style>
