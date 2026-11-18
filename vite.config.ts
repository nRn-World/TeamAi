import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  worker: { format: 'es' }, // the speech and language-model workers load their libraries as modules
  server: { host: '0.0.0.0', port: 5173, allowedHosts: true, headers: { 'Permissions-Policy': 'microphone=*' } },
  preview: { host: '0.0.0.0', port: 5173, allowedHosts: true },
  // Keep the speech/language-model libraries out of the first paint: the ASR worker and the
  // optional WebLLM engine load them only when voice or the AI Brain is actually used.
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/@huggingface/transformers')) return 'asr';
          if (id.includes('node_modules/@mlc-ai/web-llm')) return 'llm';
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('node_modules/peerjs')) return 'peer';
        },
      },
    },
  },
});
