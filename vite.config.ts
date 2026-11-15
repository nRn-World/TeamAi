import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  worker: { format: 'es' }, // the speech and language-model workers load their libraries as modules
  server: { host: '0.0.0.0', port: 5173, allowedHosts: true, headers: { 'Permissions-Policy': 'microphone=*' } },
  preview: { host: '0.0.0.0', port: 5173, allowedHosts: true },
});
