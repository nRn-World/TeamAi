import { loadModels, modelsReady } from './game/models';
import * as THREE from 'three';
import { Sim, Actor, Command, Team, Ev, fwd, PrimaryLoadout, SecondaryLoadout } from './sim/sim';
import { MISSIONS, WALL, DOOR, LOW, HIGH, WINDOW, buildLevel } from './sim/level';
import { MenuScene } from './game/menuscene';
import { operatorEnv } from './game/operator';
import { loadWeapons, weaponsReady, FpsArms, studioEnv } from './game/weapons';
import { upgradeViewModel } from './game/world';
import { loadProps } from './game/props';
import '@fontsource/barlow-condensed/500.css'; import '@fontsource/barlow-condensed/600.css'; import '@fontsource/barlow-condensed/700.css'; import '@fontsource/barlow/400.css'; import '@fontsource/barlow/600.css';
import { parseCommands, shouldUseAiBrain, ACTION_LABEL, DIR_LABEL } from './sim/commands';
import { TacticalAi, AI_MODELS, AiState, AiResult } from './game/ai';
import { LevelView, ActorView, FX, makeViewModel, TEAM_COLOR } from './game/world';
import { GameAudio, Speech } from './game/audio';
import { Voice } from './game/voice';
import { LocalVoice } from './ai/localvoice';
import { Net, Msg } from './game/net';
import { encodeSnap, applySnap, encodeEv, decodeEv } from './sim/netstate';
import type { DataConnection } from 'peerjs';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const show = (id: string, on: boolean) => $(id).classList.toggle('hidden', !on);
const params = new URLSearchParams(location.search);
const AUTO = params.has('auto');

// ---------------- settings & career ----------------
const defaults = { sens: 1, vol: 0.8, mic: 1, ptt: 1, lang: 'en-US', asr: 'local', tts: 1, head: 0, qual: 1, diff: 1, name: '', ai: 0, aiModel: AI_MODELS[0].id as string, primary: 'carbine' as PrimaryLoadout, secondary: 'pistol' as SecondaryLoadout };
type Settings = typeof defaults;
const S: Settings = { ...defaults, ...JSON.parse(localStorage.getItem('teamai.settings') || '{}') };
if (!String(S.lang).startsWith('en')) S.lang = 'en-US'; // English only
if (!AI_MODELS.some(m => m.id === S.aiModel)) S.aiModel = AI_MODELS[0].id;
const best: Record<string, number> = JSON.parse(localStorage.getItem('teamai.best') || '{}');
const career = { xp: 0, ops: 0, arrests: 0, ...JSON.parse(localStorage.getItem('teamai.career') || '{}') };
const RANKS: [number, string][] = [[0, 'Rookie Officer'], [200, 'Tactical Officer'], [500, 'Senior Breacher'], [950, 'Entry Team Lead'], [1500, 'SWAT Commander'], [2400, 'Master Tactician']];
const getRank = (xp: number) => [...RANKS].reverse().find(r => xp >= r[0])![1];
if (params.has('q')) S.qual = +params.get('q')!;
const saveSettings = () => localStorage.setItem('teamai.settings', JSON.stringify(S));

// where the animated arms move to when aiming: x, y, z offset and pitch, yaw; carbine then pistol
const AIMPOS = [[-0.113, 0.036, 0, 0, 0], [-0.0936, 0.0813, -0.02, 0, 0]];
// the challenges the player and the officers yell; one is picked at random each time
const SHOUTS = ['Police! Drop the weapon!', 'Police! Get on the ground!', 'Police! Hands up! Now!', 'Get down! Get down on the ground!', 'Drop it! Drop it now!', 'Show me your hands!'];
interface WeaponSpec { name: string; mag: number; res: number; rate: number; dmg: number; auto: boolean; spread: number; reload: number; kick: number; pellets?: number; nonLethal?: boolean; taser?: boolean; shield?: boolean }
const PRIMARY_SPECS: Record<PrimaryLoadout, WeaponSpec> = {
  carbine: { name: 'M4 CARBINE', mag: 30, res: 150, rate: 0.095, dmg: 34, auto: true, spread: 0.004, reload: 2.0, kick: 0.011 },
  shotgun: { name: 'M870 SHOTGUN', mag: 8, res: 40, rate: 0.58, dmg: 16, pellets: 8, auto: false, spread: 0.045, reload: 2.2, kick: 0.038 },
  beanbag: { name: 'BEANBAG SHOTGUN', mag: 8, res: 40, rate: 0.55, dmg: 8, pellets: 1, nonLethal: true, auto: false, spread: 0.012, reload: 2.1, kick: 0.024 },
  shield: { name: 'SHIELD + PISTOL', mag: 15, res: 90, rate: 0.16, dmg: 26, auto: false, spread: 0.01, reload: 1.5, kick: 0.015, shield: true },
};
const SECONDARY_SPECS: Record<SecondaryLoadout, WeaponSpec> = {
  pistol: { name: 'GLOCK 17 SWAT', mag: 17, res: 68, rate: 0.15, dmg: 26, auto: false, spread: 0.008, reload: 1.4, kick: 0.016 },
  taser: { name: 'X26 TASER', mag: 2, res: 12, rate: 0.45, dmg: 4, auto: false, spread: 0.006, reload: 1.5, kick: 0.008, nonLethal: true, taser: true },
};
const ORDER_LABEL: Record<string, string> = {
  follow: 'FOLLOWING', hold: 'HOLDING', move: 'MOVING', cover: 'COVERING YOU',
  stack: 'AT DOOR', breach: 'BREACHING', door: 'DOOR', restrain: 'SECURING',
  peek: 'PEEKING', c2: 'C2 BREACH', wedge: 'WEDGING', defuse: 'DEFUSING',
};

let assetsDone: Promise<unknown> = Promise.resolve();

class Game {
  renderer: THREE.WebGLRenderer; scene = new THREE.Scene(); camera = new THREE.PerspectiveCamera(74, 1, 0.06, 120);
  viewScene = new THREE.Scene(); viewCam = new THREE.PerspectiveCamera(52, 1, 0.01, 10); vm = makeViewModel();
  torch = new THREE.SpotLight(0xfff0d6, 22, 32, 0.5, 0.6, 1.2);
  sim: Sim | null = null; level: LevelView | null = null; views = new Map<Actor, ActorView>(); fx = new FX();
  audio = new GameAudio(); speech = new Speech(); webVoice = new Voice(); localVoice = new LocalVoice(); voice: Voice | LocalVoice = this.webVoice; ai = new TacticalAi();
  net = new Net(); connIdx = new Map<DataConnection, number>(); connName = new Map<DataConnection, string>(); snapT = 0; inT = 0; stepPh = new Map<Actor, number>(); lobbyMission = 0; lobbyNames: string[] = [];
  state: 'menu' | 'play' | 'pause' | 'end' = 'menu'; mission = 0; seed = 1;
  yaw = 0; pitch = 0; keys = new Set<string>(); mouseDown = false; eye = 1.62; bob = 0; stepAcc = 0; recoil = 0; vmKick = 0; sway = new THREE.Vector2();
  weapon = 0; ammo = [30, 15]; reserve = [150, 60]; fireCd = 0; reloadT = 0; semiLock = false; torchOn = true; mapOn = true;
  nvgOn = false; bodycamOn = false; wheelOn = false; nvgLight: THREE.AmbientLight | null = null; ambLight: THREE.AmbientLight | null = null;
  get weaponSpecs(): [WeaponSpec, WeaponSpec] { return [PRIMARY_SPECS[S.primary] ?? PRIMARY_SPECS.carbine, SECONDARY_SPECS[S.secondary] ?? SECONDARY_SPECS.pistol]; }
  selTeam: Team | 'ALL' = 'ALL'; lastTeam: Team | 'ALL' = 'ALL'; lastWho: number | null = null; typing = false; dmgFx = 0; hitFx = 0; hudT = 0; last = performance.now(); mapBase: HTMLCanvasElement | null = null; endT = 0; parsedT = 0;

  constructor() {
    const canvas = $<HTMLCanvasElement>('c');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.15; this.renderer.autoClear = false;
    this.camera.rotation.order = 'YXZ'; this.viewScene.add(this.viewCam); this.viewCam.add(this.vm.group);
    this.viewScene.add(new THREE.AmbientLight(0xffffff, 1.1)); const vl = new THREE.DirectionalLight(0xffffff, 1.6); vl.position.set(0.5, 1, 0.6); this.viewScene.add(vl);
    window.addEventListener('resize', () => this.resize()); this.resize();
    this.bindInput(); this.bindUI(); this.buildWheel(); this.buildMenu();
    for (const v of [this.webVoice, this.localVoice]) {
      v.onFinal = t => this.heard(t, true); v.onInterim = t => { $('heard').textContent = '« ' + t + ' … »'; this.parsedT = Math.max(this.parsedT, 3); };
      v.onState = (st, d) => { if (v === this.voice) this.micState(st, d); };
      v.onIgnored = t => { // heard an order while V was not held: tell the player instead of silently dropping it
        if (this.state !== 'play' || !t || !parseCommands(t, this.lastTeam, this.lastWho).commands.length) return;
        $('heard').textContent = '« ' + t + ' »'; const q = $('parsed'); q.className = 'bad'; q.textContent = 'HOLD V WHILE YOU SPEAK – the order was not sent'; this.parsedT = 5; this.audio.fail();
      };
    }
    this.localVoice.onNote = t => { if (this.state !== 'play') return; $('heard').textContent = ''; const q = $('parsed'); q.className = 'bad'; q.textContent = t; this.parsedT = 4; };
    this.localVoice.onFail = () => { this.applySettings(); if (this.state === 'play' && S.mic && this.voice !== this.localVoice) { this.voice.start(); this.log('The local speech model could not be loaded – using the browser speech service instead.', 'warn'); } }; // fall back rather than leave the player without a voice
    this.ai.onState = (s, d) => this.aiState(s, d);
    setInterval(() => { if (!$('settings').classList.contains('hidden')) this.asrInfo(); }, 500);
    this.applySettings();
    requestAnimationFrame(() => this.frame());
    if (AUTO) this.start(+(params.get('auto') || 0), +(params.get('seed') || 1));
  }
  resize() {
    const w = innerWidth, h = innerHeight; this.renderer.setPixelRatio(Math.min(devicePixelRatio, S.qual > 1 ? 2 : S.qual ? 1.5 : 1)); this.renderer.setSize(w, h, false);
    this.camera.aspect = this.viewCam.aspect = w / h; this.camera.updateProjectionMatrix(); this.viewCam.updateProjectionMatrix();
  }
  applySettings() {
    this.audio.setVolume(S.vol); this.speech.enabled = !!S.tts; this.speech.lang = S.lang;
    const local = LocalVoice.supported && ((S.asr === 'local' && !this.localVoice.failed) || !Voice.supported), nv = local ? this.localVoice : this.webVoice;
    if (nv !== this.voice) { this.voice.stop(); this.voice = nv; }
    this.webVoice.setLang(S.lang); this.localVoice.setLang('en'); this.voice.ptt = !!S.ptt; this.micState(this.voice.state);
    if (local && S.mic && !AUTO) this.localVoice.preload();
    this.asrInfo();
    ($('sSens') as HTMLInputElement).value = String(S.sens); ($('sVol') as HTMLInputElement).value = String(S.vol);
    for (const [id, k] of [['sMic', 'mic'], ['sPtt', 'ptt'], ['sLang', 'lang'], ['sAsr', 'asr'], ['sTts', 'tts'], ['sHead', 'head'], ['sQual', 'qual'], ['sDiff', 'diff'], ['sAi', 'ai'], ['sAiModel', 'aiModel']] as const) ($(id) as HTMLSelectElement).value = String(S[k]);
    document.querySelectorAll<HTMLElement>('#mDiffPips [data-diff]').forEach(b => b.classList.toggle('on', +b.dataset.diff! === S.diff));
    if (!S.mic) this.voice.stop(); else if (this.state === 'play') this.voice.start();
    if (!S.ai && this.ai.state !== 'off') void this.ai.unload();
    else if (S.ai && this.state === 'play' && !this.net.online && !AUTO) void this.ai.ensureLoaded(S.aiModel);
    this.aiState(this.ai.state, this.ai.state === 'loading' ? this.ai.progress : this.ai.error);
    this.resize();
  }

