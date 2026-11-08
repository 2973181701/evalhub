<template>
  <main class="page">
    <div class="page-head">
      <div>
        <h1>标注队列</h1>
        <p class="muted">逐条判断 A / B 哪个回答更好。界面不显示生成策略、参考答案与留出集分组，避免影响判断。</p>
      </div>
      <span v-if="stats" class="pill">已标 {{ stats.labeled }} / {{ stats.total }}</span>
    </div>

    <div v-if="error" class="alert bad">{{ error }}</div>

    <div v-if="loading" class="spinner">加载中…</div>

    <template v-else>
      <section v-if="!current" class="card">
        <div class="empty">队列已全部标注完成。导出留出集报告即可复算 Judge 一致性。</div>
      </section>

      <template v-else>
        <section class="card">
          <div class="card-head">
            <span class="card-title">{{ current.id }} · {{ current.task_type }}</span>
            <span class="card-note">剩余 {{ stats ? stats.pending : '—' }} 条</span>
          </div>
          <p class="prompt-text">{{ current.prompt }}</p>

          <div class="ab-grid">
            <div class="ab-card">
              <div class="ab-head"><span class="ab-tag">回答 A</span><span class="muted mono">{{ current.answer_a.length }} 字</span></div>
              <div class="ab-body">{{ current.answer_a }}</div>
            </div>
            <div class="ab-card">
              <div class="ab-head"><span class="ab-tag">回答 B</span><span class="muted mono">{{ current.answer_b.length }} 字</span></div>
              <div class="ab-body">{{ current.answer_b }}</div>
            </div>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><span class="card-title">你的判断</span></div>
          <div class="choice-row" style="margin-bottom: 14px">
            <button class="choice-btn" :class="{ active: choice === 'A' }" @click="choice = 'A'">A 更好</button>
            <button class="choice-btn" :class="{ active: choice === 'B' }" @click="choice = 'B'">B 更好</button>
            <button class="choice-btn" :class="{ active: choice === '平手' }" @click="choice = '平手'">平手</button>
          </div>

          <div class="conf-row" style="margin-bottom: 14px">
            <span class="muted">把握程度</span>
            <button v-for="n in 5" :key="n" class="conf-btn" :class="{ active: confidence === n }" @click="confidence = n">{{ n }}</button>
            <span class="muted">（5 = 很确定）</span>
          </div>

          <label class="field">
            <span>理由（可选，但对复核分歧很有用）</span>
            <textarea v-model="reason" rows="2" placeholder="例如：A 直接给出结论且符合题目要求的形态，B 超字数" />
          </label>

          <div class="btn-row" style="margin-top: 12px">
            <button class="btn primary" :disabled="!canWrite || !choice || busy" @click="submit">
              {{ busy ? '提交中…' : '提交并下一条' }}
            </button>
            <button class="btn" :disabled="busy" @click="skip">跳过这条</button>
            <span v-if="!canWrite" class="muted">{{ writeBlockReason }}</span>
            <span v-if="notice" class="muted">{{ notice }}</span>
          </div>
          <div v-if="localError" class="alert bad" style="margin-top: 10px">{{ localError }}</div>
        </section>
      </template>

      <section v-if="stats" class="card">
        <div class="card-head">
          <span class="card-title">队列进度</span>
          <button class="btn" @click="refresh">刷新</button>
        </div>
        <div class="stat-grid">
          <div class="stat"><div class="stat-label">总样本</div><div class="stat-value">{{ stats.total }}</div></div>
          <div class="stat"><div class="stat-label">已标注</div><div class="stat-value">{{ stats.labeled }}</div></div>
          <div class="stat"><div class="stat-label">真人标签</div><div class="stat-value">{{ stats.human_labels }}</div></div>
          <div class="stat"><div class="stat-label">留出集样本</div><div class="stat-value">{{ stats.test_pairs }}</div></div>
        </div>
        <div v-if="stats.fixture_labels" class="card-note" style="margin-top: 8px">
          含 {{ stats.fixture_labels }} 条测试夹具标注，评估脚本会排除，不计入 κ。
        </div>
      </section>
    </template>
  </main>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api.js';
import { canWrite, writeBlockReason } from '../authState.js';
import { friendlyError } from '../errors.js';

const rows = ref([]);
const index = ref(0);
const stats = ref(null);
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const localError = ref('');
const notice = ref('');
const choice = ref('');
const confidence = ref(null);
const reason = ref('');

const current = ref(null);

function pick() {
  current.value = rows.value[index.value] ?? null;
  choice.value = '';
  confidence.value = null;
  reason.value = '';
  localError.value = '';
  notice.value = '';
}

async function refresh() {
  loading.value = true;
  error.value = '';
  try {
    const [q, s] = await Promise.all([
      api.labelQueue({ limit: 100 }),
      api.labelQueueStats(),
    ]);
    rows.value = q.rows;
    stats.value = s;
    index.value = 0;
    pick();
  } catch (e) {
    error.value = friendlyError(e);
  } finally {
    loading.value = false;
  }
}

async function submit() {
  if (!current.value || !choice.value) return;
  busy.value = true;
  localError.value = '';
  try {
    await api.submitLabel(current.value.id, {
      choice: choice.value,
      confidence: confidence.value,
      reason: reason.value,
    });
    rows.value.splice(index.value, 1);
    if (stats.value) {
      stats.value.labeled += 1;
      stats.value.pending = Math.max(0, stats.value.pending - 1);
      stats.value.human_labels += 1;
    }
    if (index.value >= rows.value.length) index.value = 0;
    pick();
  } catch (e) {
    localError.value = friendlyError(e);
  } finally {
    busy.value = false;
  }
}

function skip() {
  if (index.value < rows.value.length - 1) index.value += 1;
  else index.value = 0;
  pick();
  notice.value = '已跳过，稍后还会出现';
}

onMounted(refresh);
</script>

<style scoped>
.prompt-text {
  margin: 4px 0 16px;
  font-size: 15px;
  line-height: 1.7;
}
</style>
