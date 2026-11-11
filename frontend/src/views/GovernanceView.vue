<template>
  <main class="page">
    <div class="page-head">
      <div>
        <h1>数据治理</h1>
        <p class="muted">数据中台的两件事：数据从哪来（血缘）、数据干不干净（质量）。规则与血缘均由库内真实状态派生，可随时重建。</p>
      </div>
      <span v-if="report" class="pill" :class="report.status">{{ report.status }}</span>
    </div>

    <div v-if="error" class="alert bad">{{ error }}</div>
    <div v-if="loading" class="spinner">加载中…</div>

    <template v-else>
      <!-- 质量总览 -->
      <section class="card">
        <div class="card-head">
          <span class="card-title">数据质量</span>
          <div class="btn-row">
            <button class="btn" :disabled="busy" @click="refresh">刷新</button>
            <button class="btn primary" :disabled="busy || !canWrite" @click="runCheck">
              {{ busy ? '检查中…' : '运行质量检查' }}
            </button>
          </div>
        </div>
        <div v-if="!canWrite" class="alert" style="margin-bottom: 10px">{{ writeBlockReason }}</div>

        <div v-if="report" class="stat-grid">
          <div class="stat"><div class="stat-label">质量分</div><div class="stat-value">{{ report.score }}</div></div>
          <div class="stat"><div class="stat-label">通过 / 规则</div><div class="stat-value">{{ report.passed }} / {{ report.total_rules }}</div></div>
          <div class="stat"><div class="stat-label">失败</div><div class="stat-value">{{ report.failed }}</div></div>
          <div class="stat"><div class="stat-label">趋势提示</div><div class="stat-value">{{ report.warnings }}</div></div>
        </div>
        <div v-if="report.findings && report.findings.length" style="margin-top: 12px">
          <div v-for="f in report.findings" :key="f.rule_key" class="alert" :class="f.severity === 'critical' ? 'bad' : ''">
            [{{ f.severity }}] {{ f.rule_key }} — {{ f.message }}
          </div>
        </div>
        <div class="card-note" style="margin-top: 8px">
          检查 #{{ report.run_id }} · {{ report.ran_at }} · hash {{ report.content_hash }}
        </div>
      </section>

      <!-- 规则清单 -->
      <section class="card">
        <div class="card-head"><span class="card-title">已注册规则（{{ rules.length }} 条）</span></div>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr class="muted" style="text-align:left">
            <th style="padding:6px">规则</th><th>类别</th><th>级别</th><th>说明</th>
          </tr></thead>
          <tbody>
            <tr v-for="r in rules" :key="r.key">
              <td class="mono" style="padding:6px">{{ r.key }}</td>
              <td class="muted">{{ r.category }}</td>
              <td><span class="badge" :class="r.severity">{{ r.severity }}</span></td>
              <td class="muted">{{ r.description }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- 血缘 -->
      <section class="card">
        <div class="card-head">
          <span class="card-title">数据血缘</span>
          <button class="btn" :disabled="busy || !canWrite" @click="rebuild">重建血缘</button>
        </div>
        <div v-if="graph" class="stat-grid">
          <div class="stat"><div class="stat-label">节点</div><div class="stat-value">{{ graph.stats.node_count }}</div></div>
          <div class="stat"><div class="stat-label">边</div><div class="stat-value">{{ graph.stats.edge_count }}</div></div>
          <div class="stat"><div class="stat-label">关系类型</div><div class="stat-value">{{ graph.stats.relations.length }}</div></div>
          <div class="stat"><div class="stat-label">已知缺口</div><div class="stat-value">{{ graph.gaps.length }}</div></div>
        </div>
        <div class="card-note" style="margin-top:8px">关系：{{ graph.stats.relations.join(' · ') }}</div>

        <div class="btn-row" style="margin-top:14px">
          <input v-model="walkType" class="field-input" placeholder="类型，如 dataset" style="max-width:150px" />
          <input v-model="walkId" class="field-input" placeholder="ID，如 evalhub-core@v1" style="max-width:240px" />
          <select v-model="walkDir" class="field-input" style="max-width:130px">
            <option value="downstream">下游</option>
            <option value="upstream">上游</option>
          </select>
          <button class="btn" :disabled="busy" @click="doWalk">追溯</button>
        </div>
        <div v-if="walked" style="margin-top:10px">
          <div class="card-note">可达 {{ walked.reachable }} 个节点</div>
          <div v-for="n in walked.nodes" :key="n.key + n.depth" class="mono" :style="{ paddingLeft: (n.depth * 18) + 'px', fontSize: '13px', marginTop: '3px' }">
            <span class="muted">{{ '└─ '.repeat(Math.min(n.depth, 3)) }}</span>{{ n.key }}
            <span v-if="n.via" class="muted">（{{ n.via }}）</span>
          </div>
        </div>

        <details style="margin-top:12px">
          <summary class="muted" style="cursor:pointer">已知血缘缺口（{{ graph.gaps.length }}）</summary>
          <div v-for="g in graph.gaps" :key="g.gap" style="margin-top:8px;font-size:13px">
            <div><strong>{{ g.gap }}</strong></div>
            <div class="muted">影响：{{ g.impact }}</div>
            <div class="muted">修复：{{ g.fix }}</div>
          </div>
        </details>
      </section>

      <!-- 资产目录 -->
      <section class="card">
        <div class="card-head">
          <span class="card-title">资产目录（{{ assets.length }} 项）</span>
          <div class="btn-row">
            <input v-model="assetType" class="field-input" placeholder="类型筛选" style="max-width:130px" />
            <input v-model="assetQuery" class="field-input" placeholder="关键词" style="max-width:150px" />
            <button class="btn" :disabled="busy" @click="loadAssets">查询</button>
          </div>
        </div>
        <div class="card-note" style="margin-bottom:8px">
          {{ assetSummary.map(x => x.asset_type + ' ' + x.n).join(' · ') }}
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr class="muted" style="text-align:left">
            <th style="padding:5px">类型</th><th>资产</th><th>条目</th><th>状态</th><th>创建时间</th>
          </tr></thead>
          <tbody>
            <tr v-for="a in assets" :key="a.asset_type + a.asset_key">
              <td class="mono" style="padding:5px">{{ a.asset_type }}</td>
              <td class="mono">{{ a.asset_key }}</td>
              <td class="muted">{{ a.item_count }}</td>
              <td class="muted">{{ a.status }}</td>
              <td class="muted">{{ String(a.created_at).slice(0, 19) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- 接入批次 -->
      <section class="card">
        <div class="card-head"><span class="card-title">数据接入批次（{{ batches.length }}）</span></div>
        <div v-for="b in batches" :key="b.name" style="margin-top:6px">
          <div class="mono" style="font-size:13px">
            {{ b.name }} · {{ b.status }} · 接受 {{ b.accepted_count }}/{{ b.row_count }}
            <span v-if="b.target_dataset"> → {{ b.target_dataset }}@v{{ b.target_version }}</span>
          </div>
          <button v-if="b.rejected_count" class="btn" style="margin-top:4px" @click="toggleRejects(b.name)">
            {{ rejectOpen === b.name ? '收起' : '查看' }}拒绝明细（{{ b.rejected_count }}）
          </button>
          <div v-if="rejectOpen === b.name" style="margin-top:6px">
            <div v-for="r in rejects" :key="r.row_index" class="muted" style="font-size:12.5px">
              行 {{ r.row_index }}：{{ r.reason }}
            </div>
          </div>
        </div>
        <div class="card-note" style="margin-top:8px">样例数据均为 synthetic，非真实业务数据。</div>
      </section>

      <!-- 历史 -->
      <section v-if="history.length > 1" class="card">
        <div class="card-head"><span class="card-title">检查历史</span></div>
        <div v-for="h in history" :key="h.id" class="mono" style="font-size:13px;margin-top:4px">
          #{{ h.id }} · {{ h.ran_at }} · 分数 {{ h.score }} · {{ h.status }}
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

const loading = ref(true);
const busy = ref(false);
const error = ref('');
const report = ref(null);
const rules = ref([]);
const graph = ref(null);
const history = ref([]);
const walkType = ref('dataset');
const walkId = ref('evalhub-core@v1');
const walkDir = ref('downstream');
const walked = ref(null);
const assets = ref([]);
const assetSummary = ref([]);
const assetType = ref('');
const assetQuery = ref('');
const batches = ref([]);
const rejectOpen = ref('');
const rejects = ref([]);

async function loadAssets() {
  try {
    assets.value = await api.catalog({ type: assetType.value || undefined, q: assetQuery.value || undefined, limit: 50 });
    assetSummary.value = await api.catalogSummary();
  } catch (e) { error.value = friendlyError(e); }
}

async function toggleRejects(name) {
  if (rejectOpen.value === name) { rejectOpen.value = ''; return; }
  try {
    rejects.value = await api.ingestRejects(name);
    rejectOpen.value = name;
  } catch (e) { error.value = friendlyError(e); }
}

async function refresh() {
  loading.value = true;
  error.value = '';
  try {
    const [r, rs, g, h, a, sum, b] = await Promise.all([
      api.dqReport(), api.dqRules(), api.lineageGraph(), api.dqHistory(10),
      api.catalog({ limit: 50 }), api.catalogSummary(), api.ingestBatches(),
    ]);
    report.value = r;
    rules.value = rs;
    graph.value = g;
    history.value = h;
    assets.value = a;
    assetSummary.value = sum;
    batches.value = b;
  } catch (e) {
    error.value = friendlyError(e);
  } finally {
    loading.value = false;
  }
}

async function runCheck() {
  busy.value = true;
  try {
    await api.dqRun();
    // 统一取最新报告，避免用检查汇总里没有的 findings 字段
    report.value = await api.dqReport();
    history.value = await api.dqHistory(10);
    error.value = '';
  } catch (e) {
    error.value = friendlyError(e);
  } finally {
    busy.value = false;
  }
}

async function rebuild() {
  busy.value = true;
  try {
    await api.lineageRebuild();
    graph.value = await api.lineageGraph();
    error.value = '';
  } catch (e) {
    error.value = friendlyError(e);
  } finally {
    busy.value = false;
  }
}

async function doWalk() {
  busy.value = true;
  try {
    walked.value = await api.lineageWalk({
      type: walkType.value.trim(),
      id: walkId.value.trim(),
      direction: walkDir.value,
    });
    error.value = '';
  } catch (e) {
    error.value = friendlyError(e);
  } finally {
    busy.value = false;
  }
}

onMounted(refresh);
</script>

<style scoped>
.pill.healthy { color: var(--good, #3fb950); }
.pill.degraded { color: #d29922; }
.pill.critical { color: var(--bad, #f85149); }
.field-input {
  background: transparent;
  border: 1px solid var(--border, #444);
  color: inherit;
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 13px;
}
</style>
