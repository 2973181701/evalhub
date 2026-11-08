<script setup>
/**
 * 报告页
 *   雷达图（手写 SVG）+ 五维均分表 + 分题型统计 + 需复核样本
 *   + 一致性（人工 vs 规则判优，含 Fleiss' κ）
 *   + RLHF 训练集导出
 */
import { onMounted, ref, computed } from 'vue';
import { api } from '../api.js';
import { friendlyError } from '../errors.js';
import RadarChart from '../components/RadarChart.vue';

const report = ref(null);
const loading = ref(true);
const error = ref('');

// LLM-as-Judge：第三个「标注者」，用来验证规则判优到底靠不靠谱
const judgeBusy = ref(false);
const judge = ref(null);
const judgeError = ref('');

async function runJudge() {
  judgeBusy.value = true;
  judgeError.value = '';
  try {
    judge.value = await api.judgePreferences();
  } catch (e) {
    judgeError.value = friendlyError(e);
  } finally {
    judgeBusy.value = false;
  }
}

const exportFormat = ref('dpo');
const exporting = ref(false);
const exportResult = ref(null);
const exportError = ref('');

const solo = computed(() => report.value?.solo_consistency ?? null);
const cons = computed(() => report.value?.consistency ?? null);

onMounted(async () => {
  try {
    report.value = await api.report();
  } catch (e) {
    error.value = friendlyError(e);
  } finally {
    loading.value = false;
  }
});

async function doExport() {
  exporting.value = true;
  exportError.value = '';
  exportResult.value = null;
  try {
    exportResult.value = await api.exportRlhf(exportFormat.value);
  } catch (e) {
    exportError.value = friendlyError(e);
  } finally {
    exporting.value = false;
  }
}

