import type { GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Load a GLTF/GLB asset with automatic retries and exponential backoff.
 * Static hosts like GitHub Pages / Fastly occasionally drop or throttle
 * individual requests during a cold-cache burst; retrying prevents a single
 * transient fetch error from falling back to low-detail or block geometry.
 */
export async function loadGltfWithRetry(
  loader: GLTFLoader,
  url: string,
  retries = 3,
  baseDelayMs = 450,
): Promise<GLTF> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await loader.loadAsync(url);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const delay = baseDelayMs * (1 << attempt) + Math.floor(Math.random() * 180);
        await new Promise<void>(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastErr;
}

/**
 * Run async tasks with a strict concurrency cap so cold-cache loads never
 * flood the browser connection pool or trigger CDN rate limits.
 */
export async function runChunked<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    }),
  );
  return results;
}
