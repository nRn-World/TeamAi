// The language model (WebLLM, WebGPU) runs in this worker; src/ai/brain.ts talks to it.
import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';
const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (m: MessageEvent) => handler.onmessage(m);
