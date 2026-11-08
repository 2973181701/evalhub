/**
 * 全局鉴权状态（一个模块级 reactive，App 与各视图共用）
 *
 * 为什么不用 provide/inject：视图是 `<component :is>` 动态切换的，
 * inject 需要每层都包 provider；而这份状态本来就全局唯一，模块级 reactive 最省事。
 */

import { reactive, computed } from 'vue';

export const authState = reactive({
  ready: false,
  enabled: false,
  readProtected: false,
  user: null, // { id, email, role, display_name }
});

const RANK = { viewer: 1, evaluator: 2, admin: 3 };

export function roleAtLeast(min) {
  const got = RANK[authState.user?.role] ?? 0;
  return got >= (RANK[min] ?? 2);
}

/** 需要登录（鉴权开启但没有有效用户） */
export const needLogin = computed(() => authState.enabled && !authState.user);

/** 当前用户能否写（创建任务 / 提交标注） */
export const canWrite = computed(() => !authState.enabled || roleAtLeast('evaluator'));

/** 给界面用的一句话说明：为什么不能写 */
export const writeBlockReason = computed(() => {
  if (!authState.enabled) return '';
  if (!authState.user) return '当前已开启鉴权，请先登录（evaluator 及以上才能提交）。';
  if (!roleAtLeast('evaluator')) return `当前角色 ${authState.user.role} 只读，提交需要 evaluator 及以上。`;
  return '';
});
