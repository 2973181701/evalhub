<script setup>
/**
 * 标注界面
 *   A/B 双栏对比 → 选偏好 → 填理由 + 置信度 → 提交
 *   提交前由 MoonBit 标注引擎校验（choice / reason / confidence / 答案非空），
 *   不通过则拒收并给出具体原因；质检标记（低置信度、平手、零区分度样本）随结果返回。
 *
 *   默认隐藏两个回答的策略标签，避免「知道哪个是简洁版」带来的标注偏见——
 *   这与标注规范里「不因为某个回答看起来更像 AI 写的而加分」是同一条纪律。
 */
import { onMounted, ref, computed } from 'vue';
import { api } from '../api.js';
import { canWrite, writeBlockReason } from '../authState.js';
import { friendlyError } from '../errors.js';

const items = ref([]);
const loading = ref(true);
const loadError = ref('');
const selectedId = ref('');

const choice = ref('');
const reason = ref('');
const confidence = ref(4);
const submitting = ref(false);
const feedback = ref(null); // { type:'ok'|'bad', check, message }
const showLabels = ref(false);

const selected = computed(() => items.value.find((i) => i.id === selectedId.value) ?? null);
const doneCount = computed(() => items.value.filter((i) => i.annotation).length);
const progress = computed(() => (items.value.length ? Math.round((doneCount.value / items.value.length) * 100) : 0));

const FLAG_TEXT = {
  low_confidence: '置信度 ≤ 2，建议复核',
  reason_too_short: '理由偏短，规范要求写明「选了哪个 + 依据哪个维度 + 对方差在哪」',
  tie_needs_review: '选了平手，规范要求慎用（全篇平手率应 ≤30%）',
  identical_answers: 'A 与 B 文本完全相同，该样本无区分度',
};

