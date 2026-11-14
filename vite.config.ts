import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  server: { host: '0.0.0.0', port: 5173, allowedHosts: true, headers: { 'Permissions-Policy': 'microphone=*' } },
  preview: { host: '0.0.0.0', port: 5173, allowedHosts: true },
});