  // ---------------- menus ----------------
  showPlan = false;
  selectMission(i: number) {
    this.mission = i;
    const m = MISSIONS[i];
    const LOCS = ['KISTA, STOCKHOLM', 'DOCKLANDS, HARBOR', 'CITY CENTER', 'FINANCIAL DISTRICT', 'DOWNTOWN UNDERGROUND', 'OUTSKIRTS COMPOUND'];
    const OBJS = {
      clear: 'RESCUE ALL CIVILIANS · NEUTRALIZE THREATS',
      hostage: 'RESCUE BANK DIRECTOR (VIP) · ARREST CREW',
      bomb: 'LOCATE & DEFUSE EXPLOSIVE · SECURE AREA',
    } as const;
    document.querySelectorAll('#mPills .mpill').forEach((el, idx) => el.classList.toggle('on', idx === i));
    $('mTitle').textContent = m.name;
    $('mLoc').textContent = LOCS[i] ?? 'SECTOR UNKNOWN';
    $('mObj').textContent = OBJS[m.objective];
    $('mBrief').textContent = m.brief;
    ($('mPhoto') as HTMLImageElement).src = `./missions/${i}.jpg`;
    this.drawPlan(i, $<HTMLCanvasElement>('mPlan'), 7);
    $('mFacts').textContent = `${m.suspects} SUSPECTS · ${m.civs} CIVILIANS`;
    const b = $('mBestBadge');
    if (best[i] != null) { b.textContent = `BEST ${best[i]}/100`; b.className = ''; }
    else { b.textContent = 'UNCOMPLETED'; b.className = 'none'; }
  }
  updateRankDock() {
    $('mRank').textContent = `${getRank(career.xp)} · ${career.xp} XP`;
    const cur = [...RANKS].reverse().find(r => career.xp >= r[0])!;
    const nxt = RANKS.find(r => r[0] > career.xp);
    const pct = nxt ? Math.min(100, ((career.xp - cur[0]) / (nxt[0] - cur[0])) * 100) : 100;
    ($('mXpFill') as HTMLElement).style.width = `${Math.max(8, pct)}%`;
  }
  buildMenu() {
    const pills = $('mPills'); pills.innerHTML = '';
    MISSIONS.forEach((m, i) => {
      const b = document.createElement('button'); b.className = 'mpill';
      b.title = m.name;
      b.textContent = `0${i + 1}`;
      b.onclick = () => { this.audio.init(); this.audio.ui(); this.selectMission(i); };
      pills.appendChild(b);
    });
    this.selectMission(this.mission);

    $('btnViewMode').onclick = () => {
      this.audio.init(); this.audio.ui();
      this.showPlan = !this.showPlan;
      show('mPhoto', !this.showPlan); show('mPlan', this.showPlan);
      $('btnViewMode').textContent = this.showPlan ? 'PHOTO' : 'FLOORPLAN';
    };

    document.querySelectorAll<HTMLElement>('#mDiffPips [data-diff]').forEach(b => {
      b.classList.toggle('on', +b.dataset.diff! === S.diff);
      b.onclick = () => {
        this.audio.init(); this.audio.ui();
        S.diff = +b.dataset.diff!; saveSettings();
        ($('sDiff') as HTMLSelectElement).value = String(S.diff);
        document.querySelectorAll<HTMLElement>('#mDiffPips [data-diff]').forEach(o => o.classList.toggle('on', o === b));
      };
    });
    $('btnStartMission').onclick = () => { this.audio.init(); this.audio.ui(); this.newRound(this.mission); };

    const done = MISSIONS.filter((_, i) => best[i] != null).length; $('mBest').textContent = `${done}/${MISSIONS.length} Ops Completed`;
    this.updateRankDock();
    ($('lPrimary') as HTMLSelectElement).value = S.primary; ($('lSecondary') as HTMLSelectElement).value = S.secondary;
    ($('lPrimary') as HTMLSelectElement).onchange = () => { S.primary = ($('lPrimary') as HTMLSelectElement).value as PrimaryLoadout; saveSettings(); };
    ($('lSecondary') as HTMLSelectElement).onchange = () => { S.secondary = ($('lSecondary') as HTMLSelectElement).value as SecondaryLoadout; saveSettings(); };
    const canVoice = Voice.supported || LocalVoice.supported; $('mMic').textContent = canVoice ? 'Voice Ready' : 'No Mic'; $('mMic').className = canVoice ? 'ok' : 'bad';
    document.querySelectorAll<HTMLElement>('.docknav [data-tab]').forEach(n => n.onclick = () => {
      this.audio.init(); this.audio.ui();
      document.querySelectorAll('.docknav [data-tab]').forEach(o => o.classList.toggle('on', o === n));
      for (const id of ['tabPlay', 'tabMp', 'tabLoadout']) show(id, id === n.dataset.tab);
    });
    const w = $('micwarn');
    if (!canVoice) { w.className = 'note warn'; w.textContent = 'Microphone unsupported here – use Enter or H wheel for orders.'; }
    else { w.className = 'note hidden'; w.textContent = ''; }
  }
  /** Blueprint-style floor plan of a mission, drawn for the menu card / briefing. */
  drawPlan(index: number, c: HTMLCanvasElement, k: number) {
    const l = buildLevel(index, 1); c.width = l.w * k; c.height = l.h * k; const g = c.getContext('2d')!;
    g.fillStyle = '#0b1118'; g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = 'rgba(120,160,200,.07)'; g.lineWidth = 1; g.beginPath(); for (let x = 0; x <= l.w; x += 2) { g.moveTo(x * k + 0.5, 0); g.lineTo(x * k + 0.5, c.height); } for (let z = 0; z <= l.h; z += 2) { g.moveTo(0, z * k + 0.5); g.lineTo(c.width, z * k + 0.5); } g.stroke();
    for (let z = 0; z < l.h; z++) for (let x = 0; x < l.w; x++) { const v = l.cells[z * l.w + x]; if (v === 0) continue; g.fillStyle = v === WALL ? '#9db4c8' : v === DOOR ? '#f2c14e' : v === WINDOW ? '#68b6e0' : v === LOW || v === HIGH ? '#263645' : '#152130'; g.fillRect(x * k, z * k, k, k); }
    const s = l.playerSpawn; g.fillStyle = '#4fd07a'; g.beginPath(); g.arc(s.x * k, s.z * k, k * 0.75, 0, 6.3); g.fill();
    if (l.bomb) { g.fillStyle = '#ff3b3b'; g.beginPath(); g.arc(l.bomb.x * k, l.bomb.z * k, k * 0.65, 0, 6.3); g.fill(); }
  }
  buildWheel() {
    const ring = document.querySelector('#wheel .wring')!;
    const items: { label: string; cmd: Command }[] = [
      { label: 'Follow', cmd: { team: 'ALL', action: 'follow' } },
      { label: 'Breach', cmd: { team: 'ALL', action: 'breach' } },
      { label: 'Bang & Clear', cmd: { team: 'ALL', action: 'bang' } },
      { label: 'Optiwand Peek', cmd: { team: 'ALL', action: 'peek' } },
      { label: 'C2 Breach', cmd: { team: 'ALL', action: 'c2' } },
      { label: 'Wedge Door', cmd: { team: 'ALL', action: 'wedge' } },
      { label: 'Secure Area', cmd: { team: 'ALL', action: 'restrain' } },
      { label: 'Hold / Cover', cmd: { team: 'ALL', action: 'cover' } },
    ];
    items.forEach((it, i) => {
      const ang = (i / items.length) * Math.PI * 2 - Math.PI / 2;
      const b = document.createElement('button'); b.className = 'wslice'; b.textContent = it.label;
      b.style.left = `${170 + Math.cos(ang) * 116}px`; b.style.top = `${170 + Math.sin(ang) * 116}px`;
      b.onclick = () => { this.toggleWheel(false); this.exec({ ...it.cmd, team: this.selTeam }, true); this.lock(); };
      ring.appendChild(b);
    });
  }
  toggleWheel(on = !this.wheelOn) {
    this.wheelOn = on; show('wheel', on);
    $('wTarget').textContent = this.selTeam === 'ALL' ? 'ALL TEAMS' : `TEAM ${this.selTeam}`;
    if (on) { this.keys.clear(); this.mouseDown = false; if (document.pointerLockElement) document.exitPointerLock(); }
  }
  toggleNvg() {
    this.nvgOn = !this.nvgOn;
    show('nvg', this.nvgOn);
    if (this.nvgLight) this.nvgLight.intensity = this.nvgOn ? 2.4 : 0;
    this.renderer.toneMappingExposure = this.nvgOn ? 1.8 : 1.15;
    this.audio.nvg(this.nvgOn);
  }
  toggleBodycam() {
    this.bodycamOn = !this.bodycamOn;
    show('bodycam', this.bodycamOn);
    this.audio.ui();
  }
  bindUI() {
    const click = (id: string, fn: () => void) => { $(id).onclick = () => { this.audio.init(); this.audio.ui(); fn(); }; };
    click('btnBack', () => { show('brief', false); show('menu', true); });
    click('btnGo', () => { show('brief', false); this.start(this.mission, (Math.random() * 1e6) | 0); this.lock(); });
    click('btnResume', () => this.resume());
    click('btnRestart', () => { show('pause', false); this.newRound(this.mission); });
    click('btnMicRetry', () => { if (!S.mic) { S.mic = 1; saveSettings(); this.applySettings(); } this.voice.stop(); this.voice.start(); });
    click('btnNewTab', () => { window.open(location.href.split('?')[0], '_blank'); });
    click('btnQuit', () => this.toMenu()); click('btnMenu', () => this.toMenu());
    click('btnAgain', () => { show('debrief', false); this.newRound(this.mission); });
    click('btnNext', () => { show('debrief', false); this.newRound((this.mission + 1) % MISSIONS.length); });
    this.bindNet();
    for (const id of ['btnHelp', 'btnHelp2']) click(id, () => show('help', true));
    for (const id of ['btnSettings', 'btnSettings2']) click(id, () => show('settings', true));
    document.querySelectorAll<HTMLElement>('.stabs button').forEach(b => b.onclick = () => { document.querySelectorAll<HTMLElement>('.stabs button').forEach(o => { o.classList.toggle('on', o === b); $(o.dataset.stab!).classList.toggle('hidden', o !== b); }); });
    document.querySelectorAll<HTMLElement>('.close').forEach(b => b.onclick = () => { b.closest('.screen')!.classList.add('hidden'); this.audio.ui(); });
    const bind = (id: string, k: keyof Settings, num = true) => $(id).addEventListener('input', e => { (S as any)[k] = num ? +(e.target as HTMLInputElement).value : (e.target as HTMLInputElement).value; saveSettings(); this.applySettings(); });
    ($('sAiModel') as HTMLSelectElement).innerHTML = AI_MODELS.map(m => `<option value="${m.id}">${m.label}</option>`).join('');
    bind('sSens', 'sens'); bind('sVol', 'vol'); bind('sMic', 'mic'); bind('sPtt', 'ptt'); bind('sLang', 'lang', false); bind('sAsr', 'asr', false); bind('sTts', 'tts'); bind('sHead', 'head'); bind('sQual', 'qual'); bind('sDiff', 'diff'); bind('sAi', 'ai'); bind('sAiModel', 'aiModel', false);
    $('btnAiLoad').onclick = () => {
      this.audio.init(); this.audio.ui();
      if (!S.ai) { S.ai = 1; saveSettings(); ($('sAi') as HTMLSelectElement).value = '1'; }
      void this.ai.ensureLoaded(S.aiModel);
    };
  }
  toMenu() { document.body.classList.remove('ingame'); this.net.close(); show('lobby', false); this.state = 'menu'; this.speech.stop(); this.voice.stop(); for (const id of ['pause', 'debrief', 'hud', 'brief']) show(id, false); this.buildMenu(); show('menu', true); if (document.pointerLockElement) document.exitPointerLock(); }
  // ---------------- online co-op ----------------
  newRound(mission: number) {
    if (this.net.role === 'client') return;
    const seed = (Math.random() * 1e6) | 0;
    if (this.net.role === 'host') {
      const conns = this.net.conns.slice(0, 3), names = [S.name || 'Host', ...conns.map((c, i) => this.connName.get(c) || 'Player ' + (i + 2))];
      this.connIdx.clear(); conns.forEach((c, i) => { this.connIdx.set(c, i + 1); c.send({ t: 'start', mission, seed, diff: S.diff, n: names.length, you: i + 1, names }); });
      this.start(mission, seed, names.length, 0, S.diff, names);
    } else this.start(mission, seed);
    this.lock();
  }
  bindNet() {
    const err = (e: any) => {
      const t = e?.type, m = String(e?.message || '');
      const why = m.startsWith('Hittade') ? m : t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed' || m === 'timeout' ? 'The matchmaking service that hands out room codes is not responding. It may be down, or blocked by an ad blocker, VPN or firewall. Turn those off for this page and try again in a moment.' : t === 'browser-incompatible' ? 'This browser does not support direct connections (WebRTC). Use Chrome or Edge.' : t === 'peer-unavailable' ? 'No room found with that code.' : 'Unknown error (' + (t || m || e) + ').';
      $('mpErr').textContent = 'Could not connect. ' + why;
    };
    const pre = params.get('join'); if (pre) $<HTMLInputElement>('mpCode').value = pre.toUpperCase().slice(0, 5);
    this.net.onVoice = () => { if (!$('lobby').classList.contains('hidden')) this.lobby(); };
    $('btnCopy').onclick = () => { const link = location.origin + location.pathname + '?join=' + this.net.code; const done = () => { $('btnCopy').textContent = 'Link copied!'; setTimeout(() => { $('btnCopy').textContent = 'Copy invite link'; }, 1800); }; if (navigator.clipboard?.writeText) navigator.clipboard.writeText(link).then(done, () => prompt('Copy the link:', link)); else prompt('Copy the link:', link); };
    const name = $<HTMLInputElement>('mpName'); name.value = S.name; name.addEventListener('input', () => { S.name = name.value.trim().slice(0, 12); saveSettings(); });
    const busy = (on: boolean) => { for (const id of ['btnHost', 'btnJoin']) ($(id) as HTMLButtonElement).disabled = on; if (on) $('mpErr').textContent = 'Connecting to the matchmaking service… (may take a few seconds)'; };
    $('btnHost').onclick = async () => { this.audio.init(); busy(true); try { await this.net.host(); $('mpErr').textContent = ''; show('menu', false); show('lobby', true); this.lobby(); } catch (e) { err(e); } busy(false); };
    $('btnJoin').onclick = async () => {
      const code = $<HTMLInputElement>('mpCode').value.trim(); if (code.length < 4) { $('mpErr').textContent = 'Enter the room code you got from the host.'; return; }
      this.audio.init(); busy(true);
      try { await this.net.join(code); this.net.send({ t: 'hello', name: S.name || 'Player' }); $('mpErr').textContent = ''; show('menu', false); show('lobby', true); this.lobby(); } catch (e) { err(e); this.net.close(); }
      busy(false);
    };
    $('btnLeave').onclick = () => this.toMenu();
    $('btnLobbyStart').onclick = () => { this.audio.init(); this.newRound(+($('lobbyMission') as HTMLSelectElement).value); };
    const sel = $('lobbyMission') as HTMLSelectElement; sel.innerHTML = MISSIONS.map((m, i) => `<option value="${i}">Mission ${i + 1}: ${m.name}</option>`).join(''); sel.onchange = () => this.lobby();
    this.net.onPeers = () => {
      if (this.net.role !== 'host') return;
      if (this.sim && (this.state === 'play' || this.state === 'pause')) for (const [c, i] of this.connIdx) if (!this.net.conns.includes(c)) { const pa = this.sim.players[i]; this.connIdx.delete(c); if (pa?.alive) { pa.alive = false; pa.hp = 0; this.log(`${pa.name} left the game.`, 'warn'); this.sim.checkPlayers(); } }
      this.lobby();
    };
    this.net.onClosed = why => { if (!this.net.online) return; this.toMenu(); $('mpErr').textContent = why; };
    this.net.onMsg = (c, m) => { if (this.net.role === 'host') this.fromClient(c, m); else this.fromHost(m); };
    $('btnTts').onclick = () => { this.audio.init(); setTimeout(() => { $('latInfo').textContent = this.audio.latencyMs ? `Audio latency reported by the browser: ${this.audio.latencyMs} ms.` : ''; }, 300); const n = this.speech.voiceCount; if (!this.speak('Copy, following you.', null, { voice: 'o1' })) this.speech.say('Team A, copy. Following you.', 1, 1.1, 1, true); $('ttsInfo').textContent = n === 0 ? 'The browser has no speech voices – lines without a recorded clip stay silent. Install a voice in the operating system’s speech settings or use Chrome/Edge.' : this.speech.hasLangVoice ? `${n} voices found. Hear nothing? Check the volume and that the tab is not muted.` : `${n} voices found, but none in the chosen language – the browser's default voice is used.`; };
  }
  lobbyMe = 0;
  lobby() {
    const host = this.net.role === 'host';
    if (host) {
      this.lobbyNames = [S.name || 'Host', ...this.net.conns.map((c, i) => this.connName.get(c) || 'Player ' + (i + 2))]; this.lobbyMission = +($('lobbyMission') as HTMLSelectElement).value;
      this.net.broadcast({ t: 'lobby', names: this.lobbyNames, ids: [this.net.id, ...this.net.conns.map(c => c.peer)], mission: this.lobbyMission });
    }
    $('lobbyCode').textContent = this.net.code;
    $('lobbyPlayers').innerHTML = (this.lobbyNames.length ? this.lobbyNames : ['Connecting…']).map((n, i) => `<li>${n.replace(/[<>&]/g, '')}${i === 0 ? ' <em>host</em>' : ''}${i === (host ? 0 : this.lobbyMe) ? ' <em class="you">you</em>' : ''}</li>`).join('');
    const hostName = (this.lobbyNames[0] || 'the host').replace(/[<>&]/g, '');
    $('lobbyTitle').textContent = host ? 'Your room – you are the host' : 'You have joined ' + hostName + '’s room';
    $('btnCopy').classList.toggle('hidden', !host);
    $('lobbyWait').classList.toggle('hidden', host);
    $('lobbyWait').textContent = 'Connected ✔  Waiting for ' + hostName + ' to press «Start mission». You do not need to do anything.';
    $('lobbySelLabel').textContent = host ? 'Mission' : 'Mission (the host chooses)';
    ($('lobbyMission') as HTMLSelectElement).disabled = !host; if (!host) ($('lobbyMission') as HTMLSelectElement).value = String(this.lobbyMission);
    $('btnLobbyStart').classList.toggle('hidden', !host);
    $('lobbyInfo').textContent = (host ? 'Give the room code to your friends. Up to 4 players. Start when everyone is in.' : 'The game starts automatically for you when the host starts.') + (this.net.micOk ? ' Voice chat is on – you can hear each other right away.' : this.net.stream ? ' Your microphone is not available – you hear the others but they cannot hear you.' : ' Allow the microphone in the browser prompt to join the voice chat.');
  }
  fromHost(m: Msg) {
    const sim = this.sim;
    if (m.t === 'lobby') { this.lobbyMe = (m.ids as string[]).indexOf(this.net.id); this.lobbyNames = m.names; this.lobbyMission = m.mission; this.net.callPeers(m.ids); if (!$('lobby').classList.contains('hidden')) this.lobby(); }
    else if (m.t === 'start') { this.start(m.mission, m.seed, m.n, m.you, m.diff, m.names); }
    else if (m.t === 'snap' && sim && (this.state === 'play' || this.state === 'pause')) applySnap(sim, m.s, sim.player);
    else if (m.t === 'ev' && sim && (this.state === 'play' || this.state === 'pause')) for (const e of m.e) this.handle(decodeEv(sim, e));
  }
  fromClient(c: DataConnection, m: Msg) {
    if (m.t === 'hello') { this.connName.set(c, String(m.name || 'Player').slice(0, 12)); this.lobby(); return; }
    const sim = this.sim, i = this.connIdx.get(c); if (!sim || !i || sim.over) return; const pa = sim.players[i]; if (!pa || !pa.alive) return;
    const num = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    switch (m.t) {
      case 'in': { const x = num(m.x), z = num(m.z), d = Math.hypot(x - pa.x, z - pa.z); if (d < 3 && !sim.solidCell(Math.floor(x), Math.floor(z))) { pa.x = x; pa.z = z; pa.walk += d * 2.4; sim.pushTrail(pa); } pa.yaw = num(m.yaw); pa.pitch = num(m.pitch); pa.crouch = !!m.cr; pa.prone = !!m.pr; pa.jumpY = Math.max(0, Math.min(0.8, num(m.jy))); pa.moving = !!m.mv; break; }
      case 'fire': sim.fire(pa, num(m.o[0]), num(m.o[1]), num(m.o[2]), num(m.d[0]), num(m.d[1]), num(m.d[2]), Math.min(34, num(m.dmg)), { nonLethal: !!m.nl, taser: !!m.ts }); break;
      case 'use': sim.playerUse(pa); break;
      case 'c2': sim.playerC2(pa); break;
      case 'wedge': sim.playerWedge(pa); break;
      case 'peek': sim.playerPeek(pa); break;
      case 'shout': sim.playerShout(pa); break;
      case 'bang': if (pa.bangs > 0) { pa.bangs--; sim.throwBang(num(m.o[0]), num(m.o[1]), num(m.o[2]), num(m.d[0]), num(m.d[1]), num(m.d[2])); } break;
      case 'cmd': sim.command(m.cmd, m.aim ?? null, pa); break;
    }
  }
  get mirror() { return this.net.role === 'client'; }
  lock() { if (!AUTO) { const p: any = $('c').requestPointerLock(); if (p?.catch) p.catch(() => { }); } }
  resume() { show('pause', false); this.state = 'play'; this.lock(); if (S.mic) this.voice.start(); this.last = performance.now(); }
  pause() { if (this.state !== 'play') return; this.state = 'pause'; show('pause', true); this.micState(this.voice.state); this.keys.clear(); this.mouseDown = false; }

