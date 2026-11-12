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

// 约束门禁：题面写明的约束（字数/句数/标签/代码/两步/JSON）有没有守住。
// 它不进五维均分——否则会被长度分稀释；只在违规时给总分封顶。
const GATE_CN = { pass: '通过', warn: '1 项违规', fail: '≥2 项违规' };
const gateColor = (g) => (g === 'pass' ? '#059669' : g === 'warn' ? '#d97706' : '#dc2626');
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

    <div v-if="typeof scores.constraint === 'number'" class="dim-row">
      <span class="dim-name">约束遵循</span>
      <span class="dim-track">
        <span
          class="dim-fill"
          :style="{ width: pct(scores.constraint), background: colorOf(scores.constraint) }"
        ></span>
      </span>
      <span class="dim-val" :style="{ color: colorOf(scores.constraint) }">{{ scores.constraint }}</span>
    </div>

    <div class="total-box">
      <span class="total-num" :style="{ color: colorOf(scores.total) }">{{ scores.total }}</span>
      <span class="total-label">总分（五维均分，满分 5）</span>
    </div>

    <div v-if="scores.gate" class="gate-box">
      <span class="gate-badge" :style="{ color: gateColor(scores.gate), borderColor: gateColor(scores.gate) }">
        门禁 {{ GATE_CN[scores.gate] ?? scores.gate }}
      </span>
      <span v-if="scores.gate !== 'pass'" class="gate-note">
        违规封顶后得分 {{ scores.gated_total }}
      </span>
    </div>
  </div>
</template>
