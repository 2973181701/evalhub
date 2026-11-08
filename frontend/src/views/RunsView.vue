<script setup>
/**
 * 评测任务页：创建任务 → 看进度 → 看明细。
 *
 * 设计取舍：
 *   - 进度不做 WebSocket，用 1.5s 轮询。评测任务是分钟级，轮询足够，
 *     而且断线重连、页面切后台这些坑全都不用处理。
 *   - 只有存在 queued/running 时才轮询，全部结束就停，避免空转。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { canWrite, writeBlockReason } from '../authState.js';
import { friendlyError } from '../errors.js';

const props = defineProps({ health: { type: Object, default: null } });

const runs = ref([]);
const queue = ref(null);
const loading = ref(false);
const error = ref('');
const notice = ref('');

const provider = ref('local');
const useIds = ref(false);
const idText = ref('');

const selected = ref(null); // { run, rows }
const detailLoading = ref(false);

let timer = null;

const runningCount = computed(() =>
  runs.value.filter((r) => r.status === 'queued' || r.status === 'running').length,
);

const glmReady = computed(() => Boolean(props.health?.glm?.ready));

function pct(r) {
  if (!r.total_items) return 0;
  return Math.min(100, Math.round((r.done_items / r.total_items) * 100));
}

function dur(r) {
  if (!r.started_at) return '-';
  const end = r.finished_at ? new Date(r.finished_at) : new Date();
  const ms = end - new Date(r.started_at);
  if (!Number.isFinite(ms) || ms < 0) return '-';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const STATUS_CN = {
  queued: '排队中',
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  canceled: '已取消',
};

/** 复用现有 badge 变体，避免为一个页面新增一套颜色 */
function statusClass(s) {
  return {
    succeeded: 'done',
    running: 'brand',
    queued: 'todo',
    failed: 'bad',
    canceled: 'bad',
  }[s] ?? 'todo';
}

async function load() {
  loading.value = true;
  try {
    const d = await api.listRuns(20);
    runs.value = d.runs;
    queue.value = d.queue;
    error.value = '';
  } catch (e) {
    error.value = friendlyError(e);
  } finally {
    loading.value = false;
  }
  schedule();
}

/** 仅在有未完成任务时继续轮询 */
function schedule() {
  clearTimeout(timer);
  if (runningCount.value > 0) {
    timer = setTimeout(load, 1500);
  }
}

async function create() {
  notice.value = '';
  error.value = '';
  const ids = useIds.value
    ? idText.value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
    : undefined;
  if (useIds.value && (!ids || !ids.length)) {
    error.value = '勾选「只跑指定题目」后需要填写题号，例如 K01,K02';
    return;
  }
  try {
    const r = await api.createRun({ provider: provider.value, ids, config: { from: 'web' } });
    notice.value = `任务已创建：${r.total_items} 条，状态 ${STATUS_CN[r.status] ?? r.status}`;
    await load();
  } catch (e) {
    error.value = friendlyError(e);
  }
}

async function cancel(r) {
  try {
    await api.cancelRun(r.id);
    await load();
  } catch (e) {
    error.value = friendlyError(e);
  }
}

async function openDetail(r) {
  if (selected.value?.run.id === r.id) {
    selected.value = null;
    return;
  }
  detailLoading.value = true;
  try {
    const [run, res] = await Promise.all([api.getRun(r.id), api.runResults(r.id)]);
    const ds = await api.dataset();
    const typeById = new Map(ds.items.map((i) => [i.id, i.task_type]));
    selected.value = {
      run,
      rows: res.rows.map((x) => ({ ...x, task_type: typeById.get(x.id) ?? '-' })),
    };
  } catch (e) {
    error.value = e.message;
  } finally {
    detailLoading.value = false;
  }
}

