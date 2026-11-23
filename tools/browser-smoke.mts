// Browser-level smoke test: boots the production build at High, waits for the first rendered
// frames, then verifies the renderer, shadows, post-processing, first-person arms and the F3
// performance probe. It runs on a software GPU in CI, so it reports timings but does not enforce
// a frame-rate threshold.
import { chromium, type Browser } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

declare global {
  interface Window { __ta?: { sim?: unknown; state?: string }; __taPerf?: Record<string, unknown> }
}

const PORT = Number(process.env.SMOKE_PORT || 4173);
// High quality is forced (q=2) but the perf guard stays ON: on a SwiftShader/llvmpipe software
// GPU the renderer would otherwise stall at full scale and never reach 11 frames. The guard
// only lowers renderScale, never quality/shadows/post, so the High assertions below still hold.
const URL = `http://127.0.0.1:${PORT}/?auto=6&seed=1&q=2&perf=1`;
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
  const consoleLog: string[] = [];
  page.on('pageerror', e => pageErrors.push(String(e).slice(0, 500)));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') consoleLog.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
  const dumpState = async () => {
    try {
      const s = await page.evaluate(() => ({
        hasSim: !!(window as any).__ta?.sim, state: (window as any).__ta?.state,
        perf: (window as any).__taPerf ?? null, perfLog: ((window as any).__ta as any)?.perfLog?.length ?? -1,
        webgl: (() => { try { const c = document.createElement('canvas'); const gl = c.getContext('webgl2') || c.getContext('webgl'); return gl ? (gl as any).getParameter((gl as any).RENDERER) ?? 'webgl-ok' : 'no-context'; } catch { return 'webgl-throw'; } })(),
      }));
      console.log(`  diag ${JSON.stringify(s).slice(0, 800)}`);
    } catch (e) { console.log(`  diag evaluate failed: ${String(e).slice(0, 200)}`); }
    if (pageErrors.length) console.log(`  diag pageerrors: ${pageErrors.join(' | ').slice(0, 800)}`);
    if (consoleLog.length) console.log(`  diag console: ${consoleLog.slice(-5).join(' | ').slice(0, 800)}`);
  };
  const waitStage = async (fn: () => boolean, timeout: number, label: string) => {
    try { await page.waitForFunction(fn, null, { timeout }); }
    catch (e) {
      console.log(`  FAIL stage "${label}" timed out after ${timeout}ms`);
      await dumpState();
      throw e;
    }
  };
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitStage(() => window.__ta?.sim, 180000, 'boot: window.__ta.sim appears');
  await waitStage(() => window.__ta?.state === 'play', 180000, 'boot: state reaches play');
  await waitStage(() => (window.__taPerf?.frames ?? 0) > 10, 180000, 'render: 11 frames drawn (software GPU may be slow)');
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

  // F4 must save the same numbers as a file, labelled with the GPU that produced them. The block is
  // guarded so a failure here reports its own reason instead of the whole preview log.
  try {
    await page.waitForFunction(() => ((window.__ta as any)?.perfLog?.length ?? 0) > 0, null, { timeout: 90000 });
    const live = await page.evaluate(() => (window as any).__taPerfReport());
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.keyboard.press('F4'),
    ]);
    const file = await download.path();
    const saved = JSON.parse(readFileSync(file!, 'utf8'));
    console.log(`  report ${download.suggestedFilename()} (${live.quality}, ${live.gpu.renderer}, software=${live.gpu.software})`);
    ok(live.schema === 'teamai.perf/1', 'the live report is versioned');
    ok(live.quality === 'HIGH' && live.high === true, 'the report records that High was measured');
    ok(typeof live.gpu.renderer === 'string' && live.gpu.renderer.length > 0, 'the report names the GPU renderer');
    ok(live.gpu.software === /swiftshader|llvmpipe|software|basic render/i.test(live.gpu.renderer), 'the renderer is labelled hardware or software from its own string');
    ok((live.series?.length ?? 0) > 0 && typeof live.now?.fps === 'number', 'the report carries live samples and the current frame');
    ok(/^teamai-perf-high-.+\.json$/.test(download.suggestedFilename()), 'F4 saves the file as teamai-perf-high-<time>.json');
    ok(saved.schema === live.schema && saved.quality === live.quality && (saved.series?.length ?? 0) > 0, 'the saved file matches the live report');
  } catch (e) {
    failures++;
    console.log('  FAIL performance report:', String(e).slice(0, 400));
  }

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
