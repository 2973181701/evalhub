<script setup>
/**
 * 登录页。
 *
 * 只有在后端开启 EVALHUB_AUTH=1 时才有意义；未开启时直接提示「当前无需登录」，
 * 不假装有一个登录流程——本地演示模式下多一步登录只会让人以为坏了。
 */
import { ref } from 'vue';
import { api, setToken } from '../api.js';

const email = ref('');
const password = ref('');
const busy = ref(false);
const error = ref('');
const emit = defineEmits(['logged-in']);

async function submit() {
  if (!email.value || !password.value) {
    error.value = '请填写邮箱和口令';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const d = await api.login(email.value.trim(), password.value);
    setToken(d.token);
    emit('logged-in', d.user);
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="page">
    <div class="card" style="max-width: 460px; margin: 40px auto">
      <div class="card-head">
        <span class="card-title">登录</span>
        <span class="card-note">评测任务与标注需要 evaluator 及以上角色</span>
      </div>

      <label class="muted" style="display: block; margin-bottom: 6px">邮箱</label>
      <input
        v-model="email"
        type="email"
        placeholder="admin@evalhub.local"
        autocomplete="username"
        style="width: 100%; padding: 9px 11px; margin-bottom: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text)"
      />

      <label class="muted" style="display: block; margin-bottom: 6px">口令</label>
      <input
        v-model="password"
        type="password"
        placeholder="••••••••"
        autocomplete="current-password"
        @keyup.enter="submit"
        style="width: 100%; padding: 9px 11px; margin-bottom: 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text)"
      />

      <div class="btn-row">
        <button class="btn primary" :disabled="busy" @click="submit">
          {{ busy ? '登录中…' : '登录' }}
        </button>
      </div>

      <div v-if="error" class="alert bad" style="margin-top: 12px">{{ error }}</div>

      <p class="muted" style="margin-top: 16px; font-size: 12.5px">
        账号由管理员创建：<code>DATABASE_URL=... node db/create-user.mjs --email ... --password ... --role evaluator</code>
      </p>
    </div>
  </div>
</template>
