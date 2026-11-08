/**
 * 错误文案统一处理。
 *
 * 后端返回的是「未认证：请携带令牌」「权限不足：需要 evaluator 及以上」这类
 * API 视角的措辞，直接摊到界面上用户看不懂。这里按状态码翻成人话，
 * 其余错误原样透出——不能把所有错误都盖成「操作失败」，那等于把排查线索丢了。
 */

export function friendlyError(e) {
  const status = e?.status;
  const msg = e?.message || '请求失败';
  if (status === 401) return '登录状态已失效，请重新登录后再试。';
  if (status === 403) return `权限不足：${msg.replace(/^权限不足：/, '')}`;
  if (status === 503) return `服务暂不可用：${msg}`;
  return msg;
}
