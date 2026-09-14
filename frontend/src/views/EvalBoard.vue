<script setup>
/**
 * 评测看板
 *   左侧：从真实评测集 prompts.json 里选一道题
 *   右侧：两种打分路径 —— ① 对已有真实回答打分（不联网） ② 现调 GLM 生成回答再打分
 */
import { onMounted, ref, computed } from 'vue';
import { api } from '../api.js';
import ScoreBars from '../components/ScoreBars.vue';

const prompts = ref([]);
const selectedId = ref('');
const loadingList = ref(true);
const listError = ref('');

const busy = ref(false);
const callError = ref('');
const result = ref(null); // { mode, model, elapsed_ms, answer, score }
const meta = ref(null);

const selected = computed(() => prompts.value.find((p) => p.id === selectedId.value) ?? null);
const canCallModel = computed(() => Boolean(meta.value?.glm?.ready));

onMounted(async () => {
  try {
    const [list, health] = await Promise.all([api.prompts(), api.health()]);
    prompts.value = list;
    meta.value = health;
    selectedId.value = list[0]?.id ?? '';
  } catch (e) {
    listError.value = e.message;
  } finally {
    loadingList.value = false;
  }
});

/** ① 对已存的真实回答打分：只经过 MoonBit 引擎，不碰网络 */
async function scoreStored() {
  if (!selected.value) return;
  busy.value = true;
  callError.value = '';
  result.value = null;
  try {
    const score = await api.score({
      prompt: selected.value.prompt,
      answer: selected.value.stored_answer ?? '',
      reference: selected.value.reference,
      task_type: selected.value.task_type,
    });
    result.value = { mode: 'stored', answer: selected.value.stored_answer ?? '', score };
  } catch (e) {
    callError.value = e.message;
  } finally {
    busy.value = false;
  }
}

/** ② 现调 GLM 生成回答，再交给引擎打分 */
async function callModel() {
  if (!selected.value) return;
  busy.value = true;
  callError.value = '';
  result.value = null;
  try {
    const data = await api.evalOne({
      prompt: selected.value.prompt,
      reference: selected.value.reference,
      task_type: selected.value.task_type,
    });
    result.value = { mode: 'model', answer: data.answer, score: data.score, model: data.model, elapsed_ms: data.elapsed_ms };
  } catch (e) {
    callError.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="page">
    <div class="page-head">
      <h2>评测看板</h2>
      <p>
        数据源：真实评测集 <code class="mono">prompts.json</code>（20 题 / 6 种题型）+ GLM 的真实回答
        <code class="mono">answers.json</code>。评分全部由 MoonBit 评测引擎计算，规则确定性可复现。
      </p>
    </div>

    <div class="alert warn" style="margin-bottom: 18px">
      <strong>关于「准确性」维度的已知边界：</strong>
      规则引擎按「参考答案要点命中 / 二元组覆盖率」判定准确性，对<b>同义改写</b>会误杀
      （例如参考答案写「泛化变差」、回答写「在未见过的数据上表现不佳」，语义一致但字面不同）。
      这是刻意的设计取舍：规则引擎负责<b>低成本、可复现的筛查</b>，语义判断交给人工标注（标注界面）
      与后续的 LLM-as-Judge。因此本维度分数应读作<b>下界信号</b>，而不是模型能力的定论。
    </div>

    <div v-if="listError" class="alert bad">加载题目失败：{{ listError }}</div>

    <div class="grid side">
      <!-- 题目列表 -->
      <section class="card">
        <div class="card-head">
          <span class="card-title">评测题目</span>
          <span class="card-note">{{ prompts.length }} 条</span>
        </div>
        <div v-if="loadingList" class="empty"><span class="spinner dark"></span></div>
        <div v-else class="item-list">
          <div
            v-for="p in prompts"
            :key="p.id"
            class="item-row"
            :class="{ active: p.id === selectedId }"
            @click="selectedId = p.id"
          >
            <span class="item-id">{{ p.id }}</span>
            <span class="item-text">{{ p.prompt }}</span>
            <span class="badge">{{ p.task_type }}</span>
          </div>
        </div>
      </section>

      <!-- 打分区 -->
      <section class="stack">
        <div v-if="selected" class="card">
          <div class="card-head">
            <span class="card-title">{{ selected.id }} · {{ selected.task_type }}</span>
            <span class="badge brand">参考答案：{{ selected.reference || '（无）' }}</span>
          </div>
          <p style="margin: 0 0 14px">{{ selected.prompt }}</p>
          <div class="btn-row">
            <button class="btn primary" :disabled="busy || !selected.stored_answer" @click="scoreStored">
              <span v-if="busy" class="spinner"></span>
              {{ busy ? '计算中…' : '对已有真实回答打分' }}
            </button>
            <button class="btn ghost" :disabled="busy || !canCallModel" @click="callModel">
              {{ busy ? '调用中…' : '现调 GLM 生成并打分' }}
            </button>
            <span v-if="!canCallModel" class="muted">（未配置 GLM 密钥，仅可用第一条路径）</span>
          </div>
        </div>

        <div v-if="callError" class="alert bad">{{ callError }}</div>

        <div v-if="result" class="grid cols-2">
          <div class="card">
            <div class="card-head">
              <span class="card-title">五维评分</span>
              <span class="card-note">
                {{ result.mode === 'model' ? `${result.model} · ${result.elapsed_ms}ms` : '已有回答（未联网）' }}
              </span>
            </div>
            <ScoreBars :scores="result.score" />
          </div>
          <div class="card">
            <div class="card-head">
              <span class="card-title">被评分的回答</span>
              <span class="card-note">{{ result.answer.length }} 字</span>
            </div>
            <pre class="answer">{{ result.answer || '（空）' }}</pre>
          </div>
        </div>

        <div v-else-if="!busy" class="card">
          <div class="empty">选一道题，然后用上面任意一条路径打分</div>
        </div>
      </section>
    </div>
  </main>
</template>
