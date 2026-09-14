<script setup>
import { computed } from 'vue';

/**
 * 手写 SVG 五维雷达图（不引入 ECharts，零额外依赖）。
 * 输入就是 MoonBit 分析引擎输出的 radar 数组：[{key,label,value,ratio}]
 */
const props = defineProps({
  points: { type: Array, required: true },
  size: { type: Number, default: 340 },
});

const CX = computed(() => props.size / 2);
const CY = computed(() => props.size / 2);
const R = computed(() => props.size / 2 - 52);

function angleOf(i, n) {
  return -Math.PI / 2 + (i * 2 * Math.PI) / n;
}

function xy(i, n, radius) {
  const a = angleOf(i, n);
  return [CX.value + radius * Math.cos(a), CY.value + radius * Math.sin(a)];
}

const n = computed(() => props.points.length || 5);

/** 背景网格：5 圈等比例五边形 */
const rings = computed(() => {
  const out = [];
  for (let level = 1; level <= 5; level++) {
    const r = (R.value * level) / 5;
    const pts = [];
    for (let i = 0; i < n.value; i++) pts.push(xy(i, n.value, r));
    out.push({ r, d: pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ') });
  }
  return out;
});

/** 轴线 */
const axes = computed(() => {
  const out = [];
  for (let i = 0; i < n.value; i++) {
    const [x, y] = xy(i, n.value, R.value);
    out.push({ x, y });
  }
  return out;
});

/** 数据多边形 */
const shape = computed(() =>
  props.points
    .map((p, i) => {
      const [x, y] = xy(i, n.value, R.value * Math.max(0, Math.min(1, p.ratio ?? 0)));
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' '),
);

/** 数据点 + 标签 */
const markers = computed(() =>
  props.points.map((p, i) => {
    const ratio = Math.max(0, Math.min(1, p.ratio ?? 0));
    const [x, y] = xy(i, n.value, R.value * ratio);
    const [lx, ly] = xy(i, n.value, R.value + 30);
    return { ...p, x, y, lx, ly, anchor: Math.abs(lx - CX.value) < 6 ? 'middle' : lx > CX.value ? 'start' : 'end' };
  }),
);

const colorOf = (v) => (v >= 4 ? '#059669' : v >= 3 ? '#4f46e5' : v >= 2 ? '#d97706' : '#dc2626');
</script>

<template>
  <svg :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`" role="img" aria-label="五维评分雷达图">
    <defs>
      <linearGradient id="radarFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#6366f1" stop-opacity="0.42" />
        <stop offset="100%" stop-color="#6366f1" stop-opacity="0.12" />
      </linearGradient>
    </defs>

    <!-- 网格 -->
    <polygon
      v-for="ring in rings"
      :key="ring.r"
      :points="ring.d"
      fill="none"
      stroke="#e3e8f0"
      stroke-width="1"
    />

    <!-- 轴线 -->
    <line
      v-for="(a, i) in axes"
      :key="i"
      :x1="CX"
      :y1="CY"
      :x2="a.x"
      :y2="a.y"
      stroke="#e3e8f0"
      stroke-width="1"
    />

    <!-- 数据面 -->
    <polygon :points="shape" fill="url(#radarFill)" stroke="#4f46e5" stroke-width="2" stroke-linejoin="round" />

    <!-- 数据点 -->
    <circle v-for="(m, i) in markers" :key="i" :cx="m.x" :cy="m.y" r="4" fill="#fff" stroke="#4f46e5" stroke-width="2" />

    <!-- 轴标签 -->
    <g v-for="(m, i) in markers" :key="`l${i}`">
      <text
        :x="m.lx"
        :y="m.ly"
        :text-anchor="m.anchor"
        dominant-baseline="middle"
        font-size="12"
        fill="#475569"
        font-weight="600"
      >
        {{ m.label }}
      </text>
      <text
        :x="m.lx"
        :y="m.ly + 15"
        :text-anchor="m.anchor"
        dominant-baseline="middle"
        font-size="12.5"
        font-family="ui-monospace, monospace"
        :fill="colorOf(m.value)"
        font-weight="700"
      >
        {{ m.value }}
      </text>
    </g>
  </svg>
</template>