onMounted(load);
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2>评测任务</h2>
        <p class="muted">
          创建一次评测 → 后台队列执行 → 逐条落库。任务表即状态机，进程重启不会假装还在跑。
        </p>
      </div>
      <div class="row-between" style="gap: 8px">
        <span v-if="queue" class="pill gray">并发 {{ queue.concurrency }}</span>
        <span v-if="runningCount" class="pill ok"><i class="dot"></i>{{ runningCount }} 个进行中</span>
        <button class="btn" @click="load" :disabled="loading">{{ loading ? '刷新中…' : '刷新' }}</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <span class="card-title">新建任务</span>
        <span class="card-note">local = 用库里已有回答复算基线（不耗额度）；glm = 真实调模型</span>
      </div>

      <div class="btn-row" style="margin-bottom: 12px">
        <button class="btn" :class="{ primary: provider === 'local' }" @click="provider = 'local'">
          本地复算 local
        </button>
        <button
          class="btn"
          :class="{ primary: provider === 'glm' }"
          :disabled="!glmReady"
          :title="glmReady ? '' : '未配置 GLM 密钥'"
          @click="provider = 'glm'"
        >
          真实模型 glm
        </button>
      </div>

      <label class="muted" style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px">
        <input v-model="useIds" type="checkbox" />
        只跑指定题目（否则跑数据集全量）
      </label>
      <input
        v-if="useIds"
        v-model="idText"
        class="mono"
        placeholder="例如 K01,K02,K03"
        style="width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); margin-bottom: 10px"
      />

      <div class="btn-row">
        <button class="btn primary" @click="create" :disabled="loading || !canWrite">创建任务</button>
      </div>

      <div v-if="!canWrite" class="alert" style="margin-top: 12px">{{ writeBlockReason }}</div>
      <div v-if="notice" class="alert" style="margin-top: 12px">{{ notice }}</div>
      <div v-if="error" class="alert bad" style="margin-top: 12px">{{ error }}</div>
    </div>

    <div class="card">
      <div class="card-head">
        <span class="card-title">任务列表</span>
        <span class="card-note">点击任意一行查看逐条明细</span>
      </div>

      <div v-if="!runs.length" class="empty">还没有任务。上面点「创建任务」跑一次。</div>

      <div v-else class="item-list">
        <div v-for="r in runs" :key="r.id" class="stack" style="border-bottom: 1px solid var(--border)">
          <div class="item-row" @click="openDetail(r)" style="cursor: pointer">
            <span class="item-id mono">{{ r.id.slice(0, 8) }}</span>
            <span class="badge" :class="statusClass(r.status)">{{ STATUS_CN[r.status] ?? r.status }}</span>
            <span class="muted mono">{{ r.provider }} / {{ r.model }}</span>
            <div style="flex: 1; min-width: 120px">
              <div class="dim-track" style="height: 6px">
                <div class="dim-fill" :style="{ width: pct(r) + '%' }"></div>
              </div>
            </div>
            <span class="muted mono">{{ r.done_items }}/{{ r.total_items }}</span>
            <span class="muted mono">{{ dur(r) }}</span>
            <button
              v-if="r.status === 'queued' || r.status === 'running'"
              class="btn"
              @click.stop="cancel(r)"
            >
              取消
            </button>
          </div>

          <div v-if="r.error" class="muted" style="padding: 0 0 8px 4px">错误：{{ r.error }}</div>

          <div v-if="selected?.run.id === r.id" style="padding: 4px 0 12px 4px">
            <div v-if="detailLoading" class="muted">加载明细…</div>
            <table v-else style="width: 100%; border-collapse: collapse; font-size: 13px">
              <thead>
                <tr class="muted" style="text-align: left">
                  <th style="padding: 4px 6px">题号</th>
                  <th>题型</th>
                  <th>总分</th>
                  <th>准确性</th>
                  <th>完整性</th>
                  <th>逻辑性</th>
                  <th>安全性</th>
                  <th>表达</th>
                  <th>延迟</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in selected.rows" :key="row.id">
                  <td class="mono" style="padding: 4px 6px">{{ row.id }}</td>
                  <td class="muted">{{ row.task_type }}</td>
                  <td class="mono">{{ row.total ?? '-' }}</td>
                  <td class="mono">{{ row.accuracy ?? '-' }}</td>
                  <td class="mono">{{ row.completeness ?? '-' }}</td>
                  <td class="mono">{{ row.logic ?? '-' }}</td>
                  <td class="mono">{{ row.safety ?? '-' }}</td>
                  <td class="mono">{{ row.expression ?? '-' }}</td>
                  <td class="mono muted">{{ row.latency_ms != null ? row.latency_ms + 'ms' : '-' }}</td>
                </tr>
              </tbody>
            </table>
            <div v-if="selected.rows.some((x) => x.error)" class="alert bad" style="margin-top: 8px">
              {{ selected.rows.filter((x) => x.error).length }} 条失败：
              {{ selected.rows.filter((x) => x.error).map((x) => `${x.id} ${x.error}`).join('；') }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