  // ---------------- mission start ----------------
  private starting = false;
  async start(mission: number, seed: number, n = 1, me = 0, diff: number = S.diff, names: string[] = []) {
    if (this.starting) return;
    this.starting = true;
    const setLoad = (pct: number, msg: string) => {
      $('loadFill').style.width = `${pct}%`;
      $('loadStatus').textContent = msg;
    };
    const nextFrame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
    const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<void>(r => setTimeout(r, ms))]);
    try {
      $('loadTitle').textContent = 'Loading...';
      $('loadMission').textContent = MISSIONS[mission]?.name ?? 'Operation';
      setLoad(18, 'Loading 3D props, weapons & squad models...');
      for (const id of ['lobby', 'debrief', 'pause', 'brief']) show(id, false);
      show('loading', true);
      await nextFrame();
      await nextFrame();
      await withTimeout(assetsDone, 10000);
      setLoad(62, 'Building operation environment...');
      await nextFrame();

      this.mission = mission; this.seed = seed; this.audio.init();
      const sim = this.sim = new Sim(mission, seed, diff, n); if (me) sim.player = sim.players[me];
      sim.players.forEach((pl, i) => { if (names[i]) pl.name = names[i]; }); this.stepPh.clear();
      const mp = this.net.online; $('btnRestart').classList.toggle('hidden', mp); $('btnAgain').classList.toggle('hidden', this.net.role === 'client'); $('btnNext').classList.toggle('hidden', this.net.role === 'client'); show('vc', mp);
      this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x070a10); this.scene.fog = new THREE.FogExp2(0x070a10, 0.016);
      if (S.qual > 0) { this.scene.environment = studioEnv(this.renderer); this.scene.environmentIntensity = 0.28; }
      this.ambLight = new THREE.AmbientLight(0x9fb0c8, S.qual ? 0.45 : 1.1);
      this.nvgLight = new THREE.AmbientLight(0x6aff99, 0);
      this.scene.add(this.ambLight, this.nvgLight, new THREE.HemisphereLight(0xb8c8ff, 0x2a241c, 0.55));
      const moon = new THREE.DirectionalLight(0xa8c0ff, 0.7); moon.position.set(-8, 14, 6); this.scene.add(moon);
      this.level?.dispose();
      this.level = new LevelView(sim, S.qual); this.scene.add(this.level.group);
      this.fx = new FX(); this.scene.add(this.fx.group);
      this.views.clear(); for (const a of sim.actors) { if (a === sim.player) continue; const v = new ActorView(a); this.views.set(a, v); this.scene.add(v.root); }
      this.scene.add(this.camera); this.camera.add(this.torch); this.torch.position.set(0.15, -0.1, 0); this.camera.add(this.torch.target); this.torch.target.position.set(0, 0, -1);
      sim.player.shield = S.primary === 'shield';
      const ws = this.weaponSpecs;
      this.yaw = sim.player.yaw; this.pitch = 0; this.weapon = 0; this.ammo = [ws[0].mag, ws[1].mag]; this.reserve = [ws[0].res, ws[1].res]; this.reloadT = 0; this.fireCd = 0; this.recoil = 0; this.dmgFx = 0; this.endT = 0;
      this.nvgOn = false; this.bodycamOn = false; this.wheelOn = false; show('nvg', false); show('bodycam', false); show('wheel', false); this.renderer.toneMappingExposure = 1.15;
      this.selTeam = this.lastTeam = 'ALL'; this.lastWho = null;
      setLoad(86, 'Staging armored transport & gear...');
      await withTimeout(this.level.whenReady(), 8000);
      setLoad(100, 'Deployment ready.');
      await nextFrame();
      this.state = 'play'; this.last = performance.now(); $('log').innerHTML = ''; $('heard').textContent = ''; $('parsed').textContent = '';
      this.ai.resetHistory();
      this.buildMap(); show('loading', false); show('menu', false); show('hud', true); this.updateHud(true);
      if (S.mic && !AUTO) this.voice.start();
      if (S.ai && !mp && !AUTO) void this.ai.ensureLoaded(S.aiModel);
      this.aiState(this.ai.state, this.ai.state === 'loading' ? this.ai.progress : this.ai.error);
      if (mp && !document.pointerLockElement) this.log('Click in the game to take control of the mouse.', 'warn');
      this.log(`Command: ${MISSIONS[mission].name} (${ws[0].name} + ${ws[1].name}). Give orders with your voice or press H for wheel.`, 'me');
    } finally {
      show('loading', false);
      this.starting = false;
    }
  }

  // ---------------- input ----------------
  bindInput() {
    const c = $('c');
    c.addEventListener('click', () => { if (this.state === 'play' && !document.pointerLockElement) this.lock(); });
    document.addEventListener('pointerlockchange', () => { if (!document.pointerLockElement && this.state === 'play' && !AUTO && !this.typing && !this.wheelOn) this.pause(); });
    document.addEventListener('mousemove', e => {
      if (this.state !== 'play' || (!document.pointerLockElement && !AUTO)) return;
      const k = 0.0022 * S.sens * (1 - this.aimK * 0.5); this.yaw -= e.movementX * k; this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - e.movementY * k));
      this.sway.x += e.movementX * 0.00012; this.sway.y += e.movementY * 0.00012;
    });
    document.addEventListener('mousedown', e => { if (this.state !== 'play' || !document.pointerLockElement) return; if (e.button === 0) { this.mouseDown = true; const sp = this.sim?.player; const ws = this.weaponSpecs[this.weapon]; if (sp?.alive && !this.typing && !this.wheelOn && this.fireCd <= 0 && this.reloadT <= 0 && this.ammo[this.weapon] > 0 && !this.semiLock && !this.preShot && !ws.taser) { this.preShot = true; this.audio.shot(0, 0, true, this.weapon === 0 && !ws.shield ? 'rifle' : 'pistol'); } } if (e.button === 1) { e.preventDefault(); this.shout(true); } if (e.button === 2) this.ads = true; });
    document.addEventListener('contextmenu', e => { if (this.state === 'play') e.preventDefault(); });
    document.addEventListener('mouseup', e => { if (e.button === 0) { this.mouseDown = false; this.semiLock = false; } if (e.button === 2) this.ads = false; });
    document.addEventListener('keydown', e => {
      if (this.typing) { if (e.code === 'Enter') { const inp = $<HTMLInputElement>('cmdinput'); const v = inp.value.trim(); inp.value = ''; this.setTyping(false); if (v) this.heard(v, false); e.preventDefault(); } else if (e.code === 'Escape') this.setTyping(false); return; }
      if (e.code === 'Escape') { if (this.wheelOn) { this.toggleWheel(false); this.lock(); return; } if (!$('help').classList.contains('hidden') || !$('settings').classList.contains('hidden')) { show('help', false); show('settings', false); } else if (this.state === 'pause') this.resume(); else if (this.state === 'play' && AUTO) this.pause(); return; }
      if (this.state !== 'play') return;
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
      if (e.repeat) return; this.keys.add(e.code); this.onKey(e.code);
    });
    document.addEventListener('keyup', e => { this.keys.delete(e.code); if (e.code === 'KeyV') this.voice.release(); });
    window.addEventListener('blur', () => { this.voice.release(); this.keys.clear(); this.mouseDown = false; });
  }
  setTyping(on: boolean) { this.typing = on; show('cmdbox', on); const inp = $<HTMLInputElement>('cmdinput'); if (on) { this.keys.clear(); inp.focus(); } else inp.blur(); }
  onKey(code: string) {
    const sim = this.sim!; if (sim.over) return;
    const quick: Record<string, Command['action'] | 'there'> = { Digit3: 'follow', Digit4: 'hold', Digit5: 'there', Digit6: 'cover', Digit7: 'stack', Digit8: 'breach', Digit9: 'bang', Digit0: 'restrain' };
    switch (code) {
      case 'KeyF': if (this.mirror) this.net.send({ t: 'use' }); else sim.playerUse(); break;
      case 'KeyE': if (this.mirror) this.net.send({ t: 'peek' }); else { const msg = sim.playerPeek(sim.player); if (msg) { this.log(msg, 'me'); this.audio.ui(); } } break;
      case 'KeyU': if (this.mirror) this.net.send({ t: 'c2' }); else sim.playerC2(sim.player); break;
      case 'KeyY': if (this.mirror) this.net.send({ t: 'wedge' }); else if (sim.playerWedge(sim.player)) this.audio.wedge(); break;
      case 'KeyN': this.toggleNvg(); break;
      case 'KeyK': this.toggleBodycam(); break;
      case 'KeyH': this.toggleWheel(); if (!this.wheelOn) this.lock(); break;
      case 'KeyB': if (this.net.online) { this.net.setMuted(!this.net.muted); this.audio.ui(); } break;
      case 'KeyR': this.reload(); break;
      case 'KeyG': this.throwBang(); break;
      case 'KeyV': if (S.ptt && S.mic) { if (this.voice.state !== 'listening' && this.voice.state !== 'starting') { this.voice.stop(); this.voice.start(); } if (!this.voice.held) $('heard').textContent = ''; this.voice.press(); } else this.shout(true); break;
      case 'KeyQ': this.shout(true); break;
      case 'KeyT': this.torchOn = !this.torchOn; this.audio.dry(); break;
      case 'KeyM': this.mapOn = !this.mapOn; break;
      case 'KeyC': if (sim.player.prone) { sim.player.prone = false; sim.player.crouch = true; } else sim.player.crouch = !sim.player.crouch; break;
      case 'KeyZ': sim.player.prone = !sim.player.prone; sim.player.crouch = false; break;
      case 'KeyX': this.slow = !this.slow; this.audio.ui(); break;
      case 'Space': { const pl = sim.player; if (pl.prone || pl.crouch) { pl.prone = false; pl.crouch = false; } else if (pl.jumpY <= 0 && pl.alive) this.jumpV = 3.4; break; }
      case 'Digit1': case 'Digit2': { const w = code === 'Digit1' ? 0 : 1; if (w !== this.weapon) { this.weapon = w; this.reloadT = 0; this.fireCd = 0.35; this.vmKick = -0.5; this.audio.draw(); if (!this.weaponSpecs[w].shield) this.arms.draw(); } break; }
      case 'Tab': this.selTeam = this.selTeam === 'ALL' ? 'A' : this.selTeam === 'A' ? 'B' : 'ALL'; this.audio.ui(); this.updateHud(true); break;
      case 'Enter': this.setTyping(true); break;
      default: if (quick[code]) { const q = quick[code]; this.exec(q === 'there' ? { team: this.selTeam, action: 'move', dir: 'there' } : { team: this.selTeam, action: q }, true); }
    }
  }

  // ---------------- commands ----------------
  lastSay = ''; lastSayT = 0; lastInfo = ''; lastInfoT = 0; micS = ''; micD: string | undefined;
  aiState(s: AiState, detail = '') {
    const badge = $('aibadge'), info = $('aiInfo');
    const mp = this.net.online;
    if (!S.ai || mp) {
      badge.className = 'hidden';
      badge.textContent = '';
      if (mp && S.ai) { info.className = 'note'; info.textContent = 'AI Brain is paused in online mode (using the fast command parser).'; }
      else if (s === 'unsupported' || s === 'error') { info.className = 'note warn'; info.textContent = detail; }
      else { info.className = 'note'; info.textContent = TacticalAi.hasWebGpu ? 'AI Brain is off. Turn it on for full natural-language understanding and radio relays in Solo mode (runs in browser, no API).' : 'WebGPU is not available in this browser – the fast built-in parser is used automatically.'; }
      return;
    }
    badge.classList.remove('hidden');
    if (s === 'ready') {
      badge.className = 'ready'; badge.textContent = 'AI READY';
      info.className = 'note'; info.textContent = `AI model (${this.ai.modelId}) is loaded and ready for Solo mode.`;
    } else if (s === 'loading') {
      badge.className = ''; badge.textContent = 'AI LOADING…';
      info.className = 'note'; info.textContent = detail || 'Loading AI model into browser cache…';
    } else if (s === 'unsupported' || s === 'error') {
      badge.className = 'err'; badge.textContent = 'AI UNAVAILABLE';
      info.className = 'note warn'; info.textContent = detail || 'Could not start the AI model; falling back to the built-in parser.';
    } else {
      badge.className = ''; badge.textContent = 'AI WAITING';
      info.className = 'note'; info.textContent = 'Click «Load AI model now» or start a Solo mission to load the model.';
    }
  }
  /** Speaks a line as a given character: recorded clip with a per-character voice, else the browser's speech synthesis. */
  speak(text: string, a: Actor | null, o: { gain?: number; pan?: number; muffle?: boolean; pitch?: number; rate?: number; voice?: string } = {}) {
    if (!S.tts) return 0;
    let clean = text.replace(/^Team [AB]: /, ''); const kind = a?.kind ?? 'player';
    if (clean === SHOUTS[0]) clean = SHOUTS[Math.floor(Math.random() * SHOUTS.length)]; // a challenge is never yelled the same way twice in a row
    // every character has a voice of its own (the voice matches the figure: women sound like women)
    const voice = o.voice ?? (kind === 'officer' ? 'o' + ((a!.slot % 4) + 1) : kind === 'suspect' ? ['s1', 's2', 's4', 's3', 's5'][a!.id % 5] : kind === 'civ' ? 'c' + ((a!.id % 5) + 1) : 'p1');
    const rate = kind === 'player' && a && a !== this.sim?.player ? 0.94 + (a.pi % 3) * 0.06 : 1, loud = this.audio.isShout(clean);
    const ms = this.audio.line(clean, { voice, rate, radio: kind === 'officer' && !loud, gruff: kind === 'suspect', shout: loud, gain: o.gain ?? 1, pan: o.pan, muffle: o.muffle });
    if (ms) this.speech.busy(ms); else this.speech.say(text, o.pitch ?? 1, o.rate ?? 1.2, o.gain ?? 0.9);
    return ms;
  }
  heard(text: string, fromMic: boolean) {
    if (this.state !== 'play' || !this.sim) return;
    if (fromMic && !S.head && !S.ptt && this.speech.speaking) { // don't let the team's own radio voice trigger orders
      $('heard').textContent = '« ' + text.split('|')[0].trim() + ' »'; const q = $('parsed'); q.className = 'bad'; q.textContent = 'Ignored – the team was talking at the same time (say it again)'; this.parsedT = 4; return;
    }
    const alts = text.split('|').map(s => s.trim()).filter(Boolean);
    let bestAlt = alts[0] || '';
    let batch = parseCommands(bestAlt, this.lastTeam, this.lastWho);
    for (const a of alts) {
      const b = parseCommands(a, this.lastTeam, this.lastWho);
      if (b.commands.length) { batch = b; bestAlt = a; break; }
    }
    $('heard').textContent = '« ' + bestAlt + ' »'; this.parsedT = 4;
    const p = $('parsed');

    // Use browser WebGPU AI Brain in Solo mode for conversational/relay/unrecognized input when ready
    if (!this.net.online && S.ai && this.ai.state === 'ready' && shouldUseAiBrain(bestAlt, batch)) {
      if (this.ai.busy) { p.className = 'bad'; p.textContent = 'AI is still thinking…'; return; }
      p.className = ''; p.textContent = 'AI THINKING…'; this.parsedT = 12;
      void this.askAiBrain(bestAlt, !fromMic);
      return;
    }

    if (!batch.commands.length) {
      p.className = 'bad';
      p.textContent = (!this.net.online && S.ai && this.ai.state === 'loading') ? 'AI loading… (simple orders work meanwhile)' : 'No order recognised';
      this.audio.fail(); return;
    }
    this.execBatch(batch, !fromMic);
  }
  async askAiBrain(text: string, byKey: boolean) {
    const sim = this.sim; if (!sim) return;
    const res: AiResult = await this.ai.interpret(text, sim, this.lastTeam, this.lastWho);
    if (this.sim !== sim || this.state !== 'play' || sim.over) return;
    this.applyAiResult(sim, res, byKey);
  }
  private fmtCmdLabel(sim: Sim, cmd: Command): string {
    const one = cmd.who != null ? sim.officers[cmd.who] : null;
    const tname = one ? one.name.toUpperCase() : cmd.team === 'ALL' ? 'ALL' : 'TEAM ' + cmd.team;
    if (cmd.action === 'joinTeam') return `${tname} › JOIN TEAM ${cmd.team === 'B' ? 'B' : 'A'}`;
    return `${tname} › ${ACTION_LABEL[cmd.action]}${cmd.action === 'move' && cmd.dir ? ' ' + DIR_LABEL[cmd.dir] : ''}`;
  }
  applyAiResult(sim: Sim, res: AiResult, byKey: boolean) {
    const p = $('parsed'); p.className = ''; this.parsedT = 5;
    const labels: string[] = [];
    const aim = this.aimPoint();
    let anyOk = false;
    for (const cmd of res.commands) {
      if (cmd.action === 'shout') { labels.push(ACTION_LABEL.shout); this.shout(byKey); anyOk = true; continue; }
      labels.push(this.fmtCmdLabel(sim, cmd));
      if (sim.command(cmd, aim, sim.player, { quiet: true })) anyOk = true;
      const one = cmd.who != null ? sim.officers[cmd.who] : null;
      this.lastTeam = one ? one.team : cmd.team;
      this.selTeam = this.lastTeam;
      this.lastWho = cmd.who ?? null;
    }
    const speaker = (sim.officers[res.speaker]?.alive ? sim.officers[res.speaker] : sim.officers.find(o => o.alive)) ?? null;
    p.textContent = labels.length ? `AI › ${labels.join(' · ')}` : `AI › ${speaker ? speaker.name.toUpperCase() : 'SWAT'} RADIO`;
    if (res.commands.length && !anyOk) this.audio.fail(); else this.audio.ok();
    if (speaker && res.reply) sim.say(speaker, res.reply);
    if (res.relayTo != null && res.relayMsg) {
      setTimeout(() => {
        if (this.sim !== sim || this.state !== 'play' || sim.over) return;
        let receiver: Actor | undefined;
        if (typeof res.relayTo === 'number') receiver = sim.officers[res.relayTo];
        else if (res.relayTo === 'A' || res.relayTo === 'B') receiver = sim.officers.find(o => o.alive && o.team === res.relayTo && o !== speaker);
        else receiver = sim.officers.find(o => o.alive && o !== speaker);
        if (speaker?.alive) sim.say(speaker, res.relayMsg!);
        if (receiver?.alive && receiver !== speaker && res.commands.length) {
          setTimeout(() => { if (this.sim === sim && this.state === 'play' && !sim.over && receiver!.alive) sim.say(receiver!, 'Copy that, moving!'); }, 700);
        }
      }, 650);
    }
    this.updateHud(true);
  }
  execBatch(batch: { commands: Command[]; relayFrom?: number }, byKey: boolean) {
    const sim = this.sim!;
    if (batch.relayFrom != null) {
      const sender = sim.officers[batch.relayFrom];
      if (sender?.alive) sim.say(sender, 'Copy, relaying order!');
    }
    const labels: string[] = [];
    const aim = this.aimPoint();
    let anyOk = false;
    for (let i = 0; i < batch.commands.length; i++) {
      const cmd = batch.commands[i];
      if (cmd.action === 'shout') { labels.push(ACTION_LABEL.shout); this.shout(byKey); anyOk = true; continue; }
      const one = cmd.who != null ? sim.officers[cmd.who] : null;
      labels.push(this.fmtCmdLabel(sim, cmd));
      if (this.mirror) { this.net.send({ t: 'cmd', cmd, aim }); anyOk = true; }
      else if (sim.command(cmd, aim, sim.player)) anyOk = true;
      else this.log(one ? `${one.name} is down.` : 'Nobody on that team can answer.', 'warn');
      this.lastTeam = one ? one.team : cmd.team;
      this.selTeam = this.lastTeam;
      this.lastWho = cmd.who ?? null;
    }
    const p = $('parsed'); p.className = ''; this.parsedT = 4;
    p.textContent = labels.join(' · ');
    if (anyOk) this.audio.ok(); else this.audio.fail();
    this.updateHud(true);
  }
  exec(cmd: Command, byKey: boolean) {
    this.execBatch({ commands: [cmd] }, byKey);
  }
  aimDir() { const cp = Math.cos(this.pitch); return new THREE.Vector3(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp); }
  aimPoint() { const sim = this.sim!, p = sim.player, d = this.aimDir(); const h = sim.ray(p.x, this.eye, p.z, d.x, d.y, d.z, 40, p); return h.kind === 'none' ? null : { x: h.x - d.x * 0.4, z: h.z - d.z * 0.4 }; }
  private shoutT = 0;
  shout(tts: boolean) {
    const sim = this.sim!; if (!sim.player.alive) return; if (this.mirror) this.net.send({ t: 'shout' }); else sim.playerShout();
    void tts; const now = performance.now(); if (now - this.shoutT > 900) { this.shoutT = now; this.speak(SHOUTS[0], null, { pitch: 0.7, rate: 1.3, gain: 1 }); } // your own voice yells the challenge, also when you gave it by microphone
    this.log('YOU: Police! Drop the weapon!', 'me');
  }
  reload() { const w = this.weaponSpecs[this.weapon]; if (this.reloadT > 0 || this.ammo[this.weapon] >= w.mag || this.reserve[this.weapon] <= 0) return; this.reloadT = w.reload; if (!w.shield) this.arms.reload(w.reload); this.audio.reload(this.weapon === 0 && !w.shield ? 'rifle' : 'pistol', w.reload); }
  throwBang() {
    const sim = this.sim!, p = sim.player; if (p.bangs <= 0 || !p.alive) return; const d = this.aimDir(), o = [p.x + d.x * 0.4, this.eye - 0.1, p.z + d.z * 0.4];
    if (this.mirror) this.net.send({ t: 'bang', o, d: [d.x, d.y, d.z] }); else { p.bangs--; sim.throwBang(o[0], o[1], o[2], d.x, d.y, d.z); } this.vmKick = -0.6;
  }
  menu = new MenuScene(); menuT = 0; arms = new FpsArms();
  ads = false; aimK = 0; // aiming down the sights (hold right mouse button)
  slow = false; jumpV = 0; // sneak toggle, vertical jump speed
  preShot = false; // own shot sound already played in the mouse click
  fire() {
    const sim = this.sim!, w = this.weaponSpecs[this.weapon], p = sim.player;
    if (this.ammo[this.weapon] <= 0) { if (!this.semiLock) { this.audio.dry(); this.semiLock = true; this.reload(); } return; }
    this.ammo[this.weapon]--; this.fireCd = w.rate;
    const moving = this.keys.has('KeyW') || this.keys.has('KeyA') || this.keys.has('KeyS') || this.keys.has('KeyD');
    const sp = (w.spread * (moving ? 2.6 : 1) * (p.crouch ? 0.6 : 1) + this.recoil * 0.25) * (1 - this.aimK * 0.65);
    const pellets = w.pellets ?? 1;
    for (let i = 0; i < pellets; i++) {
      const d = this.aimDir();
      d.x += (Math.random() - 0.5) * sp * 2; d.y += (Math.random() - 0.5) * sp * 2; d.z += (Math.random() - 0.5) * sp * 2; d.normalize();
      if (this.mirror) { this.net.send({ t: 'fire', o: [p.x, this.eye, p.z], d: [d.x, d.y, d.z], dmg: w.dmg, nl: !!w.nonLethal, ts: !!w.taser }); }
      else sim.fire(p, p.x, this.eye, p.z, d.x, d.y, d.z, w.dmg, { nonLethal: !!w.nonLethal, taser: !!w.taser });
    }
    if (this.mirror && !this.preShot && !w.taser) this.audio.shot(0, 0, true, this.weapon === 0 && !w.shield ? 'rifle' : 'pistol');
    this.preShot = false;
    this.recoil = Math.min(0.11, this.recoil + w.kick); this.pitch = Math.min(1.45, this.pitch + w.kick * 0.55); this.yaw += (Math.random() - 0.5) * w.kick * 0.5; this.vmKick = 1; if (!w.shield) this.arms.fire();
    if (!w.taser) { this.vm.flash.visible = true; this.vm.flash.material.rotation = Math.random() * 6; setTimeout(() => { this.vm.flash.visible = false; }, 45); }
  }

  // ---------------- events ----------------
  pan(x: number, z: number) { const p = this.sim!.player, dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz) || 1; return { d, pan: ((dx * Math.cos(this.yaw) - dz * Math.sin(this.yaw)) / d) * Math.min(1, d / 3) }; }
  log(text: string, cls = '') { const el = document.createElement('div'); el.className = cls; el.textContent = text; const box = $('log'); box.appendChild(el); while (box.children.length > 6) box.firstChild!.remove(); setTimeout(() => el.remove(), 7000); }
  handle(e: Ev) {
    const sim = this.sim!, p = sim.player, fx = this.fx;
    switch (e.t) {
      case 'shot': {
        const own = e.by === p, a = new THREE.Vector3(e.x, e.y, e.z), b = new THREE.Vector3(e.x2, e.y2, e.z2);
        if (own) { const r = fwd(this.yaw); a.set(p.x + r.x * 0.5 - r.z * 0.12, this.eye - 0.12, p.z + r.z * 0.5 + r.x * 0.12); } else this.views.get(e.by)?.muzzle();
        fx.tracer(a, b); const pn = this.pan(e.x, e.z);
        if (own && this.preShot) this.preShot = false;
        else if (!(own && this.mirror)) this.audio.shot(pn.d, pn.pan, own, own ? (this.weapon === 0 && !this.weaponSpecs[0].shield ? 'rifle' : 'pistol') : e.by.kind === 'suspect' ? 'smg' : 'rifle');
        fx.flashAt(a.x, a.y, a.z, own ? 14 : 22);
        if (e.hit === 'wall') { fx.burst(e.x2, e.y2, e.z2, 7, 0xb8b0a0, 2.2, 6, 0.35); fx.burst(e.x2, e.y2, e.z2, 2, 0xffd080, 4, 9, 0.15); fx.hole(e.x2 - (e.x2 - e.x) * 0.002, e.y2, e.z2 - (e.z2 - e.z) * 0.002); const q = this.pan(e.x2, e.z2); if (q.d < 12) this.audio.impact(q.d, q.pan); }
        else if (e.hit === 'actor') fx.burst(e.x2, e.y2, e.z2, 12, 0x8a0f0f, 2.4, 7, 0.5);
        break;
      }
      case 'taser': {
        const a = new THREE.Vector3(e.x, e.y, e.z), b = new THREE.Vector3(e.x2, e.y2, e.z2);
        fx.tracer(a, b, 0x50d8ff);
        const pn = this.pan(e.x, e.z); this.audio.taser(pn.d, pn.pan);
        fx.burst(e.x2, e.y2, e.z2, 10, 0x60e0ff, 2.4, 7, 0.45);
        break;
      }
      case 'c2': { const q = this.pan(e.x, e.z); this.audio.c2(q.d, q.pan); fx.flashAt(e.x, 1.2, e.z, 600, 0.12, 0xffa848); fx.burst(e.x, 1.1, e.z, 45, 0xffb860, 6, 4, 0.6); fx.burst(e.x, 1.1, e.z, 25, 0x8a6d48, 4, 6, 0.9); break; }
      case 'glass': { const q = this.pan(e.x, e.z); this.audio.glass(q.d, q.pan); fx.burst(e.x, 1.5, e.z, 28, 0xb8e8ff, 4.2, 7, 0.7); break; }
      case 'break': {
        const q = this.pan(e.x, e.z);
        if (e.kind === 'pc') {
          this.audio.glass(q.d, q.pan); this.audio.impact(q.d, q.pan);
          fx.flashAt(e.x, e.y, e.z, 18, 0.08, 0x70c8ff);
          fx.burst(e.x, e.y, e.z, 18, 0x70c8ff, 3.6, 6, 0.45);
          fx.burst(e.x, e.y, e.z, 14, 0xffaa44, 4.4, 8, 0.35);
          fx.burst(e.x, e.y, e.z, 12, 0x1a2028, 2.5, 7, 0.6);
        } else if (e.kind === 'server') {
          this.audio.impact(q.d, q.pan);
          fx.flashAt(e.x, e.y, e.z, 22, 0.09, 0x40e890);
          fx.burst(e.x, e.y, e.z, 20, 0x40e890, 4.2, 6, 0.4);
          fx.burst(e.x, e.y, e.z, 16, 0xffc040, 4.6, 8, 0.35);
        } else {
          this.audio.glass(q.d, q.pan);
          fx.burst(e.x, e.y, e.z, 20, 0xb8e8ff, 3.6, 7, 0.6);
          fx.burst(e.x, e.y, e.z, 12, 0x3b6e35, 2.8, 7, 0.6);
        }
        break;
      }
      case 'power': { if (this.ambLight) this.ambLight.intensity = e.on ? (S.qual ? 0.45 : 1.1) : 0.1; this.audio.nvg(!e.on); this.log(e.on ? 'Power restored.' : 'Building power cut! NVG (N) or Flashlight (T) recommended.', 'me'); break; }
      case 'bomb': { if (e.kind === 'defused') { this.audio.defuse(); this.log('Explosive device disarmed!', 'me'); } else { this.audio.c2(0, 0); fx.flashAt(e.x, 1, e.z, 900, 0.2, 0xff4020); this.log('Explosive detonated!', 'warn'); } break; }
      case 'hurt': this.views.get(e.a)?.wound(); if (e.a === p) { this.dmgFx = 1; this.audio.hurt(); this.recoil += 0.03; } else if (e.a.kind !== 'officer') { /* hit marker only for own shots handled below */ } break;
      case 'death': if (e.a !== p) { fx.burst(e.a.x, 1.1, e.a.z, 26, 0x8a0f0f, 2.6, 8, 0.7); fx.burst(e.a.x, 0.5, e.a.z, 14, 0x6a0808, 1.4, 6, 0.9); } if (e.a.kind === 'officer') this.log(`${e.a.name} has been killed.`, 'warn'); break;
      case 'door': { const q = this.pan(e.door.cx + 0.5, e.door.cz + 0.5); this.audio.door(q.d, q.pan, e.open, !!e.kick); break; }
      case 'say': {
        const o = e.a; this.log(`${o.name}: ${e.text.replace(/^Team [AB]: /, '')}`, o.team);
        // an order to both teams gives one spoken reply, not the same sentence twice
        const key = e.text.replace(/^Team [AB]: /, ''), now = performance.now(), dup = !e.shout && key === this.lastSay && now - this.lastSayT < 2500; this.lastSay = key; this.lastSayT = now;
        if (dup) break;
        this.audio.radio();
        if (!e.shout || Math.random() < 0.6) this.speak(e.text, o, { pitch: [0.85, 1.25, 0.65, 1.05][o.slot] ?? 1, rate: e.shout ? 1.35 : 1.2, gain: e.shout ? 1 : 0.85 });
        break;
      }
      case 'bang': { const q = this.pan(e.x, e.z); this.audio.bang(q.d, q.pan, p.flash); fx.flashAt(e.x, 1, e.z, 900, 0.12, 0xffffff); fx.burst(e.x, 0.3, e.z, 60, 0xffffff, 7, 3, 0.5); fx.burst(e.x, 0.3, e.z, 30, 0x999999, 2, -0.5, 1.6); break; }
      case 'throw': this.audio.step(0.3); break;
      case 'shout': if (e.a !== p) { this.log(`${e.a.name}: Police! Drop the weapon!`, ''); const q = this.pan(e.a.x, e.a.z); if (!this.audio.hasLine(SHOUTS[0]) || !S.tts) this.audio.vocal('shout', 0.9, q.d, q.pan); else this.speak(SHOUTS[0], e.a, { gain: 1 / (1 + q.d * 0.1), pan: q.pan }); } break;
      case 'bark': {
        const a = e.a, q = this.pan(a.x, a.z); if (q.d > 22) break;
        const near = sim.los(p.x, p.z, a.x, a.z) ? 1 : 0.45, pitch = (a.kind === 'civ' ? 1.25 : 0.85) + (a.variant % 3) * 0.12;
        const d2 = q.d / near; // muffled through walls
        const clip = !!S.tts && this.audio.linesReady; // recorded lines replace the synthetic shout
        const pick = (l: string[]) => l[(a.id + Math.floor(sim.time)) % l.length];
        let line = '';
        if (e.kind === 'pain') this.audio.vocal('pain', pitch, d2, q.pan);
        else if (e.kind === 'die') this.audio.vocal('die', pitch, d2, q.pan);
        else if (e.kind === 'spot') { if (!clip) this.audio.vocal('shout', pitch, d2, q.pan); line = pick(['Cops!', 'The cops are here!', "They're coming in!", 'Shoot them!', 'We got company!', 'Get them!']); }
        else if (e.kind === 'unrest') { if (!clip) this.audio.vocal('shout', pitch, d2, q.pan); line = "I'm out of here!"; }
        else if (e.kind === 'panic') { this.audio.vocal('whimper', pitch, d2, q.pan); line = pick(['Help!', 'No, no!', "Don't shoot!", "What's going on?"]); }
        else if (e.kind === 'surrender') { if (!clip || a.kind === 'civ') this.audio.vocal(a.kind === 'civ' ? 'whimper' : 'yes', pitch, d2, q.pan); line = a.kind === 'civ' ? pick(["Don't shoot, please!", "I'll do what you say!", 'Help me!', "Please don't hurt me!"]) : pick(["Don't shoot! I give up!", 'Okay, okay! I give up!', "I'm dropping the gun!"]); }
        if (line && q.d < 16) { this.log(`${a.kind === 'civ' ? 'Civilian' : 'Suspect'}: ${line}`, ''); this.speak(line, a, { pitch: Math.min(2, pitch * 1.1), rate: 1.25, gain: Math.max(0.15, near * (1 - q.d / 20)), pan: q.pan, muffle: near < 1 }); }
        break;
      }
      case 'cuff': { const q = this.pan(e.a.x, e.a.z); if (q.d < 10) this.audio.cuff(); if (e.by === p) this.log(e.a.kind === 'suspect' ? 'You secured a suspect.' : 'You secured a civilian.', 'me'); break; }
      case 'surrender': { const q = this.pan(e.a.x, e.a.z); if (q.d < 14 && sim.los(p.x, p.z, e.a.x, e.a.z)) this.log(e.a.kind === 'suspect' ? 'Suspect gives up – cuff them!' : 'Civilian complies – cuff them before you move on.', ''); break; }
      case 'marker': fx.marker(e.x, e.z, TEAM_COLOR[e.team]); break;
      case 'info': {
        const now = performance.now();
        if (e.text === this.lastInfo && now - this.lastInfoT < 1500) break;
        this.lastInfo = e.text; this.lastInfoT = now;
        this.log(e.text, 'warn'); this.audio.fail();
        break;
      }
      case 'end': this.endT = 2.2; this.log(e.win ? 'The building is secure. Good work!' : 'You are down. The operation is aborted.', e.win ? 'me' : 'warn'); break;
    }
    if (e.t === 'shot' && e.by === p && e.hit === 'actor') { this.hitFx = 1; }
  }
  debrief() {
    const sim = this.sim!, sc = sim.score(), win = !!sim.over?.win; this.state = 'end'; this.voice.stop(); if (document.pointerLockElement) document.exitPointerLock();
    show('nvg', false); show('bodycam', false); show('wheel', false);
    $('debTitle').textContent = win ? 'Mission completed' : (sim.over?.reason || 'Mission failed'); $('debRank').textContent = `Grade ${sc.letter} · ${sc.rank}`;
    $('debTable').innerHTML = sc.parts.filter(p => p.max > 0 || p.pts < 0).map(p => `<tr><td>${p.label}</td><td class="${p.pts < 0 ? 'neg' : ''}">${p.pts}${p.max ? ' / ' + p.max : ''}</td></tr>`).join('') + `<tr class="total"><td>Total</td><td>${sc.total} / 100</td></tr>`;
    $('debNotes').innerHTML = sim.debriefNotes().map(n => `<div>• ${n}</div>`).join('');
    if (win) {
      career.xp += Math.max(25, sc.total); career.ops++; career.arrests += sim.stats.suspectsArrested;
      localStorage.setItem('teamai.career', JSON.stringify(career));
      if ((best[this.mission] ?? -1) < sc.total) { best[this.mission] = sc.total; localStorage.setItem('teamai.best', JSON.stringify(best)); }
      this.updateRankDock();
      const done = MISSIONS.filter((_, i) => best[i] != null).length; $('mBest').textContent = `${done}/${MISSIONS.length} Ops Completed`;
      this.selectMission(this.mission);
    }
    show('hud', false); show('debrief', true); win ? this.audio.ok() : this.audio.fail();
  }

  // ---------------- HUD ----------------
  /** Status line under Settings for the local Whisper speech model. */
  asrInfo() {
    const lv = this.localVoice, a = $('asrInfo'), pct = (v: number) => Math.round(v * 100) + ' %';
    if (this.voice !== lv) a.textContent = lv.failed ? `The local model could not be loaded (${lv.lastError || 'unknown error'}) – the browser speech service is used instead.` : 'Browser speech service: only in Chrome and Edge, and what you say is sent to the browser maker for recognition.';
    else a.textContent = lv.modelReady ? `Ready – Whisper runs on ${lv.device === 'webgpu' ? 'your graphics card' : 'your processor'}${lv.lastMs ? `, last answer took ${lv.lastMs} ms` : ''}. Nothing you say leaves this computer.` : lv.failed ? `Could not be loaded: ${lv.lastError}` : !S.mic ? 'Speech recognition is off.' : `Downloading the speech model${lv.sizeMb ? ` (about ${lv.sizeMb} MB, once)` : ''}: ${pct(lv.progress)}`;
    a.className = 'note' + (lv.failed ? ' warn' : '');
  }
  micState(s: string, detail?: string) {
    if (detail === undefined && s === this.micS) detail = this.micD; this.micS = s; this.micD = detail;
    const ptt = !!S.ptt, held = this.voice.held;
    const dot = $('micdot'), txt = $('micstate'); dot.className = s === 'listening' && (!ptt || held) ? 'on' : s === 'denied' || s === 'error' || s === 'unsupported' ? 'err' : '';
    const why: Record<string, [string, string]> = {
      iframe: ['MICROPHONE BLOCKED BY THE PREVIEW – pause (Esc) and choose «Open in its own tab»', 'The game is embedded in another page, and that page does not pass the microphone through. Allowing the microphone in the browser does not help – open the game in its own tab with the button below.'],
      mic: ['MICROPHONE DENIED – pause (Esc) for help', 'The browser denies the microphone for this page. Click the icon to the left of the address, set Microphone to «Allow», reload the page and try again. Also check that the operating system lets the browser use the microphone.'],
      service: ['SPEECH SERVICE DENIED BY THE BROWSER – pause (Esc) for help', 'The microphone works, but the browser does not allow its speech recognition service. This happens in Brave, Opera and sometimes Edge. Use Google Chrome, and turn off VPN/ad blockers for this page.'],
      model: [`LOADING SPEECH MODEL ${Math.round(this.localVoice.progress * 100)} % – type orders with Enter meanwhile`, 'The speech model is being downloaded to this computer. That happens once; after that it starts in a few seconds. Until it is ready you can type orders with Enter or use the quick keys.'],
      modelfail: ['SPEECH MODEL COULD NOT BE LOADED – pause (Esc) for help', 'The local speech model could not be downloaded or started. Check the internet connection and reload the page, or choose «Browser service» under Settings → Speech recognition engine.'],
      nomic: ['NO MICROPHONE FOUND', 'No microphone found. Connect one and select it as the recording device in the system sound settings.'],
      busy: ['MICROPHONE IS BUSY', 'The microphone is used by another program or cannot be read. Close other programs that use it and try again.'],
      network: ['SPEECH SERVICE UNREACHABLE (NETWORK)', 'The browser’s speech recognition cannot reach its cloud service. Check your internet, VPN, firewall and ad blocker.'],
      lang: ['LANGUAGE NOT SUPPORTED BY THE SPEECH SERVICE', 'The chosen accent for voice commands is not supported by the browser’s speech service. Change it under Settings.'],
    };
    const base: Record<string, [string, string]> = {
      listening: ptt ? [held ? 'LISTENING – release V when you are done' : 'HOLD V TO TALK', 'Hold V while you give an order and release it when you are done.'] : ['MICROPHONE ON – LISTENING', 'The microphone is on and listening.'],
      starting: ptt && held ? ['STARTING MICROPHONE – wait a second and say it again', 'Starting the microphone…'] : ptt ? ['HOLD V TO TALK', 'Hold V while you give an order and release it when you are done.'] : ['STARTING MICROPHONE…', 'Starting the microphone…'],
      off: ['MICROPHONE OFF – press Enter to type an order', 'The microphone is off.'], unsupported: ['VOICE CONTROL NOT SUPPORTED HERE – use Chrome', 'This browser has no speech recognition. Use Google Chrome.'],
    };
    const m = (detail && why[detail]) || base[s] || ['MICROPHONE ERROR' + (detail ? ' (' + detail + ')' : ''), 'Unknown microphone error' + (detail ? ': ' + detail : '') + '.'];
    txt.textContent = m[0]; $('micHelp').textContent = m[1] + (this.voice.lastHeard ? ` Last words heard by the microphone: «${this.voice.lastHeard}».` : ' The microphone has not picked up any words yet.') + (this.voice.lastError ? ` Last error from the speech service: ${this.voice.lastError}.` : '') + (this.voice === this.localVoice ? ` Engine: local Whisper${this.localVoice.device ? ' on ' + this.localVoice.device : ''}${this.localVoice.lastMs ? `, ${this.localVoice.lastMs} ms` : ''}.` : ' Engine: browser speech service.') + (this.ai.state === 'ready' ? ' AI Brain: ready.' : ''); $('micHelp').className = 'note' + (dot.className === 'err' ? ' warn' : '');
  }
  buildMap() {
    const sim = this.sim!, l = sim.level, k = 4, c = document.createElement('canvas'); c.width = l.w * k; c.height = l.h * k; const g = c.getContext('2d')!;
    for (let z = 0; z < l.h; z++) for (let x = 0; x < l.w; x++) { const v = l.cells[z * l.w + x]; g.fillStyle = v === WALL ? '#8fa3b5' : v === DOOR ? '#f2c14e' : v === WINDOW ? '#68b6e0' : v === LOW || v === HIGH ? '#33414d' : v === 1 ? '#18212a' : '#0c1116'; g.fillRect(x * k, z * k, k, k); }
    this.mapBase = c; const m = $<HTMLCanvasElement>('minimap'); m.width = c.width; m.height = c.height; m.style.width = c.width * 1.15 + 'px';
  }
  drawMap() {
    const m = $<HTMLCanvasElement>('minimap'); m.style.display = this.mapOn ? '' : 'none'; if (!this.mapOn || !this.mapBase) return;
    const g = m.getContext('2d')!, sim = this.sim!, k = 4; g.drawImage(this.mapBase, 0, 0);
    for (const d of sim.level.doors) {
      if (d.open > 0.5) { g.fillStyle = '#18212a'; g.fillRect(d.cx * k, d.cz * k, k, k); }
      else if (d.wedged) { g.fillStyle = '#ff9820'; g.fillRect(d.cx * k, d.cz * k, k, k); }
      else if (d.locked) { g.fillStyle = '#e04848'; g.fillRect(d.cx * k, d.cz * k, k, k); }
    }
    if (sim.level.breaker) { g.fillStyle = sim.powerOn ? '#4fd07a' : '#555'; g.fillRect(sim.level.breaker.x * k - 2, sim.level.breaker.z * k - 2, 4, 4); }
    if (sim.bomb && !sim.bomb.defused) { g.fillStyle = '#ff2a2a'; g.fillRect(sim.bomb.x * k - 2, sim.bomb.z * k - 2, 4, 4); }
    for (const a of sim.actors) {
      if (a.kind === 'officer' && a.alive) { g.fillStyle = a.team === 'A' ? '#ff5a5a' : '#5aa2ff'; g.fillRect(a.x * k - 2, a.z * k - 2, 4, 4); }
      else if (a.restrained && a.alive) { g.fillStyle = a.kind === 'suspect' ? '#c08a2a' : '#4fd07a'; g.fillRect(a.x * k - 1.5, a.z * k - 1.5, 3, 3); }
    }
    const p = sim.player, f = fwd(this.yaw); g.fillStyle = '#fff'; g.beginPath(); g.moveTo(p.x * k + f.x * 6, p.z * k + f.z * 6); g.lineTo(p.x * k - f.x * 3 - f.z * 3.5, p.z * k - f.z * 3 + f.x * 3.5); g.lineTo(p.x * k - f.x * 3 + f.z * 3.5, p.z * k - f.z * 3 - f.x * 3.5); g.fill();
  }
  updateHud(force = false) {
    const sim = this.sim; if (!sim) return; this.hudT -= 1; if (!force && this.hudT > 0) return; this.hudT = 8;
    const p = sim.player, r = sim.remaining(), ws = this.weaponSpecs;
    ($('hpbar').firstElementChild as HTMLElement).style.width = Math.max(0, p.hp) + '%'; $('hptxt').textContent = String(Math.ceil(Math.max(0, p.hp)));
    $('wname').textContent = ws[this.weapon].name + (this.reloadT > 0 ? ' – RELOADING' : ''); const ac = $('acount'); ac.innerHTML = `<b>${this.ammo[this.weapon]}</b> / ${this.reserve[this.weapon]}`; ac.className = this.ammo[this.weapon] <= 4 ? 'low' : '';
    $('bangs').textContent = `BANG ${'◉'.repeat(p.bangs)} · C2 ${p.c2} · WEDGE ${p.wedges}`;
    $('objective').innerHTML = `SUSPECTS <b>${r.suspects}</b> · CIVILIANS <b>${r.civs}</b>${sim.level.breaker ? ` · POWER <b>${sim.powerOn ? 'ON' : 'OFF'}</b>` : ''}`;
    const bt = $('bombtimer');
    if (sim.bomb && !sim.bomb.defused) {
      bt.classList.remove('hidden');
      const sec = Math.max(0, Math.ceil(sim.bomb.time)), mm = Math.floor(sec / 60), ss = String(sec % 60).padStart(2, '0');
      bt.textContent = `BOMB ACTIVE · ${mm}:${ss}`;
    } else bt.classList.add('hidden');
    if (this.bodycamOn) $('bcTime').textContent = new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';
    let html = '';
    for (const t of ['A', 'B'] as Team[]) {
      const T = sim.teams[t]; html += `<div class="tcard ${t} ${this.selTeam === t || this.selTeam === 'ALL' ? 'sel' : ''}"><h4>TEAM ${t}<span>${ORDER_LABEL[T.order.type]}${T.fire === 'hold' ? ' · HOLD FIRE' : ''}</span></h4>`;
      for (const o of sim.officers.filter(o => o.team === t)) html += `<div class="mem ${o.alive ? '' : 'dead'}"><span>${o.name}${o.solo && o.alive ? `<em>${ORDER_LABEL[o.solo.order.type]}</em>` : ''}</span><i><u style="width:${o.hp}%;background:${o.hp > 60 ? '#5fe08a' : o.hp > 30 ? '#f2c14e' : '#e04848'}"></u></i></div>`;
      html += '</div>';
    }
    $('team').innerHTML = html;
    $('quick').innerHTML = `<kbd>Tab</kbd> <b>${this.selTeam === 'ALL' ? 'ALL' : 'TEAM ' + this.selTeam}</b> · <kbd>H</kbd> Wheel · <kbd>N</kbd> NVG · <kbd>K</kbd> Bodycam · <kbd>E</kbd> Peek · <kbd>U</kbd> C2 · <kbd>Y</kbd> Wedge · <kbd>Enter</kbd> Order`;
    const it = sim.interactTarget(), pr = $('prompt');
    if (p.cuff) { pr.style.opacity = '1'; pr.textContent = 'Cuffing…'; $('progress').style.opacity = '1'; ($('progress').firstElementChild as HTMLElement).style.width = (p.cuffT / 1.6) * 100 + '%'; }
    else if (sim.bomb && !sim.bomb.defused && sim.bomb.defuseT > 0) { pr.style.opacity = '1'; pr.textContent = 'Defusing bomb…'; $('progress').style.opacity = '1'; ($('progress').firstElementChild as HTMLElement).style.width = (sim.bomb.defuseT / 2.2) * 100 + '%'; }
    else {
      $('progress').style.opacity = '0';
      if (it?.actor) { pr.style.opacity = '1'; pr.innerHTML = '<kbd>F</kbd> Handcuff'; }
      else if (it?.bomb) { pr.style.opacity = '1'; pr.innerHTML = '<kbd>F</kbd> Defuse Bomb'; }
      else if (it?.breaker) { pr.style.opacity = '1'; pr.innerHTML = `<kbd>F</kbd> ${sim.powerOn ? 'Cut Building Power' : 'Restore Power'}`; }
      else if (it?.door) {
        pr.style.opacity = '1';
        pr.innerHTML = it.door.locked ? '<kbd>F</kbd> Pick Lock · <kbd>U</kbd> C2 · <kbd>E</kbd> Peek'
          : `<kbd>F</kbd> ${it.door.target ? 'Close' : 'Open'} · <kbd>E</kbd> Peek · <kbd>Y</kbd> ${it.door.wedged ? 'Unwedge' : 'Wedge'}`;
      } else pr.style.opacity = '0';
    }
  }

  // ---------------- frame ----------------
  frame() {
    requestAnimationFrame(() => this.frame());
    const now = performance.now(), dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
    if ((this.state === 'play' || (this.state === 'pause' && this.net.online)) && this.sim) this.tick(dt);
    this.render();
  }
  tick(dt: number) {
    const sim = this.sim!, p = sim.player, K = this.keys;
    p.yaw = this.yaw; p.pitch = this.pitch;
    if (p.alive && !sim.over && !this.typing) {
      let mx = 0, mz = 0; if (K.has('KeyW')) mz += 1; if (K.has('KeyS')) mz -= 1; if (K.has('KeyD')) mx += 1; if (K.has('KeyA')) mx -= 1;
      const len = Math.hypot(mx, mz);
      if (len) {
        const run = (K.has('ShiftLeft') || K.has('ShiftRight')) && !p.prone && !p.crouch, quiet = p.prone || (this.slow && !run), sp = (p.prone ? 0.9 : p.crouch ? 1.9 : run ? 5.3 : this.slow ? 1.5 : 3.5) * dt / len, f = fwd(this.yaw);
        const bx = p.x, bz = p.z; sim.movePlayer((f.x * mz - f.z * mx) * sp, (f.z * mz + f.x * mx) * sp);
        const moved = Math.hypot(p.x - bx, p.z - bz); this.bob += moved * 3.3; this.stepAcc += moved; if (this.stepAcc > (run ? 2.2 : 1.6)) { this.stepAcc = 0; if (!quiet && p.jumpY <= 0) this.audio.step(p.crouch ? 0.06 : run ? 0.32 : 0.18); }
      }
      if (this.jumpV !== 0 || p.jumpY > 0) { // jump
        p.jumpY += this.jumpV * dt; this.jumpV -= 9.8 * dt;
        if (p.jumpY <= 0) { p.jumpY = 0; this.jumpV = 0; this.audio.step(0.4); if (!this.mirror) sim.playerNoise(p, 7); }
      }
      this.fireCd -= dt;
      const ws = this.weaponSpecs[this.weapon];
      if (this.reloadT > 0) { this.reloadT -= dt; if (this.reloadT <= 0) { const n = Math.min(ws.mag - this.ammo[this.weapon], this.reserve[this.weapon]); this.ammo[this.weapon] += n; this.reserve[this.weapon] -= n; } }
      else if (this.mouseDown && this.fireCd <= 0 && (ws.auto || !this.semiLock)) { this.fire(); if (!ws.auto) this.semiLock = true; }
      if (!this.mouseDown || this.fireCd > 0.25) this.preShot = false;
    }
    if (this.mirror) {
      this.inT -= dt; if (this.inT <= 0) { this.inT = 0.05; this.net.send({ t: 'in', x: p.x, z: p.z, yaw: this.yaw, pitch: this.pitch, cr: p.crouch, pr: p.prone, jy: p.jumpY, mv: K.has('KeyW') || K.has('KeyA') || K.has('KeyS') || K.has('KeyD') }); }
      sim.events.length = 0;
    } else {
      sim.update(dt);
      if (this.net.role === 'host') {
        if (sim.events.length) this.net.broadcast({ t: 'ev', e: sim.events.map(encodeEv) });
        this.snapT -= dt; if (this.snapT <= 0) { this.snapT = 1 / 15; this.net.broadcast({ t: 'snap', s: encodeSnap(sim) }); }
      }
      for (const e of sim.events) this.handle(e); sim.events.length = 0;
    }
    // footsteps of everyone nearby
    for (const a of sim.actors) {
      if (a === p || !a.alive || !a.moving) continue; const ph = Math.floor(a.walk / Math.PI), last = this.stepPh.get(a); this.stepPh.set(a, ph);
      if (last !== undefined && ph !== last && !a.prone) { const q = this.pan(a.x, a.z); if (q.d < 14) this.audio.step((a.kind === 'officer' || a.kind === 'player' ? 0.2 : 0.14) / (1 + q.d * 0.25), q.pan); }
    }
    if (this.net.online) { const vc = $('vc'); vc.textContent = this.net.micOk ? (this.net.muted ? 'VOICE CHAT: YOUR MIC IS OFF (B)' : `VOICE CHAT ON · ${this.net.voiceCount} connected · B = mute mic`) : 'VOICE CHAT: no microphone – you can only hear the others'; vc.className = this.net.muted || !this.net.micOk ? 'off' : ''; }
    this.level!.update(dt, sim.time); for (const v of this.views.values()) v.update(dt, sim.time); this.fx.update(dt, sim);
    // camera
    this.recoil = Math.max(0, this.recoil - dt * 0.22); this.dmgFx = Math.max(0, this.dmgFx - dt * 1.4); this.hitFx = Math.max(0, this.hitFx - dt * 5);
    const targetEye = (!p.alive ? 0.35 : p.prone ? 0.36 : p.crouch ? 1.12 : 1.62) + (p.alive ? p.jumpY : 0); this.eye += (targetEye - this.eye) * Math.min(1, dt * (p.jumpY > 0 ? 30 : 9));
    { const st = $('stance'), run = (K.has('ShiftLeft') || K.has('ShiftRight')) && !p.prone && !p.crouch, t = !p.alive ? '' : p.prone ? 'CRAWLING · SILENT' : p.crouch ? 'CROUCHING · SILENT' : run ? 'RUNNING · HEARD FAR AWAY' : this.slow ? 'SNEAKING · SILENT' : ''; if (st.textContent !== t) { st.textContent = t; st.className = run ? 'loud' : ''; } }
    this.camera.position.set(p.x, this.eye + Math.sin(this.bob * 2) * 0.022, p.z); this.camera.rotation.set(this.pitch, this.yaw, !p.alive ? 0.5 : (this.bodycamOn ? 0.035 + Math.sin(this.bob) * 0.015 : Math.sin(this.bob) * 0.004));
    { const sprint = (K.has('ShiftLeft') || K.has('ShiftRight')) && !p.prone && !p.crouch && (K.has('KeyW') || K.has('KeyA') || K.has('KeyS') || K.has('KeyD'));
      const want = this.ads && p.alive && this.reloadT <= 0 && !sprint && !this.typing && !!document.pointerLockElement || (AUTO && this.ads) ? 1 : 0;
      this.aimK += (want - this.aimK) * Math.min(1, dt * 12); if (Math.abs(want - this.aimK) < 0.002) this.aimK = want;
      const baseFov = this.bodycamOn ? 92 : 74;
      const fov = baseFov * (1 - this.aimK * (this.weapon === 0 ? 0.45 : 0.25)); if (Math.abs(this.camera.fov - fov) > 0.01) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); } }
    this.torch.intensity = this.torchOn ? 22 : 0;
    // view model
    const ws0 = this.weaponSpecs[this.weapon];
    const g = this.vm.group; this.vmKick += (0 - this.vmKick) * Math.min(1, dt * 14); this.sway.multiplyScalar(Math.max(0, 1 - dt * 9));
    const rl = this.reloadT > 0 ? Math.sin(Math.min(1, this.reloadT / ws0.reload) * Math.PI) : 0;
    const ak = this.aimK, AIM = AIMPOS;
    g.position.set(0.17 * (1 - ak) - this.sway.x + Math.sin(this.bob) * 0.006, -0.16 + ak * 0.075 + this.sway.y - rl * 0.16 + Math.abs(Math.cos(this.bob)) * 0.006 + Math.min(0, this.vmKick) * 0.2, -0.5 + Math.max(0, this.vmKick) * 0.05);
    g.rotation.set(Math.max(0, this.vmKick) * 0.07 - rl * 0.7, 0.03 + this.sway.x * 2, rl * 0.5);
    this.vm.rifle.visible = this.weapon === 0 && !ws0.shield; this.vm.pistol.visible = this.weapon === 1 || !!ws0.shield; this.vm.shield.visible = !!ws0.shield; g.visible = p.alive;
    if (this.arms.ready) { // animated arms: the clips do the reloading and walking, the code only adds sway and recoil
      const a = this.arms.root, rf = this.weapon === 0 && !ws0.shield, dip = 0, mv = !p.alive || this.typing || !(K.has('KeyW') || K.has('KeyA') || K.has('KeyS') || K.has('KeyD')) ? 0 : (K.has('ShiftLeft') || K.has('ShiftRight')) && !p.crouch && !p.prone ? 2 : 1;
      const wIdx = rf ? 0 : 1;
      const am = AIM[wIdx]; a.position.set(-this.sway.x * (1 - ak * 0.7) + am[0] * ak, this.sway.y * (1 - ak * 0.7) + Math.min(0, this.vmKick) * 0.2 - dip * 0.16 + am[1] * ak, Math.max(0, this.vmKick) * 0.035 + am[2] * ak);
      a.rotation.set(Math.max(0, this.vmKick) * 0.035 * (1 - ak * 0.6) - dip * 0.7 + am[3] * ak, this.sway.x * 2 * (1 - ak * 0.7) + am[4] * ak, dip * 0.5); a.visible = p.alive && !ws0.shield;
      this.arms.update(dt, wIdx, mv); a.updateMatrixWorld(true); this.vm.flash.position.copy(g.worldToLocal(this.arms.muzzle.getWorldPosition(new THREE.Vector3())));
    }
    // overlays
    $('dmg').style.opacity = String(Math.max(this.dmgFx, p.hp < 35 && p.alive ? 0.35 : 0, p.alive ? 0 : 0.8)); $('flash').style.opacity = String(Math.min(1, p.flash * 1.6));
    const hm = $('hitmark'); hm.style.opacity = String(this.hitFx);
    const gap = 6 + this.recoil * 260 + (K.has('KeyW') || K.has('KeyA') || K.has('KeyS') || K.has('KeyD') ? 7 : 0) - (p.crouch ? 2 : 0); $('cross').style.setProperty('--gap', gap * (1 - this.aimK * 0.5) + 'px'); $('cross').style.opacity = String(1 - this.aimK); // both primary and tactical RMR pistol aim down sights
    if (this.parsedT > 0) { this.parsedT -= dt; if (this.parsedT <= 0) { $('parsed').textContent = ''; $('heard').textContent = ''; } }
    this.updateHud(); this.drawMap();
    if (this.endT > 0) { this.endT -= dt; if (this.endT <= 0) this.debrief(); }
  }
  render() {
    const r = this.renderer; r.clear();
    if (this.state === 'menu') { const now = performance.now(), dt = Math.min(0.05, (now - this.menuT) / 1000); this.menuT = now; this.menu.resize(innerWidth / innerHeight); this.menu.update(dt); r.render(this.menu.scene, this.menu.cam); }
    else if (this.sim) { r.render(this.scene, this.camera); r.clearDepth(); r.render(this.viewScene, this.viewCam); }
  }
}

const game = new Game();
const propsDone = loadProps();
const weaponsDone = loadWeapons().then(async () => {
  if (weaponsReady) { upgradeViewModel(game.vm); game.menu.upgradeWeapons(); }
  if (S.qual > 0 && await game.arms.load()) { // animated arms replace the static weapon (not on the lowest graphics setting)
    game.vm.rifle.clear(); game.vm.pistol.clear(); game.viewCam.add(game.arms.root); game.viewScene.environment = studioEnv(game.renderer); game.viewScene.environmentIntensity = 0.5;
  }
});
const modelsDone = loadModels().then(() => {
  $('modelStatus').textContent = modelsReady ? '' : 'The 3D characters could not be loaded – built-in figures are used.';
});
assetsDone = Promise.all([propsDone, weaponsDone, modelsDone]);
if (S.qual > 0) {
  game.menu.env(game.renderer);
  operatorEnv(game.menu.scene.environment);
  void Promise.all([game.menu.hero(3), game.menu.vehicle('./models/vehicle/marauder.glb')]).then(async ([heroOk]) => {
    if (!heroOk) { await modelsDone; game.menu.squad(); }
  });
} else {
  void modelsDone.then(() => game.menu.squad());
}
(window as any).__ta = game;
