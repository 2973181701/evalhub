<script setup>
/**
 * 模型对比页：任选两次任务，给出「B 相对 A 到底好在哪」。
 *
 * 两条纪律（页面文案里也写着）：
 *   1. 只在两边都跑过的题上比较，题集不同不硬比。
 *   2. 数据集版本不同直接判不可比，不猜。
 * 差值方向固定 B - A，正数代表 B 更好；颜色不是唯一信号，箭头和数值同时给出。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api.js';
import { friendlyError } from '../errors.js';

const runs = ref([]);
const aId = ref('');
const bId = ref('');
const data = ref(null);
const loading = ref(false);
const error = ref('');

const DIM_CN = {
  accuracy: '准确性',
  completeness: '完整性',
  logic: '逻辑性',
  safety: '安全性',
  expression: '表达质量',
  constraint: '约束遵循',
};

const finishedRuns = computed(() => runs.value.filter((r) => r.status === 'succeeded' || r.status === 'failed'));

function label(r) {
  const t = new Date(r.created_at);
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  return `${r.id.slice(0, 8)} · ${r.provider}/${r.model} · ${r.total_items}条 · ${hh}:${mm}`;
}

function fmtDelta(v) {
  if (v === null || v === undefined) return '-';
  const n = Number(v);
  if (Math.abs(n) < 0.005) return '0.00';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}`;
}

function deltaClass(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) < 0.005) return 'muted';
  return n > 0 ? 'up' : 'down';
}

async function loadRuns() {
  try {
    const d = await api.listRuns(50);
    runs.value = d.runs;
    const ok = finishedRuns.value;
    if (!aId.value && ok.length >= 1) aId.value = ok[ok.length - 1].id; // 最早的一条作基准
    if (!bId.value && ok.length >= 2) bId.value = ok[0].id; // 最新的一条作对照
  } catch (e) {
    error.value = friendlyError(e);
  }
}

async function loadCompare() {
  if (!aId.value || !bId.value || aId.value === bId.value) {
    data.value = null;
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    data.value = await api.compareRuns(aId.value, bId.value);
  } catch (e) {
    error.value = friendlyError(e);
    data.value = null;
  } finally {
    loading.value = false;
  }
}

watch([aId, bId], loadCompare);

onMounted(async () => {
  await loadRuns();
  await loadCompare();
});

/** 导出 Markdown：结论要能贴进周报/简历，而不是只能截个图 */
function exportMd() {
  const d = data.value;
  if (!d?.comparable) return;
  const L = [];
  L.push(`# 模型对比：${d.a.model} vs ${d.b.model}`, '');
  L.push(`- 数据集：${d.dataset.name} @v${d.dataset.version}（hash \`${d.dataset.hash}\`）`);
  L.push(`- 共同题目：${d.overlap} 条（A 独有 ${d.only_a.length}，B 独有 ${d.only_b.length}）`);
  L.push(`- 基准 A：\`${d.a.id}\` ${d.a.provider}/${d.a.model}`);
  L.push(`- 对照 B：\`${d.b.id}\` ${d.b.provider}/${d.b.model}`);
  L.push('');
  L.push('| 指标 | A | B | 差值(B-A) |', '|---|---:|---:|---:|');
  L.push(`| 总分 | ${d.a.aggregate.total} | ${d.b.aggregate.total} | ${fmtDelta(d.delta.total)} |`);
  for (const row of d.by_dimension) {
    L.push(`| ${DIM_CN[row.dim]} | ${row.a} | ${row.b} | ${fmtDelta(row.delta)} |`);
  }
  L.push('');
  L.push(`条目级：改善 ${d.summary.improved} 条 / 变差 ${d.summary.worsened} 条 / 持平 ${d.summary.unchanged} 条`);
  if (d.summary.best) L.push(`- 提升最大：${d.summary.best.id} ${fmtDelta(d.summary.best.delta)}`);
  if (d.summary.worst) L.push(`- 退步最大：${d.summary.worst.id} ${fmtDelta(d.summary.worst.delta)}`);
  L.push('');
  L.push('差值方向固定为 B − A，正数代表 B 更好。仅统计两次都跑过的题目。');

  const blob = new Blob([L.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `compare_${d.a.id.slice(0, 8)}_vs_${d.b.id.slice(0, 8)}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>模型对比</h2>
        <p class="muted">
          只统计两次任务都跑过的题目；数据集版本不同判为不可比。差值固定为 <code>B − A</code>，正数代表 B 更好。
        </p>
      </div>
      <button class="btn" :disabled="!data?.comparable" @click="exportMd">导出 Markdown</button>
    </div>

    <div class="card">
      <div class="card-head">
        <span class="card-title">选择两次任务</span>
        <span class="card-note">A 为基准，B 为对照</span>
      </div>

      <div class="ab-grid" style="grid-template-columns: 1fr 1fr; gap: 14px">
        <label>
          <span class="muted">基准 A</span>
          <select v-model="aId" class="cmp-select">
            <option value="">选择任务…</option>
            <option v-for="r in finishedRuns" :key="r.id" :value="r.id">{{ label(r) }}</option>
          </select>
        </label>
        <label>
          <span class="muted">对照 B</span>
          <select v-model="bId" class="cmp-select">
            <option value="">选择任务…</option>
            <option v-for="r in finishedRuns" :key="r.id" :value="r.id">{{ label(r) }}</option>
          </select>
        </label>
      </div>

      <div v-if="!finishedRuns.length" class="empty" style="margin-top: 10px">
        还没有已完成的任务，先到「评测任务」页跑一次。
      </div>
      <div v-if="aId && aId === bId" class="alert" style="margin-top: 10px">
        两边的任务相同，换个对照任务再比。
      </div>
      <div v-if="error" class="alert bad" style="margin-top: 10px">{{ error }}</div>
    </div>

    <div v-if="loading" class="card"><span class="muted">对比中…</span></div>

    <div v-else-if="data && !data.comparable" class="card">
      <div class="alert bad">{{ data.reason }}</div>
      <p class="muted" style="margin-top: 8px">
        A：{{ data.a?.model }}（{{ data.a?.total_items }} 条，{{ data.a?.dataset?.name }}@v{{ data.a?.dataset?.version }}）<br />
        B：{{ data.b?.model }}（{{ data.b?.total_items }} 条，{{ data.b?.dataset?.name }}@v{{ data.b?.dataset?.version }}）
      </p>
    </div>

    <template v-else-if="data?.comparable">
      <div class="stat-grid">
        <div class="stat">
          <div class="stat-label">总分 A</div>
          <div class="stat-value">{{ data.a.aggregate.total }}</div>
          <div class="stat-hint">{{ data.a.provider }} / {{ data.a.model }}</div>
        </div>
        <div class="stat">
          <div class="stat-label">总分 B</div>
          <div class="stat-value">{{ data.b.aggregate.total }}</div>
          <div class="stat-hint">{{ data.b.provider }} / {{ data.b.model }}</div>
        </div>
        <div class="stat">
          <div class="stat-label">差值 B−A</div>
          <div class="stat-value" :class="deltaClass(data.delta.total)">
            {{ fmtDelta(data.delta.total) }}
          </div>
          <div class="stat-hint">共同题目 {{ data.overlap }} 条</div>
        </div>
        <div class="stat">
          <div class="stat-label">条目级</div>
          <div class="stat-value">
            {{ data.summary.improved }}<span class="muted" style="font-size: 15px"> 升</span> /
            {{ data.summary.worsened }}<span class="muted" style="font-size: 15px"> 降</span>
          </div>
          <div class="stat-hint">持平 {{ data.summary.unchanged }} 条</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <span class="card-title">五维对比</span>
          <span class="card-note">↑ 变好，↓ 变差</span>
        </div>
        <div class="dim-row" v-for="row in data.by_dimension" :key="row.dim">
          <span class="dim-name">{{ DIM_CN[row.dim] }}</span>
          <span class="dim-track"><span class="dim-fill" :style="{ width: (row.b / 5) * 100 + '%' }"></span></span>
          <span class="dim-val mono">{{ row.a }} → {{ row.b }}</span>
          <span class="dim-val mono" :class="deltaClass(row.delta)">
            {{ row.delta > 0 ? '↑' : row.delta < 0 ? '↓' : '=' }} {{ fmtDelta(row.delta) }}
          </span>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <span class="card-title">逐条差异</span>
          <span class="card-note">
            A 独有 {{ data.only_a.length }} 条 / B 独有 {{ data.only_b.length }} 条（不计入均值）
          </span>
        </div>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px">
          <thead>
            <tr class="muted" style="text-align: left">
              <th style="padding: 6px">题号</th>
              <th>A 总分</th>
              <th>B 总分</th>
              <th>差值</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="i in data.items" :key="i.id">
              <td class="mono" style="padding: 6px">{{ i.id }}</td>
              <td class="mono">{{ i.a_total ?? '-' }}</td>
              <td class="mono">{{ i.b_total ?? '-' }}</td>
              <td class="mono" :class="deltaClass(i.delta)">{{ fmtDelta(i.delta) }}</td>
              <td class="muted">
                <span v-if="i.a_error">A 失败（{{ i.a_error }}）</span>
                <span v-if="i.b_error">B 失败（{{ i.b_error }}）</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.cmp-select {
  width: 100%;
  margin-top: 4px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
}
.up {
  color: var(--good);
}
.down {
  color: var(--bad);
}
</style>