/** 把导出结果存成本地文件（纯前端 Blob，不经过额外接口） */
function download() {
  if (!exportResult.value) return;
  const blob = new Blob([JSON.stringify(exportResult.value, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `evalhub_rlhf_${exportResult.value.format}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
</script>

<template>
  <main class="page">
    <div class="page-head">
      <h2>报告页</h2>
      <p>全部数字来自 MoonBit 分析引擎对 20 条真实评测数据的统计，可在 <code class="mono">data/out/report.json</code> 里逐项复核。</p>
    </div>

    <div v-if="loading" class="empty"><span class="spinner dark"></span></div>
    <div v-else-if="error" class="alert bad">加载报告失败：{{ error }}</div>

    <template v-else-if="report">
      <!-- 数据规模 -->
      <div class="stat-grid" style="margin-bottom: 18px">
        <div class="stat">
          <div class="stat-label">评测题</div>
          <div class="stat-value">{{ report.dataset.prompts }}</div>
          <div class="stat-hint">6 种题型</div>
        </div>
        <div class="stat">
          <div class="stat-label">真实回答</div>
          <div class="stat-value">{{ report.dataset.answers }}</div>
          <div class="stat-hint">GLM 生成</div>
        </div>
        <div class="stat">
          <div class="stat-label">A/B 偏好对</div>
          <div class="stat-value">{{ report.dataset.pairs }}</div>
          <div class="stat-hint">简洁版 vs 详尽版</div>
        </div>
        <div class="stat">
          <div class="stat-label">人工标注</div>
          <div class="stat-value">{{ report.dataset.annotations }}</div>
          <div class="stat-hint">运行期新增 {{ report.dataset.submitted }} 条</div>
        </div>
      </div>

      <div class="grid report">
        <!-- 雷达图 -->
        <section class="card">
          <div class="card-head">
            <span class="card-title">五维评分雷达图</span>
            <span class="card-note">总分均分 {{ report.scores.total }} / 5</span>
          </div>
          <div style="display: flex; justify-content: center">
            <RadarChart :points="report.scores.radar" :size="360" />
          </div>
          <table style="margin-top: 8px">
            <thead>
              <tr>
                <th>维度</th>
                <th class="num">均分</th>
                <th class="num">占满分</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in report.scores.radar" :key="p.key">
                <td>{{ p.label }}</td>
                <td class="num">{{ p.value }}</td>
                <td class="num">{{ Math.round(p.ratio * 100) }}%</td>
              </tr>
            </tbody>
          </table>
        </section>

        <div class="stack">
          <!-- 分题型 -->
          <section class="card">
            <div class="card-head">
              <span class="card-title">分题型得分</span>
              <span class="card-note">共 {{ report.scores.by_task_type.length }} 类</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>题型</th>
                  <th class="num">样本数</th>
                  <th class="num">总分均分</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="t in report.scores.by_task_type" :key="t.task_type">
                  <td>{{ t.task_type }}</td>
                  <td class="num">{{ t.count }}</td>
                  <td class="num">{{ t.total }}</td>
                </tr>
              </tbody>
            </table>
          </section>

          <!-- 需复核样本 -->
          <section class="card">
            <div class="card-head">
              <span class="card-title">需要人工复核的样本</span>
              <span class="card-note">分析引擎自动挑出</span>
            </div>
            <p class="muted" style="margin: 0 0 10px; font-size: 12.5px">
              <b>总分最低</b>：优先复核对象。&nbsp;
              <b>五维极差最大</b>：引擎自己都拿不准（通常是准确性拿 0 分、其他维度满分），
              这类样本最需要语义判断——也正是标注环节的价值所在。
            </p>
            <div class="grid cols-2">
              <div>
                <div class="card-note" style="margin-bottom: 6px">总分最低</div>
                <table>
                  <tbody>
                    <tr v-for="s in report.scores.lowest_total" :key="s.id">
                      <td class="mono">{{ s.id }}</td>
                      <td>{{ s.task_type }}</td>
                      <td class="num">{{ s.total }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div>
                <div class="card-note" style="margin-bottom: 6px">五维极差最大</div>
                <table>
                  <tbody>
                    <tr v-for="s in report.scores.max_spread" :key="s.id">
                      <td class="mono">{{ s.id }}</td>
                      <td>{{ s.task_type }}</td>
                      <td class="num">{{ s.spread }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </div>
      </div>

      <!-- 一致性 -->
      <section class="card" style="margin-top: 18px">
        <div class="card-head">
          <span class="card-title">标注一致性分析</span>
          <span class="card-note">Fleiss' κ = (P̄ − P_e) / (1 − P_e)</span>
        </div>

        <div class="grid cols-2">
          <div>
            <div class="card-note" style="margin-bottom: 8px">① 人工标注 vs 规则引擎判优（两个真实评分者）</div>
            <div class="stat-grid" style="grid-template-columns: repeat(3, 1fr)">
              <div class="stat">
                <div class="stat-label">成对一致率</div>
                <div class="stat-value bad">{{ Math.round(cons.pairwise_agreement * 100) }}%</div>
              </div>
              <div class="stat">
                <div class="stat-label">全票一致率</div>
                <div class="stat-value bad">{{ Math.round(cons.unanimous_rate * 100) }}%</div>
              </div>
              <div class="stat">
                <div class="stat-label">Fleiss' κ</div>
                <div class="stat-value bad">{{ cons.fleiss_kappa }}</div>
              </div>
            </div>
            <div class="alert info" style="margin-top: 12px">
              <strong>这个低一致率是真结论，也是这个项目最值得讲的一点：</strong>
              人工按标注规范判「简洁约束版 A 更好」（16/20），而规则引擎按五维总分判「详尽版 B 更好」——
              因为规则引擎不理解「格式约束优先、同等信息量下简洁者优先」这条规范，
              它只会给信息更多的回答打更高的完整性分。
              <br />结论：<b>规则引擎能筛，不能判</b>。这正是需要人工标注、以及把语义判断交给
              LLM-as-Judge 的原因。
            </div>
            <div v-if="cons.disputed_items.length" style="margin-top: 10px">
              <div class="card-note" style="margin-bottom: 5px">存在分歧的样本（{{ cons.disputed_items.length }} 条）</div>
              <div class="btn-row">
                <span v-for="id in cons.disputed_items" :key="id" class="badge bad">{{ id }}</span>
              </div>
            </div>
          </div>

          <div>
            <div class="card-note" style="margin-bottom: 8px">② 只有人工标注者时（诚实暴露样本不足）</div>
            <div class="stat-grid" style="grid-template-columns: repeat(3, 1fr)">
              <div class="stat">
                <div class="stat-label">标注者数量</div>
                <div class="stat-value">{{ solo.annotators.length }}</div>
              </div>
              <div class="stat">
                <div class="stat-label">完整标注样本</div>
                <div class="stat-value">{{ solo.items_complete }}</div>
              </div>
              <div class="stat">
                <div class="stat-label">Fleiss' κ</div>
                <div class="stat-value muted">null</div>
              </div>
            </div>
            <div class="alert warn" style="margin-top: 12px">
              <strong>为什么是 null：</strong>{{ solo.kappa_note }}
              <br />引擎宁可返回 null 并说明原因，也不编一个数字出来——这是本项目的一条硬规矩：
              <b>样本不足就说样本不足</b>。
            </div>
            <table style="margin-top: 12px">
              <tbody>
                <tr>
                  <td>平手数 / 平手率</td>
                  <td class="num">{{ report.annotation_quality.tie_count }} / {{ report.annotation_quality.tie_rate }}%</td>
                  <td class="muted">规范要求 ≤30%</td>
                </tr>
                <tr>
                  <td>平均置信度</td>
                  <td class="num">{{ report.annotation_quality.mean_confidence }}</td>
                  <td class="muted">满分 5</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <!-- 导出 -->
      <section class="card" style="margin-top: 18px">
        <div class="card-head">
          <span class="card-title">导出 RLHF 偏好训练集</span>
          <span class="card-note">平手样本自动丢弃</span>
        </div>
        <div class="btn-row">
          <select v-model="exportFormat" style="width: 260px">
            <option value="dpo">dpo —— {prompt, chosen, rejected}（TRL/DPO 常用）</option>
            <option value="openai">openai —— 对话式 messages 结构</option>
          </select>
          <button class="btn primary" :disabled="exporting" @click="doExport">
            <span v-if="exporting" class="spinner"></span>
            {{ exporting ? '导出中…' : '导出' }}
          </button>
          <button v-if="exportResult" class="btn soft" @click="download">下载 JSON 文件</button>
        </div>

        <div v-if="exportError" class="alert bad" style="margin-top: 12px">{{ exportError }}</div>

        <div v-if="exportResult" style="margin-top: 14px">
          <div class="stat-grid" style="grid-template-columns: repeat(4, 1fr)">
            <div class="stat">
              <div class="stat-label">输入标注</div>
              <div class="stat-value">{{ exportResult.total }}</div>
            </div>
            <div class="stat">
              <div class="stat-label">导出条数</div>
              <div class="stat-value good">{{ exportResult.exported }}</div>
            </div>
            <div class="stat">
              <div class="stat-label">丢弃条数</div>
              <div class="stat-value warn">{{ exportResult.dropped }}</div>
            </div>
            <div class="stat">
              <div class="stat-label">丢弃明细</div>
              <div class="stat-value" style="font-size: 13px; padding-top: 4px">
                平手 {{ exportResult.dropped_detail.tie }}
              </div>
            </div>
          </div>
          <div class="card-note" style="margin: 10px 0 6px">导出内容预览（第 1 条）</div>
          <pre class="json">{{ exportResult.data.length ? JSON.stringify(exportResult.data[0], null, 2) : '（没有可导出的样本）' }}</pre>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <span class="card-title">三方一致性 · 规则 vs Judge vs 人工</span>
          <span class="card-note">Judge 每次调用都烧额度，结果有缓存</span>
        </div>
        <p class="muted" style="margin: 0 0 10px">
          A/B 偏好判定由三个「评分者」分别给出：人工标注（金标准）、规则判优（引擎按分数比大小）、
          LLM-as-Judge（模型按 rubric 判）。单看 Judge 分数没意义，必须先证明它和人对得上。
        </p>
        <div class="btn-row">
          <button class="btn primary" :disabled="judgeBusy" @click="runJudge">
            {{ judgeBusy ? 'Judge 判定中…（约 1 分钟）' : judge ? '重新判定' : '运行 Judge 一致性检查' }}
          </button>
          <span v-if="judge" class="muted">判定 {{ judge.count }} 条，失败 {{ judge.failed }} 条</span>
        </div>

        <div v-if="judgeError" class="alert bad" style="margin-top: 10px">{{ judgeError }}</div>

        <template v-if="judge">
          <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 12px">
            <thead>
              <tr class="muted" style="text-align: left">
                <th style="padding: 6px">对比</th>
                <th>一致率</th>
                <th>Cohen's κ</th>
                <th>判定条数</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(v, k) in judge.kappa" :key="k">
                <td class="mono" style="padding: 6px">{{ k }}</td>
                <td class="mono">{{ (v.po * 100).toFixed(1) }}%</td>
                <td class="mono" :style="{ color: v.kappa > 0.4 ? 'var(--good)' : v.kappa < 0 ? 'var(--bad)' : '' }">
                  {{ v.kappa === null ? '-' : v.kappa }}
                </td>
                <td class="mono muted">{{ v.n }}</td>
              </tr>
            </tbody>
          </table>
          <div class="card-note" style="margin-top: 8px">
            三方 Fleiss κ = {{ judge.consistency_three_way.fleiss_kappa }}，
            三方全同率 {{ (judge.consistency_three_way.unanimous_rate * 100).toFixed(0) }}%，
            分歧题 {{ judge.consistency_three_way.disputed_items.length }} 条
          </div>
          <details style="margin-top: 10px">
            <summary class="muted" style="cursor: pointer">Judge 逐条判定与理由</summary>
            <table style="width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 8px">
              <thead>
                <tr class="muted" style="text-align: left">
                  <th style="padding: 4px">题号</th><th>判定</th><th>约束判断</th><th>理由</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in judge.rows" :key="r.id">
                  <td class="mono" style="padding: 4px">{{ r.id }}</td>
                  <td class="mono">{{ r.choice || '—' }}</td>
                  <td class="muted">{{ r.constraint || '—' }}</td>
                  <td class="muted">{{ r.error || r.reason || '—' }}</td>
                </tr>
              </tbody>
            </table>
          </details>
        </template>
      </section>
    </template>
  </main>
</template>
