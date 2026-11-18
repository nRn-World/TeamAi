// Browser-level smoke test: boots the production build at High, waits for the first rendered
// frames, then verifies the renderer, shadows, post-processing, first-person arms and the F3
// performance probe. It runs on a software GPU in CI, so it reports timings but does not enforce
// a frame-rate threshold.
import { chromium, type Browser } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

declare global {
  interface Window { __ta?: { sim?: unknown; state?: string }; __taPerf?: Record<string, unknown> }
}

const PORT = Number(process.env.SMOKE_PORT || 4173);
const URL = `http://127.0.0.1:${PORT}/?auto=6&seed=1&q=2&perf=1&noperfguard=1`;
let failures = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures++; console.log(`  FAIL ${msg}`); }
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let server: ChildProcess | null = null;
let browser: Browser | null = null;
const detached = process.platform !== 'win32';
const serverLog: string[] = [];
async function startServer() {
  server = spawn('npm', ['run', 'preview', '--', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached,
  });
  const capture = (chunk: Buffer) => {
    const text = chunk.toString();
    serverLog.push(text);
    if (serverLog.length > 40) serverLog.shift();
  };
  server.stdout?.on('data', capture);
  server.stderr?.on('data', capture);
  for (let i = 0; i < 120; i++) {
    if (server.exitCode != null) throw new Error(`preview server exited with ${server.exitCode}:\n${serverLog.join('')}`);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return;
    } catch { /* not ready yet */ }
    await sleep(500);
  }
  throw new Error(`preview server did not answer on ${PORT}:\n${serverLog.join('')}`);
}
function stopServer() {
  const child = server;
  if (!child) return;
  const pid = child.pid;
  const signal = (sig: NodeJS.Signals) => {
    try { if (detached && pid) process.kill(-pid, sig); else child.kill(sig); } catch { /* already gone */ }
  };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), 3000).unref();
  child.stdout?.destroy();
  child.stderr?.destroy();
}

try {
  console.log(`Browser smoke · ${URL}`);
  await startServer();
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1024, height: 600 }, deviceScaleFactor: 1 });
  const pageErrors: string[] = [];
  page.on('pageerror', e => pageErrors.push(String(e).slice(0, 500)));
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__ta?.sim, null, { timeout: 180000 });
  await page.waitForFunction(() => window.__ta?.state === 'play', null, { timeout: 180000 });
  await page.waitForFunction(() => (window.__taPerf?.frames ?? 0) > 10, null, { timeout: 90000 });
  await sleep(1200);

  const perf = await page.evaluate(() => window.__taPerf);
  console.log(`  ${JSON.stringify(perf)}`);
  ok(perf?.quality === 2, 'High quality is active (q=2)');
  ok(perf?.shadows === true, 'shadow map is enabled');
  ok(perf?.post === true, 'post-processing is enabled');
  ok(perf?.arms === true, 'animated first-person arms are loaded');
  ok((perf?.frames ?? 0) > 0 && (perf?.drawCalls ?? 0) > 0, 'the frame loop is rendering draw calls');
  ok((perf?.fps ?? 0) > 0, 'the performance probe reports a live frame rate');
  ok(pageErrors.length === 0, `no uncaught page errors${pageErrors.length ? `: ${pageErrors.join(' | ')}` : ''}`);

  const shot = process.env.SMOKE_SHOT;
  if (shot) {
    try {
      mkdirSync(dirname(shot), { recursive: true });
      await page.screenshot({ path: shot, timeout: 20000 });
      console.log(`  shot ${shot}`);
    } catch (e) {
      console.log(`  note screenshot skipped: ${String(e).slice(0, 200)}`);
    }
  }
} catch (e) {
  failures++;
  console.log('  FAIL', String(e).slice(0, 1500));
  if (serverLog.length) console.log(serverLog.join(''));
} finally {
  try { await browser?.close(); } catch { /* already gone */ }
  stopServer();
}

console.log(`\nbrowser smoke: ${failures} failure(s)`);
if (failures) process.exit(1);
console.log('BROWSER SMOKE OK');
