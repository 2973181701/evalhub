import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 前端只跟本地 3000 端口打交道；跨域交给 Vite 代理，前端代码里不出现绝对后端地址。
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
});