async function load() {
  loading.value = true;
  try {
    const data = await api.dataset();
    items.value = data.items;
    selectedId.value = data.items[0]?.id ?? '';
    syncForm();
  } catch (e) {
    loadError.value = e.message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/** 切换题目时把该题已有的标注回填到表单 */
function syncForm() {
  const a = selected.value?.annotation;
  choice.value = a?.choice ?? '';
  reason.value = a?.reason ?? '';
  confidence.value = a?.confidence ?? 4;
  feedback.value = null;
}

function pick(id) {
  selectedId.value = id;
  syncForm();
}

async function submit() {
  if (!selected.value) return;
  if (!canWrite.value) {
    feedback.value = { type: 'bad', message: writeBlockReason.value };
    return;
  }
  submitting.value = true;
  feedback.value = null;
  try {
    const data = await api.annotate({
      id: selected.value.id,
      task_type: selected.value.task_type,
      choice: choice.value,
      reason: reason.value,
      confidence: confidence.value,
    });
    const idx = items.value.findIndex((i) => i.id === selected.value.id);
    if (idx >= 0) items.value[idx] = { ...items.value[idx], annotation: data.record };
    const fb = { type: 'ok', check: data.check, message: '校验通过，已入库' };
    // 自动跳到下一条未标注的题（syncForm 会清空表单，所以反馈在跳转之后再落回）
    const next = items.value.find((i) => !i.annotation);
    if (next) pick(next.id);
    feedback.value = fb;
  } catch (e) {
    feedback.value = { type: 'bad', check: e.payload?.check, message: friendlyError(e) };
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <main class="page">
    <div class="page-head">
      <h2>标注界面</h2>
      <p>
        A/B 偏好标注（RLHF 偏好数据）。规范见项目里的 <code class="mono">标注规范.md</code>：
        按「事实准确性 → 格式遵循 → 相关性 → 完整度 → 表达质量」从上往下比较，上一级分出胜负就不看下一级。
      </p>
    </div>

    <div v-if="loadError" class="alert bad">加载数据集失败：{{ loadError }}</div>

    <div class="grid side">
      <!-- 题目进度 -->
      <section class="card">
        <div class="card-head">
          <span class="card-title">标注进度</span>
          <span class="card-note">{{ doneCount }} / {{ items.length }}（{{ progress }}%）</span>
        </div>
        <div class="dim-track" style="margin-bottom: 12px">
          <div class="dim-fill" :style="{ width: progress + '%', background: '#4f46e5' }"></div>
        </div>

        <label class="field" style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px">
          <input v-model="showLabels" type="checkbox" style="width: auto" />
          <span style="margin: 0; font-weight: 400; color: var(--text-2)">显示策略标签（默认隐藏，避免标注偏见）</span>
        </label>

        <div v-if="loading" class="empty"><span class="spinner dark"></span></div>
        <div v-else class="item-list">
          <div
            v-for="it in items"
            :key="it.id"
            class="item-row"
            :class="{ active: it.id === selectedId }"
            @click="pick(it.id)"
          >
            <span class="item-id">{{ it.id }}</span>
            <span class="item-text">{{ it.prompt }}</span>
            <span class="badge" :class="it.annotation ? 'done' : 'todo'">
              {{ it.annotation ? it.annotation.choice : '待标' }}
            </span>
          </div>
        </div>
      </section>

      <!-- 标注工作区 -->
      <section class="stack">
        <div v-if="selected" class="card">
          <div class="card-head">
            <span class="card-title">{{ selected.id }} · {{ selected.task_type }}</span>
            <span class="badge brand">参考答案：{{ selected.reference || '（无）' }}</span>
          </div>
          <p style="margin: 0 0 4px; font-weight: 600">{{ selected.prompt }}</p>
        </div>

        <div v-if="selected" class="ab-grid">
          <div
            v-for="side in ['A', 'B']"
            :key="side"
            class="ab-card"
            :class="{ selected: choice === side }"
            @click="choice = side"
          >
            <div class="ab-head">
              <span class="ab-tag">{{ side }} {{ showLabels ? '· ' + selected['strategy_' + side + '_label'] : '' }}</span>
              <span class="ab-meta">{{ (side === 'A' ? selected.answer_A : selected.answer_B).length }} 字</span>
            </div>
            <div class="ab-body">{{ side === 'A' ? selected.answer_A : selected.answer_B }}</div>
          </div>
        </div>

        <div v-if="selected" class="card">
          <div class="card-head"><span class="card-title">判定</span></div>

          <div class="choice-row" style="margin-bottom: 14px">
            <button class="choice-btn" :class="{ active: choice === 'A' }" @click="choice = 'A'">A 更好</button>
            <button class="choice-btn" :class="{ active: choice === 'B' }" @click="choice = 'B'">B 更好</button>
            <button class="choice-btn" :class="{ active: choice === '平手' }" @click="choice = '平手'">平手</button>
          </div>

          <label class="field">
            <span>选择理由（必填）</span>
            <textarea
              v-model="reason"
              placeholder="例：选 A：事实准确性与 B 一致（均为北京），依据维度 5 表达质量——A 直接给出答案共 2 字；B 铺陈 581 字背景介绍，信息冗余，同等信息量下简洁者优先。"
            ></textarea>
          </label>

          <label class="field">
            <span>置信度（1–5）</span>
            <div class="conf-row">
              <button
                v-for="n in [1, 2, 3, 4, 5]"
                :key="n"
                class="conf-btn"
                :class="{ active: confidence === n }"
                @click="confidence = n"
              >
                {{ n }}
              </button>
            </div>
          </label>

          <div v-if="!canWrite" class="alert" style="margin-bottom: 10px">{{ writeBlockReason }}</div>

          <div class="btn-row">
            <button class="btn primary" :disabled="submitting || !canWrite" @click="submit">
              <span v-if="submitting" class="spinner"></span>
              {{ submitting ? '提交中…' : '提交标注' }}
            </button>
            <span class="muted">提交后由 MoonBit 标注引擎校验，通过才入库</span>
          </div>
        </div>

        <!-- 校验反馈 -->
        <div v-if="feedback" class="alert" :class="feedback.type === 'ok' ? 'good' : 'bad'">
          <strong>{{ feedback.message }}</strong>
          <template v-if="feedback.check">
            <div v-if="feedback.check.errors?.length">
              错误：
              <ul>
                <li v-for="(err, i) in feedback.check.errors" :key="i">{{ err }}</li>
              </ul>
            </div>
            <div v-if="feedback.check.flags?.length" style="margin-top: 5px">
              质检标记：
              <ul>
                <li v-for="(f, i) in feedback.check.flags" :key="i">{{ FLAG_TEXT[f] || f }}</li>
              </ul>
            </div>
            <div v-if="feedback.type === 'ok'" style="margin-top: 5px">
              归一化结果：choice = <code class="mono">{{ feedback.check.choice }}</code>，confidence =
              <code class="mono">{{ feedback.check.confidence }}</code>
            </div>
          </template>
        </div>
      </section>
    </div>
  </main>
</template>
