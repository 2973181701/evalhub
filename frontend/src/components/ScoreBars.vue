<script setup>
/**
 * 五维分数条（评测看板与报告页共用）
 * 颜色按分数分档：≥4 绿 / ≥3 靛 / ≥2 橙 / <2 红
 */
const props = defineProps({
  scores: { type: Object, required: true },
});

const DIMS = [
  { key: 'accuracy', label: '准确性' },
  { key: 'completeness', label: '完整性' },
  { key: 'logic', label: '逻辑性' },
  { key: 'safety', label: '安全性' },
  { key: 'expression', label: '表达质量' },
];

const colorOf = (v) => (v >= 4 ? '#059669' : v >= 3 ? '#4f46e5' : v >= 2 ? '#d97706' : '#dc2626');
const pct = (v) => `${Math.max(0, Math.min(100, (Number(v) / 5) * 100))}%`;
</script>

<template>
  <div>
    <div v-for="d in DIMS" :key="d.key" class="dim-row">
      <span class="dim-name">{{ d.label }}</span>
      <span class="dim-track">
        <span
          class="dim-fill"
          :style="{ width: pct(scores[d.key]), background: colorOf(scores[d.key]) }"
        ></span>
      </span>
      <span class="dim-val" :style="{ color: colorOf(scores[d.key]) }">{{ scores[d.key] }}</span>
    </div>

    <div class="total-box">
      <span class="total-num" :style="{ color: colorOf(scores.total) }">{{ scores.total }}</span>
      <span class="total-label">总分（五维均分，满分 5）</span>
    </div>
  </div>
</template>
