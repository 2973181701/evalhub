<script setup>
import { onMounted, ref, computed } from 'vue';
import { api, getToken, setToken } from './api.js';
import { authState, needLogin } from './authState.js';
import EvalBoard from './views/EvalBoard.vue';
import RunsView from './views/RunsView.vue';
import AnnotateView from './views/AnnotateView.vue';
import ReportView from './views/ReportView.vue';
import CompareView from './views/CompareView.vue';
import LabelQueueView from './views/LabelQueueView.vue';
import GovernanceView from './views/GovernanceView.vue';
import LoginView from './views/LoginView.vue';

const TABS = [
  { key: 'eval', label: '评测看板', comp: EvalBoard },
  { key: 'runs', label: '评测任务', comp: RunsView },
  { key: 'annotate', label: '标注界面', comp: AnnotateView },
  { key: 'compare', label: '模型对比', comp: CompareView },
  { key: 'labelqueue', label: '标注队列', comp: LabelQueueView },
  { key: 'governance', label: '数据治理', comp: GovernanceView },
  { key: 'report', label: '报告页', comp: ReportView },
];

const active = ref('eval');
const health = ref(null);
const healthError = ref('');

const current = computed(() => {
  if (active.value === 'login') return LoginView;
  return (TABS.find((t) => t.key === active.value) ?? TABS[0]).comp;
});

/** 用 hash 做极简路由：页面可深链，刷新不丢当前页 */
function syncFromHash() {
  const key = (location.hash || '').replace('#', '');
  if (key === 'login' || TABS.some((t) => t.key === key)) active.value = key;
}

function switchTab(key) {
  active.value = key;
  if (location.hash !== `#${key}`) location.hash = key;
}

async function loadHealth() {
  try {
    health.value = await api.health();
    healthError.value = '';
  } catch (e) {
    health.value = null;
    healthError.value = e.message;
  }
}

async function loadAuth() {
  try {
    const s = await api.authStatus();
    authState.enabled = s.enabled;
    authState.readProtected = s.read_protected;
  } catch {
    authState.enabled = false;
  }
  if (authState.enabled && getToken()) {
    try {
      authState.user = await api.me();
    } catch {
      authState.user = null;
      setToken('');
    }
  }
  authState.ready = true;
}

function onLoggedIn(u) {
  authState.user = u;
  switchTab('runs');
}

function logout() {
  setToken('');
  authState.user = null;
  switchTab('eval');
}

onMounted(() => {
  syncFromHash();
  window.addEventListener('hashchange', syncFromHash);
  // 令牌过期时 api 层会广播，这里统一切到登录页
  window.addEventListener('evalhub:unauthorized', () => {
    authState.user = null;
    if (authState.enabled) switchTab('login');
  });
  loadHealth();
  loadAuth();
});
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <span class="brand-name">EvalHub</span>
      <span class="brand-sub">LLM 评测与标注一体化平台</span>
    </div>

    <nav class="tabs">
      <button
        v-for="t in TABS"
        :key="t.key"
        class="tab"
        :class="{ active: active === t.key }"
        @click="switchTab(t.key)"
      >
        {{ t.label }}
      </button>
    </nav>

    <div class="topbar-right">
      <span v-if="health" class="pill gray" :title="`Node ${health.node}`">
        {{ health.storage?.mode === 'postgres' ? `PG v${health.storage.version}` : 'JSON 模式' }}
      </span>
      <span v-if="health" class="pill" :class="health.glm.ready ? 'ok' : 'off'">
        <i class="dot"></i>{{ health.glm.ready ? `GLM ${health.glm.model}` : 'GLM 未配置' }}
      </span>

      <template v-if="authState.ready && authState.enabled">
        <span v-if="authState.user" class="pill gray" :title="`角色 ${authState.user.role}`">
          {{ authState.user.email }}
        </span>
        <button v-if="authState.user" class="btn sm ghost" @click="logout">退出</button>
        <button v-else class="btn sm" @click="switchTab('login')">登录</button>
      </template>

      <span v-if="healthError" class="pill off"><i class="dot"></i>后端未连接</span>
    </div>
  </header>

  <div v-if="healthError" class="page" style="padding-bottom: 0">
    <div class="alert bad">
      <strong>连不上后端。</strong>请先启动：<code>cd backend &amp;&amp; node server.js</code>（默认 3000 端口）。<br />
      <span class="muted">{{ healthError }}</span>
    </div>
  </div>

  <div v-else-if="needLogin && active !== 'login'" class="page">
    <div class="alert">
      <strong>当前已开启鉴权。</strong>创建评测任务与提交标注需要登录（evaluator 及以上）。
      <button class="btn sm" style="margin-left: 10px" @click="switchTab('login')">去登录</button>
    </div>
  </div>

  <component :is="current" :health="health" @logged-in="onLoggedIn" />
</template>
