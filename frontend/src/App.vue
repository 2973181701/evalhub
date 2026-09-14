<script setup>
import { onMounted, ref, computed } from 'vue';
import { api } from './api.js';
import EvalBoard from './views/EvalBoard.vue';
import AnnotateView from './views/AnnotateView.vue';
import ReportView from './views/ReportView.vue';

const TABS = [
  { key: 'eval', label: '评测看板', comp: EvalBoard },
  { key: 'annotate', label: '标注界面', comp: AnnotateView },
  { key: 'report', label: '报告页', comp: ReportView },
];

const active = ref('eval');
const current = computed(() => TABS.find((t) => t.key === active.value).comp);
const health = ref(null);
const healthError = ref('');

/** 用 hash 做极简路由：三个页面可深链（#eval / #annotate / #report），刷新不丢当前页 */
function syncFromHash() {
  const key = (location.hash || '').replace('#', '');
  if (TABS.some((t) => t.key === key)) active.value = key;
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

onMounted(() => {
  syncFromHash();
  window.addEventListener('hashchange', syncFromHash);
  loadHealth();
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
      <span v-if="health" class="pill gray" :title="`Node ${health.node}`">引擎 {{ health.engine_version }}</span>
      <span v-if="health" class="pill" :class="health.glm.ready ? 'ok' : 'off'">
        <i class="dot"></i>{{ health.glm.ready ? `GLM ${health.glm.model} 已就绪` : 'GLM 密钥未配置' }}
      </span>
      <span v-if="healthError" class="pill off"><i class="dot"></i>后端未连接</span>
    </div>
  </header>

  <div v-if="healthError" class="page" style="padding-bottom: 0">
    <div class="alert bad">
      <strong>连不上后端。</strong>请先启动：<code>cd backend &amp;&amp; node server.js</code>（默认 3000 端口）。<br />
      <span class="muted">{{ healthError }}</span>
    </div>
  </div>

  <component :is="current" :health="health" />
</template>
