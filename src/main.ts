import { loadModels, modelsReady } from './game/models';
import * as THREE from 'three';
import { Sim, Actor, Command, Team, Ev, fwd, PrimaryLoadout, SecondaryLoadout, CoopMods, PrePlan } from './sim/sim';
import { MISSIONS, WALL, DOOR, LOW, HIGH, WINDOW, buildLevel, Level, Door, Room, roomAt } from './sim/level';
import { MenuScene } from './game/menuscene';
import { operatorEnv } from './game/operator';
import { loadWeapons, weaponsReady, FpsArms, studioEnv, setShieldCracks } from './game/weapons';
import { upgradeViewModel } from './game/world';
import { loadProps } from './game/props';
import '@fontsource/barlow-condensed/500.css'; import '@fontsource/barlow-condensed/600.css'; import '@fontsource/barlow-condensed/700.css'; import '@fontsource/barlow/400.css'; import '@fontsource/barlow/600.css';
import { parseCommands, shouldUseAiBrain, ACTION_LABEL, DIR_LABEL } from './sim/commands';
import { TacticalAi, AI_MODELS, AiState, AiResult } from './game/ai';
import { LevelView, ActorView, FX, makeViewModel, TEAM_COLOR } from './game/world';
import { PostFX } from './game/postfx';
import {
  RANKS, GEAR_NAMES, SQUAD, loadCareer, saveCareer, rankOf, nextRank, isGearUnlocked, gearLockLabel,
  missionUnlocked, clearedCount, nextUncleared, campaignComplete, deployRoster, applyMissionResult,
  type GearKey, type AppliedResult,
} from './game/career';
import { GameAudio, Speech } from './game/audio';
import { Voice } from './game/voice';
import { LocalVoice } from './ai/localvoice';
import { Net, Msg } from './game/net';
import { encodeSnap, applySnap, encodeEv, decodeEv, NetTarget } from './sim/netstate';
import type { DataConnection } from 'peerjs';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const show = (id: string, on: boolean) => $(id).classList.toggle('hidden', !on);
const params = new URLSearchParams(location.search);
const AUTO = params.has('auto');

// ---------------- settings & career ----------------
const defaults = { sens: 1, adsSens: 0.65, vol: 0.8, music: 1, mic: 1, ptt: 1, lang: 'en-US', asr: 'local', tts: 1, head: 0, qual: 1, diff: 1, name: '', ai: 0, aiModel: AI_MODELS[0].id as string, primary: 'carbine' as PrimaryLoadout, secondary: 'pistol' as SecondaryLoadout, stream: 0, censor: 1, pip: 1 };
type Settings = typeof defaults;
const S: Settings = { ...defaults, ...JSON.parse(localStorage.getItem('teamai.settings') || '{}') };
if (!String(S.lang).startsWith('en')) S.lang = 'en-US'; // English only
if (!AI_MODELS.some(m => m.id === S.aiModel)) S.aiModel = AI_MODELS[0].id;
const best: Record<string, number> = JSON.parse(localStorage.getItem('teamai.best') || '{}');
const dailyBest: Record<string, number> = JSON.parse(localStorage.getItem('teamai.daily') || '{}');
const career = loadCareer();
const getRank = (xp: number) => rankOf(xp).name;
if (params.has('q')) S.qual = +params.get('q')!;
/** The ten selectable looks for the mission briefing (#brief[data-brief] in style.css). */
const BRIEF_STYLES: { id: string; label: string }[] = [
  { id: 'cctv', label: 'CCTV Wall' },
  { id: 'keyart', label: 'Key Art' },
  { id: 'ops', label: 'Ops Board' },
  { id: 'blueprint', label: 'Blueprint' },
  { id: 'dossier', label: 'Dossier' },
  { id: 'phosphor', label: 'Phosphor' },
  { id: 'swiss', label: 'Swiss' },
  { id: 'neon', label: 'Neon Noir' },
  { id: 'amber', label: 'Amber TTY' },
  { id: 'nato', label: 'Field Manual' },
  { id: 'daylight', label: 'Daylight' },
  { id: 'alert', label: 'Red Alert' },
];

const saveSettings = () => localStorage.setItem('teamai.settings', JSON.stringify(S));
const dailyInfo = () => {
  const d = new Date();
  const key = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const seed = Number(key);
  return { key, seed, mission: seed % MISSIONS.length };
};
const SECTOR_LOCS = ['KISTA SECTOR · SE', 'DOCKLANDS · HARBOR', 'CITY CENTER · SE', 'FINANCIAL DIST · SE', 'SUBWAY CLUB · SE', 'OUTSKIRTS COMPOUND'];

// where the animated arms move to when aiming: x, y, z offset and pitch, yaw; carbine, pistol, shotgun, beanbag, taser
const AIMPOS = [
  [-0.113, 0.036, 0, 0, 0],
  [-0.0936, 0.0813, -0.02, 0, 0],
  [-0.105, 0.042, 0.01, 0, 0],
  [-0.105, 0.042, 0.01, 0, 0],
  [-0.0936, 0.0813, -0.02, 0, 0],
];
// the challenges the player and the officers yell; one is picked at random each time
const SHOUTS = ['Police! Drop the weapon!', 'Police! Get on the ground!', 'Police! Hands up! Now!', 'Get down! Get down on the ground!', 'Drop it! Drop it now!', 'Show me your hands!'];
interface WeaponSpec { name: string; mag: number; res: number; rate: number; dmg: number; auto: boolean; spread: number; reload: number; kick: number; pellets?: number; nonLethal?: boolean; taser?: boolean; shield?: boolean; gun?: 'rifle' | 'pistol' | 'shotgun'; canSemi?: boolean; pen?: number }
const PRIMARY_SPECS: Record<PrimaryLoadout, WeaponSpec> = {
  carbine: { name: 'TX-4 CARBINE', mag: 30, res: 150, rate: 0.095, dmg: 34, auto: true, spread: 0.004, reload: 2.0, kick: 0.011, gun: 'rifle', canSemi: true, pen: 1 },
  shotgun: { name: 'S-87 BREACHER', mag: 8, res: 40, rate: 0.58, dmg: 16, pellets: 8, auto: false, spread: 0.045, reload: 2.2, kick: 0.038, gun: 'shotgun', pen: 1 },
  beanbag: { name: 'LL-12 KINETIC', mag: 8, res: 40, rate: 0.55, dmg: 8, pellets: 1, nonLethal: true, auto: false, spread: 0.012, reload: 2.1, kick: 0.024, gun: 'shotgun', pen: 0 },
  shield: { name: 'BALLISTIC SHIELD', mag: 15, res: 90, rate: 0.16, dmg: 26, auto: false, spread: 0.01, reload: 1.5, kick: 0.015, shield: true, gun: 'pistol', pen: 0 },
};
const SECONDARY_SPECS: Record<SecondaryLoadout, WeaponSpec> = {
  pistol: { name: 'P-17 SERVICE', mag: 17, res: 68, rate: 0.15, dmg: 26, auto: false, spread: 0.008, reload: 1.4, kick: 0.016, gun: 'pistol', pen: 0 },
  taser: { name: 'ARC-2 STUNNER', mag: 2, res: 12, rate: 0.45, dmg: 4, auto: false, spread: 0.006, reload: 1.5, kick: 0.008, nonLethal: true, taser: true, gun: 'pistol', pen: 0 },
};
const ORDER_LABEL: Record<string, string> = {
  follow: 'FOLLOWING', hold: 'HOLDING', move: 'MOVING', cover: 'COVERING YOU',
  stack: 'AT DOOR', breach: 'BREACHING', door: 'DOOR', restrain: 'SECURING',
  peek: 'PEEKING', c2: 'BREACH CHARGE', wedge: 'WEDGING', defuse: 'DEFUSING',
  secure: 'SEARCH & SECURE', search: 'SEARCH & SECURE', escort: 'ESCORTING',
  regroup: 'REGROUPING', none: 'STANDBY',
};
const orderText = (type: string | undefined): string => (type && ORDER_LABEL[type]) || 'STANDBY';

let assetsDone: Promise<unknown> = Promise.resolve();

class Game {
  renderer: THREE.WebGLRenderer; post: PostFX | null = null; postScene: THREE.Scene | null = null;
  scene = new THREE.Scene(); camera = new THREE.PerspectiveCamera(74, 1, 0.06, 120);
  viewScene = new THREE.Scene(); viewCam = new THREE.PerspectiveCamera(52, 1, 0.01, 10); vm = makeViewModel();
  torch = new THREE.SpotLight(0xfff0d6, 22, 32, 0.5, 0.6, 1.2);
  sim: Sim | null = null; level: LevelView | null = null; views = new Map<Actor, ActorView>(); fx = new FX();
  audio = new GameAudio(); speech = new Speech(); webVoice = new Voice(); localVoice = new LocalVoice(); voice: Voice | LocalVoice = this.webVoice; ai = new TacticalAi();
  net = new Net(); connIdx = new Map<DataConnection, number>(); connName = new Map<DataConnection, string>(); snapT = 0; inT = 0; stepPh = new Map<Actor, number>(); lobbyMission = 0; lobbyNames: string[] = [];
  netTargets = new Map<Actor, NetTarget>();
  lobbyMeta = new Map<DataConnection, { ready: boolean; prim: PrimaryLoadout; sec: SecondaryLoadout; debReady?: boolean }>();
  lobbyIds: string[] = [];
  lobbyList: { name: string; peerId: string; ready: boolean; prim: PrimaryLoadout; sec: SecondaryLoadout; speaking?: boolean; debReady?: boolean }[] = [];
  lobbyReady = false; lobbyPrim: PrimaryLoadout = S.primary; lobbySec: SecondaryLoadout = S.secondary;
  lobbyMods: CoopMods & { daily?: boolean } = {};
  debReady = false;
  pings: { x: number; z: number; label: string; color: string; t: number }[] = [];
  breachBannerT = 0;
  private lobbyVoiceTimer = 0;
  state: 'menu' | 'play' | 'pause' | 'end' = 'menu'; mission = 0; seed = 1;
  yaw = 0; pitch = 0; keys = new Set<string>(); mouseDown = false; eye = 1.62; bob = 0; stepAcc = 0; recoil = 0; vmKick = 0; sway = new THREE.Vector2();
  weapon = 0; ammo = [30, 15]; reserve = [150, 60]; fireCd = 0; reloadT = 0; semiLock = false; torchOn = true; laserOn = true; fireMode: 'auto' | 'semi' = 'auto'; mapOn = true;
  nvgOn = false; bodycamOn = false; wheelOn = false; nvgLight: THREE.AmbientLight | null = null; ambLight: THREE.AmbientLight | null = null;
  recoilPitch = 0; recoilRoll = 0; camShake = 0; hitHead = false;
  pipCam = new THREE.PerspectiveCamera(78, 240 / 146, 0.08, 55);
  pipOn = false; pipActorIdx = 0; pipTimer = 0; pipManual = false;
  pipKind: 'ally' | 'optiwand' = 'ally'; optiwandDoor: Door | null = null; optiwandSide = 1; optiwandMeta = '';
  lean = 0; leanTarget = 0;
  grenadeType: 'bang' | 'smoke' | 'gas' = 'bang';
  magnifier = false;
  preplan: PrePlan = { entry: 0, teamA: [], teamB: [], pins: [] };
  planTool: 'B' | 'A' | 'c2' | 'flash' = 'B';
  briefLevel: Level | null = null;
  briefStyle = BRIEF_STYLES.some(b => b.id === localStorage.getItem('teamai.briefStyle')) ? localStorage.getItem('teamai.briefStyle')! : 'cctv';
  dispatchPlaying = false;
  dispatchOn = false; isDaily = false; stress = 0; clubBeatT = 0; hbT = 0; breathT = 0; acousticT = 0; sensorPingSfxT = 0; radioCardT = 0;
  shieldHits = 0; suppressFx = 0; highReadyK = 0; lastRT = 0; speedReload = false; reloadShell = false; reloadDur = 2;
  private censorBoxes: HTMLDivElement[] = [];
  private replayRaf = 0; private replayPlaying = false; private replayTime = 0; private replayLast = 0; private replayBase: HTMLCanvasElement | null = null;
  get weaponSpecs(): [WeaponSpec, WeaponSpec] {
    if (this.sim?.mods.pistolOnly) return [SECONDARY_SPECS.pistol, SECONDARY_SPECS.taser];
    const prim = this.net.online ? this.lobbyPrim : S.primary;
    const sec = this.net.online ? this.lobbySec : S.secondary;
    return [PRIMARY_SPECS[prim] ?? PRIMARY_SPECS.carbine, SECONDARY_SPECS[sec] ?? SECONDARY_SPECS.pistol];
  }
  private activeGun(w = this.weaponSpecs[this.weapon]): 'rifle' | 'pistol' | 'shotgun' {
    return w.gun ?? (this.weapon === 0 && !w.shield ? 'rifle' : 'pistol');
  }
  private isWeaponAuto(w = this.weaponSpecs[this.weapon]): boolean {
    return w.auto && (!w.canSemi || this.fireMode === 'auto');
  }
  selTeam: Team | 'ALL' = 'ALL'; lastTeam: Team | 'ALL' = 'ALL'; lastWho: number | null = null; typing = false; dmgFx = 0; hitFx = 0; hudT = 0; mapT = 0; censorT = 0; last = performance.now(); mapBase: HTMLCanvasElement | null = null; endT = 0; parsedT = 0;

  constructor() {
    const canvas = $<HTMLCanvasElement>('c');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = S.qual ? 1.0 : 1.15; this.renderer.autoClear = false;
    this.camera.rotation.order = 'YXZ'; this.pipCam.rotation.order = 'YXZ';
    this.viewScene.add(this.viewCam); this.viewCam.add(this.vm.group);
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
    this.initDispatch();
    setInterval(() => { if (!$('settings').classList.contains('hidden')) this.asrInfo(); }, 500);
    this.applySettings();
    const unlockMenuAudio = () => {
      if (this.state !== 'menu') return;
      this.audio.init();
      this.syncMenuMusic();
    };
    window.addEventListener('pointerdown', unlockMenuAudio, { once: true });
    window.addEventListener('keydown', unlockMenuAudio, { once: true });
    requestAnimationFrame(() => this.frame());
    if (AUTO) this.start(+(params.get('auto') || 0), +(params.get('seed') || 1));
  }
  syncMenuMusic() {
    void this.audio.setMenuMusic(this.state === 'menu' && !!S.music && !AUTO);
    const btn = document.getElementById('btnMenuMusic');
    if (btn) {
      btn.textContent = S.music ? '♪ MUSIC ON' : '♪ MUSIC OFF';
      btn.classList.toggle('off', !S.music);
    }
  }
  resize() {
    const w = innerWidth, h = innerHeight;
    const cap = S.qual >= 3 ? 2 : S.qual === 2 ? 1.5 : S.qual === 1 ? 1.15 : 1;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, cap));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = this.viewCam.aspect = w / h; this.camera.updateProjectionMatrix(); this.viewCam.updateProjectionMatrix();
    this.post?.setSize(w, h, this.renderer.getPixelRatio());
  }
  applySettings() {
    ActorView.detailed = S.qual > 0;
    this.post?.setQuality(S.qual);
    this.renderer.shadowMap.enabled = S.qual >= 2;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.torch.castShadow = S.qual >= 2;
    if (this.torch.castShadow) {
      this.torch.shadow.mapSize.set(1024, 1024);
      this.torch.shadow.camera.near = 0.25;
      this.torch.shadow.camera.far = 28;
      this.torch.shadow.bias = -0.0005;
    }
    this.menu.setQuality(S.qual);
    if (this.scene && S.qual > 0) this.scene.environmentIntensity = S.qual >= 3 ? 0.3 : S.qual === 2 ? 0.22 : 0.14;
    this.audio.setVolume(S.vol); this.speech.enabled = !!S.tts; this.speech.lang = S.lang;
    const local = LocalVoice.supported && ((S.asr === 'local' && !this.localVoice.failed) || !Voice.supported), nv = local ? this.localVoice : this.webVoice;
    if (nv !== this.voice) { this.voice.stop(); this.voice = nv; }
    this.webVoice.setLang(S.lang); this.localVoice.setLang('en'); this.voice.ptt = !!S.ptt; this.micState(this.voice.state);
    if (local && S.mic && !AUTO) this.localVoice.preload();
    this.asrInfo();
    ($('sSens') as HTMLInputElement).value = String(S.sens); ($('sAdsSens') as HTMLInputElement).value = String(S.adsSens); ($('sVol') as HTMLInputElement).value = String(S.vol);
    for (const [id, k] of [['sMusic', 'music'], ['sMic', 'mic'], ['sPtt', 'ptt'], ['sLang', 'lang'], ['sAsr', 'asr'], ['sTts', 'tts'], ['sHead', 'head'], ['sQual', 'qual'], ['sDiff', 'diff'], ['sAi', 'ai'], ['sAiModel', 'aiModel'], ['sStream', 'stream'], ['sCensor', 'censor'], ['sPip', 'pip']] as const) ($(id) as HTMLSelectElement).value = String(S[k]);
    document.body.classList.toggle('stream-mode', !!S.stream);
    if (this.state === 'play' && S.stream && !this.bodycamOn) { this.bodycamOn = true; show('bodycam', true); }
    this.syncMenuMusic();
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
    if (!missionUnlocked(best, i)) i = nextUncleared(best, MISSIONS.length) ?? 0;
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
  /** Rank unlocks, campaign progress, the roster and ironman state, all in one place. */
  refreshCareerUi() {
    const gl = $('gearLocks');
    if (gl) {
      gl.innerHTML = RANKS.filter(r => r.gear).map(r => {
        const ok = isGearUnlocked(r.gear!, career.xp);
        return `<div class="gearlock ${ok ? 'on' : 'off'}"><b>${GEAR_NAMES[r.gear!]}</b><span>${ok ? 'unlocked' : `LOCKED · ${gearLockLabel(r.gear!)}`}</span></div>`;
      }).join('');
    }
    // loadout selects follow the rank
    const lp = $<HTMLSelectElement>('lPrimary'), ls = $<HTMLSelectElement>('lSecondary');
    for (const sel of [lp, ls]) {
      if (!sel) continue;
      for (const opt of Array.from(sel.options)) {
        const key = opt.value as GearKey;
        if (!opt.dataset.base) opt.dataset.base = opt.textContent || '';
        const base = opt.dataset.base;
        const ok = isGearUnlocked(key, career.xp);
        opt.disabled = !ok;
        opt.textContent = ok ? base : `${base} · LOCKED — ${gearLockLabel(key)}`;
      }
      const cur = sel.value as GearKey;
      if (!isGearUnlocked(cur, career.xp)) {
        sel.value = sel === lp ? 'carbine' : 'pistol';
        if (sel === lp) S.primary = sel.value as PrimaryLoadout; else S.secondary = sel.value as SecondaryLoadout;
        saveSettings();
      }
    }
    // campaign progress
    const cp = $('cmpProgress');
    if (cp) {
      const done = clearedCount(best), total = MISSIONS.length;
      const next = nextUncleared(best, total);
      cp.innerHTML = `<div class="cmpbar"><i style="width:${(done / total) * 100}%"></i></div>` +
        `<div class="cmpline">${campaignComplete(best, total) ? 'Campaign complete — every sector secured' : `Next: ${MISSIONS[next ?? 0].name}`} · ${done}/${total} cleared</div>`;
    }
    const ib = $('btnIronman'), ii = $('ironmanInfo');
    if (ib) { ib.textContent = `IRONMAN · ${career.ironman ? 'ON' : 'OFF'}`; ib.classList.toggle('on', career.ironman); }
    if (ii) ii.textContent = career.ironman
      ? 'No restarts, and a failed operation earns nothing. Injured officers still sit out.'
      : 'Off: restart freely and keep the XP from every completed operation.';
    const rl = $('rosterList');
    if (rl) {
      const squad = deployRoster(career);
      rl.innerHTML = SQUAD.map((m, i) => {
        const d = squad[i];
        return d.rookie
          ? `<div class="recov"><b>${m.name} · ${m.role}</b>Recovering · ${d.recovering} op${d.recovering > 1 ? 's' : ''}<i>${d.name} stands in</i></div>`
          : `<div><b>${m.name} · ${m.role}</b>${m.perk}</div>`;
      }).join('');
    }
    // locked operations on the mission strip
    document.querySelectorAll<HTMLElement>('#mPills .mpill').forEach((el, i) => {
      const locked = !missionUnlocked(best, i);
      el.classList.toggle('locked', locked);
      el.title = locked ? `Locked — complete operation ${i} first` : MISSIONS[i].name;
    });
  }
  updateRankDock() {
    $('mRank').textContent = `${getRank(career.xp)} · ${career.xp} XP`;
    const cur = rankOf(career.xp);
    const nxt = nextRank(career.xp);
    const pct = nxt ? Math.min(100, ((career.xp - cur.xp) / (nxt.xp - cur.xp)) * 100) : 100;
    ($('mXpFill') as HTMLElement).style.width = `${Math.max(8, pct)}%`;
    const nx = $('mNextRank');
    if (nx) nx.textContent = nxt ? `${nxt.name} in ${Math.max(0, Math.ceil(nxt.xp - career.xp))} XP · ${nxt.note}` : 'Highest rank reached · +20 % XP';
    this.refreshCareerUi();
  }
  buildMenu() {
    const pills = $('mPills'); pills.innerHTML = '';
    MISSIONS.forEach((m, i) => {
      const b = document.createElement('button'); b.className = 'mpill';
      b.title = m.name;
      b.textContent = `0${i + 1}`;
      b.onclick = () => {
        this.audio.init(); this.audio.ui();
        if (!missionUnlocked(best, i)) {
          const bb = $('mBestBadge'); bb.textContent = `LOCKED · CLEAR OPERATION 0${i} FIRST`; bb.className = 'none';
          this.audio.fail();
          return;
        }
        this.selectMission(i);
      };
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
    $('btnStartMission').onclick = () => {
      this.audio.init(); this.audio.ui(); this.isDaily = false;
      if (!missionUnlocked(best, this.mission)) { this.audio.fail(); return; }
      this.openBrief(this.mission);
    };
    const di = dailyInfo();
    const db = dailyBest[di.key];
    $('dailyBestBadge').textContent = db != null ? `${MISSIONS[di.mission].name} · BEST ${db}/100` : `${di.key} · ${MISSIONS[di.mission].name}`;
    $('btnDailyRaid').onclick = () => {
      this.audio.init(); this.audio.ui();
      if (this.net.role === 'client') return;
      this.isDaily = true;
      this.start(di.mission, di.seed, 1, 0, Math.max(1, S.diff));
      this.lock();
    };

    const done = MISSIONS.filter((_, i) => best[i] != null).length; $('mBest').textContent = `${done}/${MISSIONS.length} Ops Completed`;
    this.updateRankDock();
    ($('lPrimary') as HTMLSelectElement).value = S.primary; ($('lSecondary') as HTMLSelectElement).value = S.secondary;
    ($('lPrimary') as HTMLSelectElement).onchange = () => {
      const v = ($('lPrimary') as HTMLSelectElement).value as PrimaryLoadout;
      if (!isGearUnlocked(v as GearKey, career.xp)) { this.audio.fail(); ($('lPrimary') as HTMLSelectElement).value = S.primary; this.refreshCareerUi(); return; }
      S.primary = v; saveSettings(); this.menu.setHeroLoadout(S.primary, S.secondary); this.audio.ui();
    };
    ($('lSecondary') as HTMLSelectElement).onchange = () => {
      const v = ($('lSecondary') as HTMLSelectElement).value as SecondaryLoadout;
      if (!isGearUnlocked(v as GearKey, career.xp)) { this.audio.fail(); ($('lSecondary') as HTMLSelectElement).value = S.secondary; this.refreshCareerUi(); return; }
      S.secondary = v; saveSettings(); this.menu.setHeroLoadout(S.primary, S.secondary); this.audio.ui();
    };
    ($('btnIronman') as HTMLButtonElement).onclick = () => {
      career.ironman = !career.ironman; saveCareer(career); this.audio.ui(); this.refreshCareerUi();
    };
    ($('btnFirstRunOk') as HTMLButtonElement).onclick = () => {
      career.tutorialDone = true; saveCareer(career); show('firstrun', false); this.audio.ui();
    };
    if (!career.tutorialDone) show('firstrun', true);
    this.refreshCareerUi();
    this.menu.setHeroLoadout(S.primary, S.secondary);
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
  openBrief(index: number) {
    this.mission = index;
    const m = MISSIONS[index];
    // Per-mission fullscreen key art for the KEY ART briefing look.
    const briefEl = $('brief');
    if (briefEl) briefEl.style.setProperty('--keyart', `url("./keyart/${index}.jpg")`);
    this.briefLevel = buildLevel(index, 1);
    this.preplan = { entry: 0, teamA: [], teamB: [], pins: [] };
    this.planTool = 'B';
    this.dispatchPlaying = false;
    this.audio.stopDispatch();
    const dpBtn = $('btnPlayDispatch');
    dpBtn.textContent = '▶ PLAY 911 DISPATCH';
    dpBtn.classList.remove('playing');

    $('briefTitle').textContent = m.name;
    $('briefText').textContent = m.brief;
    const objMap = { clear: 'Locate & arrest or neutralize all suspects, secure all civilians.', hostage: 'Rescue the VIP bank director and secure all suspects.', bomb: 'Find and defuse the explosive device before detonation.' } as const;
    if ($('briefTag')) $('briefTag').textContent = `Mission ${String(index + 1).padStart(2, '0')} / ${String(MISSIONS.length).padStart(2, '0')} · Goal ${m.objective}`;
    // The briefing facts live in #briefFacts; never let a missing element block the launch.
    const facts = $('briefFacts');
    if (facts) facts.innerHTML = `<div><span>Suspects</span><b>${m.suspects}</b></div><div><span>Civilians</span><b>${m.civs}</b></div><div class="fact-obj"><span>Objective</span><b>${objMap[m.objective]}</b></div>`;

    // Intel that is actually in the level, so pre-planning is not guesswork.
    const bl = this.briefLevel;
    const intel = $('briefIntel');
    if (intel && bl) {
      const locked = bl.doors.filter(d => d.locked).length;
      const names = bl.entries.map(e => e.name);
      const rows: [string, string][] = [
        ['Ways in', names.length > 2 ? `${names.length} entries — pick one below` : `${names.length} — ${names.join(' · ')}`],
        ['Doors', `${bl.doors.length}${locked ? ` · ${locked} locked (C2 or force)` : ' · none locked'}`],
        ['Glass', bl.windows.length ? `${bl.windows.length} windows — FiberCam can scout them` : 'no exterior glass'],
        ['Power', bl.breaker ? 'Breaker panel — cut it and the site goes dark' : 'mains live'],
      ];
      if (bl.bomb) rows.push(['Device', `Explosive on site · ${Math.ceil(bl.bomb.time)} s on the clock`]);
      intel.innerHTML = rows.map(([k, v]) => `<div><b>${k}</b><span>${v}</span></div>`).join('');
    }

    this.buildCamWall();
    const camList = $('briefCamList');
    if (camList && bl) {
      const roomName = (i: number) => (bl.rooms[i]?.name ?? 'unknown room').toUpperCase();
      camList.innerHTML = bl.suspects.slice(0, 6)
        .map((sp, i) => `<div>S-${String(i + 1).padStart(2, '0')} · ${roomName(sp.room)}</div>`).join('');
    }

    // Briefing look picker — the looks below are remembered between sessions.
    const stylesBox = $('briefStyles');
    if (stylesBox) {
      stylesBox.innerHTML = BRIEF_STYLES.map((st, i) => `<button type="button" class="bsty ${st.id === this.briefStyle ? 'on' : ''}" data-bsty="${st.id}" title="${st.label}">${i + 1} ${st.label}</button>`).join('');
      stylesBox.querySelectorAll<HTMLElement>('.bsty').forEach(b => { b.onclick = () => { this.audio.ui(); this.applyBriefStyle(b.dataset.bsty!); }; });
    }
    this.applyBriefStyle(this.briefStyle, false);

    // Entry points selector
    const entriesBox = $('briefEntries');
    const entries = this.briefLevel.entries;
    entriesBox.innerHTML = entries.map((ep, idx) => `<button type="button" class="entry-btn ${idx === 0 ? 'on' : ''}" data-ep="${idx}">${ep.name}</button>`).join('');
    entriesBox.querySelectorAll<HTMLElement>('.entry-btn').forEach(btn => {
      btn.onclick = () => {
        this.audio.ui();
        this.preplan.entry = +btn.dataset.ep!;
        entriesBox.querySelectorAll('.entry-btn').forEach(o => o.classList.toggle('on', o === btn));
        const hud = $('briefEntryHud');
        if (hud) hud.textContent = `Entry · ${entries[this.preplan.entry ?? 0]?.name ?? ''}`;
        this.drawBriefPlan();
      };
    });

    document.querySelectorAll<HTMLElement>('.plan-tools .ptool').forEach(b => {
      b.classList.toggle('on', b.dataset.pt === this.planTool);
    });

    const hud = $('briefEntryHud');
    if (hud) hud.textContent = `Entry · ${entries[this.preplan.entry ?? 0]?.name ?? ''}`;
    this.drawBriefPlan();
    show('menu', false);
    show('brief', true);
  }
  /** Switches the look of the briefing screen (see BRIEF_STYLES). */
  applyBriefStyle(id: string, save = true) {
    if (!BRIEF_STYLES.some(b => b.id === id)) id = 'ops';
    this.briefStyle = id;
    const el = document.getElementById('brief');
    if (el) el.dataset.brief = id;
    if (save) localStorage.setItem('teamai.briefStyle', id);
    document.querySelectorAll<HTMLElement>('#briefStyles .bsty').forEach(b => b.classList.toggle('on', b.dataset.bsty === id));
    this.drawBriefPlan();
    this.drawCamFeeds();
  }
  /** Reads one of the --map-* colours the briefing look defines for the floorplan. */
  private briefVar(name: string, fallback: string) {
    const el = document.getElementById('brief');
    const v = el ? getComputedStyle(el).getPropertyValue(name).trim() : '';
    return v || fallback;
  }
  drawBriefPlan() {
    const l = this.briefLevel; if (!l) return;
    const c = $<HTMLCanvasElement>('briefMap'), k = 9;
    c.width = l.w * k; c.height = l.h * k;
    const g = c.getContext('2d')!;
    const col = {
      bg: this.briefVar('--map-bg', '#0b1118'), grid: this.briefVar('--map-grid', 'rgba(120,160,200,.08)'),
      floor: this.briefVar('--map-floor', '#152130'), wall: this.briefVar('--map-wall', '#9db4c8'),
      door: this.briefVar('--map-door', '#f2c14e'), win: this.briefVar('--map-win', '#68b6e0'),
      prop: this.briefVar('--map-prop', '#263645'), entry: this.briefVar('--map-entry', '#4fd07a'),
      bomb: this.briefVar('--map-bomb', '#ff3b3b'), a: this.briefVar('--map-a', '#ff5a5a'),
      b: this.briefVar('--map-b', '#4a9eff'), ink: this.briefVar('--map-ink', '#7f93a8'),
    };
    g.fillStyle = col.bg; g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = col.grid; g.lineWidth = 1; g.beginPath();
    for (let x = 0; x <= l.w; x += 2) { g.moveTo(x * k + 0.5, 0); g.lineTo(x * k + 0.5, c.height); }
    for (let z = 0; z <= l.h; z += 2) { g.moveTo(0, z * k + 0.5); g.lineTo(c.width, z * k + 0.5); }
    g.stroke();
    for (let z = 0; z < l.h; z++) for (let x = 0; x < l.w; x++) {
      const v = l.cells[z * l.w + x]; if (v === 0) continue;
      g.fillStyle = v === WALL ? col.wall : v === DOOR ? col.door : v === WINDOW ? col.win : v === LOW || v === HIGH ? col.prop : col.floor;
      g.fillRect(x * k, z * k, k, k);
    }
    // Entry points
    l.entries.forEach((ep, idx) => {
      const active = idx === (this.preplan.entry ?? 0);
      g.globalAlpha = active ? 1 : 0.55; g.fillStyle = active ? col.entry : col.ink;
      g.beginPath(); g.arc(ep.x * k, ep.z * k, active ? k * 0.85 : k * 0.55, 0, 6.28); g.fill();
      if (active) {
        g.strokeStyle = col.entry; g.lineWidth = 1.5;
        g.beginPath(); g.arc(ep.x * k, ep.z * k, k * 1.15, 0, 6.28); g.stroke();
      }
    });
    g.globalAlpha = 1;
    if (l.bomb) { g.fillStyle = col.bomb; g.beginPath(); g.arc(l.bomb.x * k, l.bomb.z * k, k * 0.7, 0, 6.28); g.fill(); }
    // Pre-plan routes
    const drawRoute = (pts: { x: number; z: number }[] | undefined, col: string) => {
      if (!pts?.length) return;
      g.strokeStyle = col; g.lineWidth = 2.4; g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath();
      pts.forEach((p, i) => { if (i === 0) g.moveTo(p.x * k, p.z * k); else g.lineTo(p.x * k, p.z * k); });
      g.stroke();
      const last = pts[pts.length - 1];
      g.fillStyle = col; g.beginPath(); g.arc(last.x * k, last.z * k, 4, 0, 6.28); g.fill();
    };
    drawRoute(this.preplan.teamB, col.b);
    drawRoute(this.preplan.teamA, col.a);
    for (const mk of this.preplan.pins ?? []) {
      g.fillStyle = mk.kind === 'c2' ? '#f59e0b' : '#38bdf8';
      g.beginPath(); g.arc(mk.x * k, mk.z * k, 5, 0, 6.28); g.fill();
      g.fillStyle = '#fff'; g.font = 'bold 8px sans-serif'; g.textAlign = 'center';
      g.fillText(mk.kind === 'c2' ? 'C2' : 'FB', mk.x * k, mk.z * k - 7);
    }
  }

  /** Four camera tiles for the CCTV briefing look — one cropped view per room. */
  private buildCamWall() {
    const wall = $('briefCams');
    if (!wall || wall.childElementCount) return;
    wall.innerHTML = Array.from({ length: 4 }, (_, i) => `
      <figure class="cam">
        <canvas width="340" height="200"></canvas>
        <figcaption><b>CAM ${String(i + 1).padStart(2, '0')}</b><span class="camroom"></span></figcaption>
        <span class="camtime">02:14:0${i}</span>
        <span class="camrec">REC</span>
      </figure>`).join('');
  }
  /** Picks the four rooms worth watching: wherever the suspects and civilians are. */
  private camRooms(l: Level): Room[] {
    const heads = new Map<number, number>();
    for (const p of [...l.suspects, ...l.civs]) heads.set(p.room, (heads.get(p.room) ?? 0) + 1);
    const scored = l.rooms
      .filter(r => r.w >= 3 && r.h >= 3 && r.kind !== 'corridor')
      .map(r => ({ r, score: (heads.get(r.id) ?? 0) * 20 + Math.min(r.w * r.h, 80) / 8 }));
    scored.sort((a, b) => b.score - a.score);
    const picked = scored.slice(0, 4).map(o => o.r);
    for (const r of l.rooms) { if (picked.length >= 4) break; if (!picked.includes(r)) picked.push(r); }
    return picked;
  }
  /** Renders the security-camera feeds (green tint, crop around the room). */
  drawCamFeeds() {
    const l = this.briefLevel; if (!l) return;
    const wall = $('briefCams'); if (!wall) return;
    const cams = wall.querySelectorAll<HTMLCanvasElement>('.cam canvas'); if (!cams.length) return;
    const rooms = this.camRooms(l);
    const cap = wall.querySelectorAll<HTMLElement>('.camroom');
    const pal = { floor: '#0d2a1a', wall: '#8fdc9f', door: '#ffd166', win: '#7fd4ff', prop: '#12341f' };
    cams.forEach((c, i) => {
      const room = rooms[i % rooms.length];
      if (!room) return;
      if (cap[i]) cap[i].textContent = room.name;
      const cw = 340, ch = 200;
      if (c.width !== cw) { c.width = cw; c.height = ch; }
      const g = c.getContext('2d'); if (!g) return;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = '#05100a'; g.fillRect(0, 0, cw, ch);
      // wide enough to read the layout, tight enough that each camera frames its own room
      // each camera has its own spread so the four feeds do not look alike
      const spread = [0.40, 0.50, 0.62, 0.74][i % 4];
      const k = Math.max(4, Math.min(cw / (l.w * spread), ch / (l.h * spread)));
      const ox = cw / 2 - (room.x + room.w / 2) * k, oz = ch / 2 - (room.z + room.h / 2) * k;
      g.save(); g.translate(ox, oz); g.scale(k, k);
      g.fillStyle = pal.floor;
      for (let z = 0; z < l.h; z++) for (let x = 0; x < l.w; x++) {
        const v = l.cells[z * l.w + x]; if (v === 0) continue;
        g.fillStyle = v === WALL ? pal.wall : v === DOOR ? pal.door : v === WINDOW ? pal.win : v === LOW || v === HIGH ? pal.prop : pal.floor;
        g.fillRect(x, z, 1.02, 1.02);
      }
      const ep = l.entries[this.preplan.entry ?? 0];
      if (ep) {
        g.fillStyle = '#7ef2a8'; g.beginPath(); g.arc(ep.x, ep.z, 0.9, 0, 6.28); g.fill();
        g.strokeStyle = '#7ef2a8'; g.lineWidth = 0.18;
        g.beginPath(); g.arc(ep.x, ep.z, 1.5, 0, 6.28); g.stroke();
      }
      g.restore();
      // fade everything the camera is not watching, and frame the watched room
      const rx = ox + room.x * k, rz = oz + room.z * k, rw = room.w * k, rh = room.h * k;
      const dim = 'rgba(3,9,6,.55)';
      g.fillStyle = dim;
      g.fillRect(0, 0, cw, Math.max(0, rz));
      g.fillRect(0, rz + rh, cw, Math.max(0, ch - rz - rh));
      g.fillRect(0, rz, Math.max(0, rx), rh);
      g.fillRect(rx + rw, rz, Math.max(0, cw - rx - rw), rh);
      g.strokeStyle = 'rgba(126,242,168,.55)'; g.lineWidth = 1.5;
      g.strokeRect(Math.max(1, rx) + 0.5, Math.max(1, rz) + 0.5, Math.min(rw, cw - 2), Math.min(rh, ch - 2));
      // lens vignette + a slow scan band, so it reads as video and not as a map
      const vg = g.createRadialGradient(cw / 2, ch / 2, ch * 0.25, cw / 2, ch / 2, ch * 0.95);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.62)');
      g.fillStyle = vg; g.fillRect(0, 0, cw, ch);
      g.fillStyle = 'rgba(150,255,190,.05)';
      g.fillRect(0, (i * 43) % ch, cw, 2);
    });
  }
  buildWheel() {
    const ring = document.querySelector('#wheel .wring')!;
    const items: { label: string; cmd: Command }[] = [
      { label: 'Follow', cmd: { team: 'ALL', action: 'follow' } },
      { label: 'Sök & Säkra', cmd: { team: 'ALL', action: 'secure' } },
      { label: 'Hold / Cover', cmd: { team: 'ALL', action: 'cover' } },
      { label: 'Stack Up', cmd: { team: 'ALL', action: 'stack' } },
      { label: 'Breach', cmd: { team: 'ALL', action: 'breach' } },
      { label: 'Bang & Clear', cmd: { team: 'ALL', action: 'bang' } },
      { label: 'C2 Breach', cmd: { team: 'ALL', action: 'c2' } },
      { label: 'FiberCam Peek', cmd: { team: 'ALL', action: 'peek' } },
      { label: 'Handcuff', cmd: { team: 'ALL', action: 'restrain' } },
    ];
    const dense = items.length > 8, ringR = dense ? 124 : 116;
    if (dense) ring.classList.add('dense');
    items.forEach((it, i) => {
      const ang = (i / items.length) * Math.PI * 2 - Math.PI / 2;
      const b = document.createElement('button'); b.className = 'wslice'; b.textContent = it.label;
      b.style.left = `${170 + Math.cos(ang) * ringR}px`; b.style.top = `${170 + Math.sin(ang) * ringR}px`;
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
    if (!this.bodycamOn) $('bcCensor').innerHTML = '';
    this.audio.ui();
  }
  pipActors(): Actor[] {
    if (!this.sim) return [];
    const others = this.sim.players.filter(pl => pl !== this.sim!.player);
    return [...others, ...this.sim.officers];
  }
  togglePip(cycle = true) {
    if (!this.sim) return;
    if (this.pipOn && this.pipKind === 'optiwand') {
      this.pipKind = 'ally';
      this.optiwandDoor = null;
      $('pipFrame').classList.remove('optiwand');
      show('pipMeta', false);
      this.pipOn = false; this.pipManual = false;
      show('pipFrame', false);
      this.audio.ui();
      return;
    }
    const list = this.pipActors();
    if (!list.length) return;
    this.pipKind = 'ally';
    $('pipFrame').classList.remove('optiwand');
    show('pipMeta', false);
    if (!this.pipOn) { this.pipOn = true; this.pipActorIdx = 0; this.pipTimer = 0; this.pipManual = true; }
    else if (cycle) {
      this.pipActorIdx++;
      if (this.pipActorIdx >= list.length) { this.pipOn = false; this.pipManual = false; this.pipActorIdx = 0; }
    } else { this.pipOn = false; this.pipManual = false; }
    show('pipFrame', this.pipOn);
    this.audio.ui();
  }
  triggerPipFor(team: Team | 'ALL', who: number | null, dur = 6) {
    if (!S.pip || !this.sim || this.pipManual || this.pipKind === 'optiwand') return;
    const list = this.pipActors();
    const targetOfficer = who != null ? this.sim.officers[who] : this.sim.officers.find(o => o.alive && (team === 'ALL' || o.team === team));
    if (!targetOfficer || !targetOfficer.alive) return;
    const idx = list.indexOf(targetOfficer);
    if (idx < 0) return;
    this.pipKind = 'ally';
    $('pipFrame').classList.remove('optiwand');
    show('pipMeta', false);
    this.pipActorIdx = idx;
    this.pipOn = true;
    this.pipTimer = dur;
    show('pipFrame', true);
  }
  toggleDispatch(on = !this.dispatchOn) {
    this.dispatchOn = on;
    show('dispatchPanel', on);
    if (on) { this.keys.clear(); this.mouseDown = false; if (document.pointerLockElement) document.exitPointerLock(); }
    this.audio.ui();
  }
  initDispatch() {
    const run = (kind: string, payload?: string) => {
      if (this.state !== 'play' || !this.sim || this.sim.over || this.mirror) return;
      if (kind === 'blackout' || kind === 'panic' || kind === 'rush' || kind === 'false_alarm' || kind === 'vip_name') {
        const msg = this.sim.dispatchAction(kind, payload);
        if (msg) this.audio.radio();
      }
    };
    (window as any).__taDispatch = run;
    if ('BroadcastChannel' in window) {
      try {
        const bc = new BroadcastChannel('teamai-dispatch');
        bc.onmessage = ev => { if (ev.data?.kind) run(String(ev.data.kind), ev.data.payload); };
      } catch { /* ignore */ }
    }
    const wsUrl = params.get('ws');
    if (wsUrl) {
      try {
        const ws = new WebSocket(wsUrl);
        ws.onmessage = ev => { try { const d = JSON.parse(String(ev.data)); if (d?.kind) run(String(d.kind), d.payload); } catch { /* ignore */ } };
      } catch { /* ignore */ }
    }
  }
  bindUI() {
    const click = (id: string, fn: () => void) => { $(id).onclick = () => { this.audio.init(); this.audio.ui(); fn(); }; };
    click('btnBack', () => { this.dispatchPlaying = false; this.audio.stopDispatch(); show('brief', false); show('menu', true); });
    click('btnGo', () => {
      this.dispatchPlaying = false;
      this.audio.stopDispatch();
      show('brief', false);
      this.newRound(this.mission, this.preplan);
    });
    click('btnPlayDispatch', () => {
      this.audio.init();
      const btn = $('btnPlayDispatch');
      if (this.dispatchPlaying) {
        this.dispatchPlaying = false;
        this.audio.stopDispatch();
        btn.textContent = '▶ PLAY 911 DISPATCH';
        btn.classList.remove('playing');
      } else {
        this.dispatchPlaying = true;
        btn.textContent = '■ STOP DISPATCH';
        btn.classList.add('playing');
        this.audio.playDispatch(this.mission, this.speech, () => {
          this.dispatchPlaying = false;
          btn.textContent = '▶ PLAY 911 DISPATCH';
          btn.classList.remove('playing');
        });
      }
    });
    document.querySelectorAll<HTMLElement>('.plan-tools .ptool').forEach(b => {
      b.onclick = () => {
        this.audio.ui();
        this.planTool = b.dataset.pt as 'B' | 'A' | 'c2' | 'flash';
        document.querySelectorAll<HTMLElement>('.plan-tools .ptool').forEach(o => o.classList.toggle('on', o === b));
      };
    });
    click('btnClearPlan', () => {
      this.preplan.teamA = [];
      this.preplan.teamB = [];
      this.preplan.pins = [];
      this.drawBriefPlan();
    });
    // Interactive route & marker drawing on #briefMap
    const bmap = $<HTMLCanvasElement>('briefMap');
    let drawingRoute = false;
    const mapCoord = (ev: PointerEvent) => {
      const rect = bmap.getBoundingClientRect();
      const l = this.briefLevel; if (!l) return null;
      const x = ((ev.clientX - rect.left) / rect.width) * l.w;
      const z = ((ev.clientY - rect.top) / rect.height) * l.h;
      return { x: Math.max(0.5, Math.min(l.w - 0.5, x)), z: Math.max(0.5, Math.min(l.h - 0.5, z)) };
    };
    bmap.addEventListener('pointerdown', ev => {
      const pt = mapCoord(ev); if (!pt) return;
      if (this.planTool === 'c2' || this.planTool === 'flash') {
        this.preplan.pins = this.preplan.pins ?? [];
        this.preplan.pins.push({ x: pt.x, z: pt.z, kind: this.planTool });
        this.audio.ui();
        this.drawBriefPlan();
      } else {
        drawingRoute = true;
        if (this.planTool === 'A') this.preplan.teamA = [pt];
        else this.preplan.teamB = [pt];
        this.drawBriefPlan();
      }
    });
    bmap.addEventListener('pointermove', ev => {
      if (!drawingRoute) return;
      const pt = mapCoord(ev); if (!pt) return;
      const arr = this.planTool === 'A' ? this.preplan.teamA! : this.preplan.teamB!;
      const last = arr[arr.length - 1];
      if (!last || Math.hypot(pt.x - last.x, pt.z - last.z) >= 1.2) {
        arr.push(pt);
        this.drawBriefPlan();
      }
    });
    window.addEventListener('pointerup', () => { drawingRoute = false; });
    click('btnResume', () => this.resume());
    click('btnRestart', () => { show('pause', false); this.newRound(this.mission); });
    click('btnMicRetry', () => { if (!S.mic) { S.mic = 1; saveSettings(); this.applySettings(); } this.voice.stop(); this.voice.start(); });
    click('btnNewTab', () => { window.open(location.href.split('?')[0], '_blank'); });
    click('btnQuit', () => this.toMenu()); click('btnMenu', () => this.toMenu());
    click('btnAgain', () => { show('debrief', false); if (this.isDaily) { const di = dailyInfo(); this.start(di.mission, di.seed, 1, 0, Math.max(1, S.diff)); this.lock(); } else this.newRound(this.mission); });
    click('btnNext', () => {
      const next = this.mission + 1;
      if (next >= MISSIONS.length || !missionUnlocked(best, next)) return;
      show('debrief', false); this.isDaily = false; this.newRound(next);
    });
    click('btnDispatchToggle', () => { show('pause', false); this.state = 'play'; this.toggleDispatch(true); });
    click('btnCloseDispatch', () => { this.toggleDispatch(false); if (this.state === 'play') this.lock(); });
    document.querySelectorAll<HTMLElement>('#dispatchPanel [data-dp]').forEach(b => b.onclick = () => {
      if (this.state !== 'play' || !this.sim || this.mirror) return;
      this.sim.dispatchAction(b.dataset.dp as any);
      this.audio.radio();
    });
    click('btnDpVip', () => {
      if (this.state !== 'play' || !this.sim || this.mirror) return;
      const inp = $<HTMLInputElement>('dpVipName');
      this.sim.dispatchAction('vip_name', inp.value);
      inp.value = '';
      this.audio.ok();
    });
    click('btnReplayToggle', () => {
      this.replayPlaying = !this.replayPlaying;
      $('btnReplayToggle').textContent = this.replayPlaying ? 'Pause' : 'Play';
    });
    click('btnReplayRestart', () => {
      this.replayTime = 0;
      this.replayPlaying = true;
      $('btnReplayToggle').textContent = 'Pause';
    });
    this.bindNet();
    for (const id of ['btnHelp', 'btnHelp2']) click(id, () => show('help', true));
    for (const id of ['btnSettings', 'btnSettings2']) click(id, () => show('settings', true));
    document.querySelectorAll<HTMLElement>('.stabs button').forEach(b => b.onclick = () => { document.querySelectorAll<HTMLElement>('.stabs button').forEach(o => { o.classList.toggle('on', o === b); $(o.dataset.stab!).classList.toggle('hidden', o !== b); }); });
    document.querySelectorAll<HTMLElement>('.close').forEach(b => b.onclick = () => { b.closest('.screen')!.classList.add('hidden'); this.audio.ui(); });
    const bind = (id: string, k: keyof Settings, num = true) => $(id).addEventListener('input', e => { (S as any)[k] = num ? +(e.target as HTMLInputElement).value : (e.target as HTMLInputElement).value; saveSettings(); this.applySettings(); });
    ($('sAiModel') as HTMLSelectElement).innerHTML = AI_MODELS.map(m => `<option value="${m.id}">${m.label}</option>`).join('');
    bind('sSens', 'sens'); bind('sAdsSens', 'adsSens'); bind('sVol', 'vol'); bind('sMusic', 'music'); bind('sMic', 'mic'); bind('sPtt', 'ptt'); bind('sLang', 'lang', false); bind('sAsr', 'asr', false); bind('sTts', 'tts'); bind('sHead', 'head'); bind('sQual', 'qual'); bind('sDiff', 'diff'); bind('sAi', 'ai'); bind('sAiModel', 'aiModel', false); bind('sStream', 'stream'); bind('sCensor', 'censor'); bind('sPip', 'pip');
    click('btnMenuMusic', () => { S.music = S.music ? 0 : 1; saveSettings(); this.applySettings(); });
    $('btnAiLoad').onclick = () => {
      this.audio.init(); this.audio.ui();
      if (!S.ai) { S.ai = 1; saveSettings(); ($('sAi') as HTMLSelectElement).value = '1'; }
      void this.ai.ensureLoaded(S.aiModel);
    };
  }
  toMenu() { this.stopReplay(); this.dispatchPlaying = false; this.audio.stopDispatch(); document.body.classList.remove('ingame'); this.net.close(); this.connIdx.clear(); this.connName.clear(); this.lobbyMeta.clear(); this.lobbyReady = false; this.debReady = false; show('lobby', false); this.state = 'menu'; this.speech.stop(); this.voice.stop(); for (const id of ['pause', 'debrief', 'hud', 'brief', 'pipFrame', 'dispatchPanel', 'radioCard', 'coopHud', 'breachBanner', 'ffWarn']) show(id, false); $('bcCensor').innerHTML = ''; this.pipOn = false; this.pipManual = false; this.pipKind = 'ally'; this.optiwandDoor = null; this.dispatchOn = false; this.isDaily = false; this.buildMenu(); this.updateRankDock(); show('menu', true); this.syncMenuMusic(); if (document.pointerLockElement) document.exitPointerLock(); }
  // ---------------- online co-op ----------------
  private currentMods(): CoopMods & { daily?: boolean } {
    const black = ($('modBlackout') as HTMLInputElement).checked;
    const extra = ($('modExtra') as HTMLInputElement).checked ? 4 : 0;
    const pistol = ($('modPistol') as HTMLInputElement).checked;
    const ff = ($('modFF') as HTMLInputElement).checked;
    const daily = ($('modDaily') as HTMLInputElement).checked;
    return { blackout: black, extraHostiles: extra, pistolOnly: pistol, friendlyFire: ff, daily };
  }
  newRound(mission: number, preplan?: PrePlan) {
    if (this.net.role === 'client') return;
    const mods = this.net.role === 'host' ? this.currentMods() : {};
    const useDaily = !!mods.daily;
    const di = dailyInfo();
    const mUse = useDaily ? di.mission : mission;
    const seed = useDaily ? di.seed : ((Math.random() * 1e6) | 0);
    this.isDaily = useDaily;
    if (this.net.role === 'host') {
      const conns = this.net.conns.slice(0, 3), names = [S.name || 'Host', ...conns.map((c, i) => this.connName.get(c) || 'Player ' + (i + 2))];
      const shields = [this.lobbyPrim === 'shield', ...conns.map(c => (this.lobbyMeta.get(c)?.prim ?? 'carbine') === 'shield')];
      this.connIdx.clear();
      this.lobbyMeta.forEach(meta => { meta.debReady = false; });
      this.debReady = false;
      conns.forEach((c, i) => { this.connIdx.set(c, i + 1); c.send({ t: 'start', mission: mUse, seed, diff: S.diff, n: names.length, you: i + 1, names, mods, daily: useDaily, shields, preplan: preplan ?? this.preplan }); });
      this.start(mUse, seed, names.length, 0, S.diff, names, mods, shields, preplan ?? this.preplan);
    } else this.start(mUse, seed, 1, 0, S.diff, [], {}, [], preplan ?? {});
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
    this.net.onRadioSquelch = start => this.audio.squelch(start);
    $('btnCopy').onclick = () => { const link = location.origin + location.pathname + '?join=' + this.net.code; const done = () => { $('btnCopy').textContent = 'Link copied!'; setTimeout(() => { $('btnCopy').textContent = 'Copy invite link'; }, 1800); }; if (navigator.clipboard?.writeText) navigator.clipboard.writeText(link).then(done, () => prompt('Copy the link:', link)); else prompt('Copy the link:', link); };
    const name = $<HTMLInputElement>('mpName'); name.value = S.name; name.addEventListener('input', () => { S.name = name.value.trim().slice(0, 12); saveSettings(); });
    const busy = (on: boolean) => { for (const id of ['btnHost', 'btnJoin']) ($(id) as HTMLButtonElement).disabled = on; if (on) $('mpErr').textContent = 'Connecting to the matchmaking service… (may take a few seconds)'; };
    $('btnHost').onclick = async () => { this.audio.init(); busy(true); try { await this.net.host(); $('mpErr').textContent = ''; this.lobbyPrim = S.primary; this.lobbySec = S.secondary; this.lobbyReady = true; show('menu', false); show('lobby', true); this.lobby(); } catch (e) { err(e); } busy(false); };
    $('btnJoin').onclick = async () => {
      const code = $<HTMLInputElement>('mpCode').value.trim(); if (code.length < 4) { $('mpErr').textContent = 'Enter the room code you got from the host.'; return; }
      this.audio.init(); busy(true);
      try {
        await this.net.join(code);
        this.lobbyPrim = S.primary; this.lobbySec = S.secondary; this.lobbyReady = false;
        this.net.send({ t: 'hello', name: S.name || 'Player', prim: this.lobbyPrim, sec: this.lobbySec, ready: this.lobbyReady });
        $('mpErr').textContent = ''; show('menu', false); show('lobby', true); this.lobby();
      } catch (e) { err(e); this.net.close(); }
      busy(false);
    };
    $('btnLeave').onclick = () => this.toMenu();
    $('btnLobbyStart').onclick = () => { this.audio.init(); this.newRound(+($('lobbyMission') as HTMLSelectElement).value); };
    $('btnLobbyReady').onclick = () => {
      this.audio.ui();
      this.lobbyReady = !this.lobbyReady;
      if (this.net.role === 'client') this.net.send({ t: 'lobbyMeta', ready: this.lobbyReady, prim: this.lobbyPrim, sec: this.lobbySec });
      this.lobby();
    };
    $('btnDebReady').onclick = () => {
      this.audio.ui();
      this.debReady = !this.debReady;
      if (this.net.role === 'client') this.net.send({ t: 'debReady', ready: this.debReady });
      this.updateDebReadyUi();
    };
    const lp = $('lobbyPrim') as HTMLSelectElement, ls = $('lobbySec') as HTMLSelectElement;
    lp.value = S.primary; ls.value = S.secondary;
    const syncLobbyLo = () => {
      this.lobbyPrim = lp.value as PrimaryLoadout; this.lobbySec = ls.value as SecondaryLoadout;
      S.primary = this.lobbyPrim; S.secondary = this.lobbySec; saveSettings();
      if (this.net.role === 'client') this.net.send({ t: 'lobbyMeta', ready: this.lobbyReady, prim: this.lobbyPrim, sec: this.lobbySec });
      this.lobby();
    };
    lp.onchange = syncLobbyLo; ls.onchange = syncLobbyLo;
    for (const id of ['modBlackout', 'modExtra', 'modPistol', 'modFF', 'modDaily']) {
      $(id).addEventListener('change', () => { if (this.net.role === 'host') this.lobby(); });
    }
    const sel = $('lobbyMission') as HTMLSelectElement; sel.innerHTML = MISSIONS.map((m, i) => `<option value="${i}">Mission ${i + 1}: ${m.name}</option>`).join(''); sel.onchange = () => this.lobby();
    this.net.onPeers = () => {
      if (this.net.role !== 'host') return;
      if (this.sim && (this.state === 'play' || this.state === 'pause')) {
        for (const [c, i] of this.connIdx) if (!this.net.conns.includes(c)) {
          const pa = this.sim.players[i]; this.connIdx.delete(c);
          if (pa?.alive) { pa.alive = false; pa.downed = false; pa.hp = 0; this.log(`${pa.name} disconnected (slot held for reconnect).`, 'warn'); this.sim.checkPlayers(); }
        }
      }
      this.lobby();
    };
    this.net.onClosed = why => { if (!this.net.online) return; this.toMenu(); $('mpErr').textContent = why; };
    this.net.onMsg = (c, m) => { if (this.net.role === 'host') this.fromClient(c, m); else this.fromHost(m); };
    $('btnTts').onclick = () => { this.audio.init(); setTimeout(() => { $('latInfo').textContent = this.audio.latencyMs ? `Audio latency reported by the browser: ${this.audio.latencyMs} ms.` : ''; }, 300); const n = this.speech.voiceCount; if (!this.speak('Copy, following you.', null, { voice: 'o1' })) this.speech.say('Team A, copy. Following you.', 1, 1.1, 1, true); $('ttsInfo').textContent = n === 0 ? 'The browser has no speech voices – lines without a recorded clip stay silent. Install a voice in the operating system’s speech settings or use Chrome/Edge.' : this.speech.hasLangVoice ? `${n} voices found. Hear nothing? Check the volume and that the tab is not muted.` : `${n} voices found, but none in the chosen language – the browser's default voice is used.`; };
  }
  lobbyMe = 0;
  private updateDebReadyUi() {
    if (!this.net.online) { show('debReadyRow', false); return; }
    show('debReadyRow', true);
    const isClient = this.net.role === 'client';
    $('btnDebReady').classList.toggle('hidden', !isClient);
    $('btnDebReady').textContent = this.debReady ? 'Ready ✔' : 'Ready for Next Op';
    $('btnDebReady').classList.toggle('primary', this.debReady);
    const total = Math.max(1, this.lobbyList.length);
    const rdyCount = this.net.role === 'host'
      ? 1 + this.net.conns.filter(c => this.lobbyMeta.get(c)?.debReady).length
      : this.lobbyList.filter(p => p.debReady).length;
    $('debReadyTxt').textContent = `${rdyCount}/${total} operators ready for next op`;
  }
  lobby() {
    const host = this.net.role === 'host';
    if (host) {
      this.lobbyNames = [S.name || 'Host', ...this.net.conns.map((c, i) => this.connName.get(c) || 'Player ' + (i + 2))];
      this.lobbyIds = [this.net.id, ...this.net.conns.map(c => c.peer)];
      this.lobbyMission = +($('lobbyMission') as HTMLSelectElement).value;
      this.lobbyMods = this.currentMods();
      const spk = this.net.sampleSpeaking();
      this.lobbyList = [
        { name: this.lobbyNames[0], peerId: this.net.id, ready: this.lobbyReady, prim: this.lobbyPrim, sec: this.lobbySec, speaking: spk.local, debReady: true },
        ...this.net.conns.map((c, i) => {
          const meta = this.lobbyMeta.get(c);
          return { name: this.lobbyNames[i + 1], peerId: c.peer, ready: !!meta?.ready, prim: meta?.prim ?? 'carbine', sec: meta?.sec ?? 'pistol', speaking: !!spk.peers[c.peer], debReady: !!meta?.debReady };
        }),
      ];
      this.net.broadcast({ t: 'lobby', names: this.lobbyNames, ids: this.lobbyIds, mission: this.lobbyMission, list: this.lobbyList, mods: this.lobbyMods, preplan: this.preplan });
    }
    const list = this.lobbyList.length ? this.lobbyList : (this.lobbyNames.length ? this.lobbyNames : ['Connecting…']).map((n, i) => ({ name: n, peerId: this.lobbyIds[i] || '', ready: i === 0, prim: 'carbine' as PrimaryLoadout, sec: 'pistol' as SecondaryLoadout, speaking: false, debReady: false }));
    const loName: Record<string, string> = { carbine: 'TX-4', shotgun: 'S-87', beanbag: 'LL-12', shield: 'SHIELD', pistol: 'P-17', taser: 'ARC-2' };
    $('lobbyCode').textContent = this.net.code;
    const spk = this.net.sampleSpeaking();
    $('lobbyPlayers').innerHTML = list.map((p, i) => {
      const isMe = i === (host ? 0 : this.lobbyMe);
      const micOn = isMe ? spk.local : (!!p.speaking || (p.peerId ? !!spk.peers[p.peerId] : false));
      return `<li><span>${p.name.replace(/[<>&]/g, '')}${i === 0 ? ' <em>host</em>' : ''}${isMe ? ' <em class="you">you</em>' : ''}</span><span class="lp-tags">${micOn ? '<b class="lp-mic">MIC</b>' : ''}<span class="lp-lo">${loName[p.prim] || 'TX-4'}+${loName[p.sec] || 'P-17'}</span><span class="${p.ready ? 'lp-rdy' : 'lp-wait'}">${p.ready ? 'READY' : 'WAIT'}</span></span></li>`;
    }).join('');
    const hostName = (this.lobbyNames[0] || 'the host').replace(/[<>&]/g, '');
    $('lobbyTitle').textContent = host ? 'Your room – you are the host' : 'You have joined ' + hostName + '’s room';
    $('btnCopy').classList.toggle('hidden', !host);
    $('lobbyWait').classList.toggle('hidden', host);
    $('lobbyWait').textContent = 'Connected ✔  Adjust your loadout, toggle Ready, and wait for ' + hostName + ' to launch.';
    $('lobbySelLabel').textContent = host ? 'Mission' : 'Mission (the host chooses)';
    ($('lobbyMission') as HTMLSelectElement).disabled = !host; if (!host) ($('lobbyMission') as HTMLSelectElement).value = String(this.lobbyMission);
    for (const [id, val] of [['modBlackout', !!this.lobbyMods.blackout], ['modExtra', !!this.lobbyMods.extraHostiles], ['modPistol', !!this.lobbyMods.pistolOnly], ['modFF', !!this.lobbyMods.friendlyFire], ['modDaily', !!this.lobbyMods.daily]] as const) {
      const el = $(id) as HTMLInputElement;
      el.disabled = !host;
      if (!host) el.checked = val;
    }
    $('btnLobbyReady').classList.toggle('hidden', host);
    $('btnLobbyReady').textContent = this.lobbyReady ? 'Ready ✔' : 'Ready';
    $('btnLobbyReady').classList.toggle('primary', this.lobbyReady);
    $('btnLobbyStart').classList.toggle('hidden', !host);
    $('lobbyInfo').textContent = (host ? 'Give the room code to your friends. Up to 4 players. Reconnect supported with matching callsign.' : 'The game starts automatically when the host launches.') + (this.net.micOk ? ' Spatial Voice & Tactical Radio active.' : this.net.stream ? ' Listen-only voice mode.' : ' Allow microphone access to join voice chat.');
  }
  fromHost(m: Msg) {
    const sim = this.sim;
    if (m.t === 'lobby') {
      this.lobbyMe = (m.ids as string[]).indexOf(this.net.id);
      this.lobbyNames = m.names; this.lobbyIds = m.ids || []; this.lobbyMission = m.mission;
      if (m.list) this.lobbyList = m.list;
      if (m.mods) this.lobbyMods = m.mods;
      if (m.preplan) this.preplan = m.preplan;
      this.net.callPeers(m.ids);
      if (!$('lobby').classList.contains('hidden')) this.lobby();
      if (!$('debrief').classList.contains('hidden')) this.updateDebReadyUi();
    }
    else if (m.t === 'start') { this.isDaily = !!m.daily; this.debReady = false; this.start(m.mission, m.seed, m.n, m.you, m.diff, m.names, m.mods || {}, m.shields || [], m.preplan || this.preplan || {}); }
    else if (m.t === 'snap' && sim && (this.state === 'play' || this.state === 'pause')) applySnap(sim, m.s, sim.player, this.netTargets);
    else if (m.t === 'ev' && sim && (this.state === 'play' || this.state === 'pause')) for (const e of m.e) this.handle(decodeEv(sim, e));
  }
  fromClient(c: DataConnection, m: Msg) {
    if (m.t === 'hello') {
      const nm = String(m.name || 'Player').slice(0, 12);
      this.connName.set(c, nm);
      this.lobbyMeta.set(c, { ready: !!m.ready, prim: (m.prim as PrimaryLoadout) || 'carbine', sec: (m.sec as SecondaryLoadout) || 'pistol', debReady: false });
      // Drop-in / Reconnect into active match if matching disconnected slot exists
      if (this.sim && !this.sim.over && (this.state === 'play' || this.state === 'pause')) {
        const sim = this.sim;
        const activeIdxs = new Set(this.connIdx.values());
        let slot = sim.players.findIndex((pl, idx) => idx > 0 && !activeIdxs.has(idx) && pl.name.toLowerCase() === nm.toLowerCase());
        if (slot < 0) slot = sim.players.findIndex((_, idx) => idx > 0 && !activeIdxs.has(idx));
        if (slot > 0) {
          const pa = sim.players[slot];
          pa.name = nm; pa.alive = true; pa.downed = false; pa.hp = Math.max(50, pa.hp || 75);
          pa.shield = m.prim === 'shield';
          this.connIdx.set(c, slot);
          const names = sim.players.map(pl => pl.name);
          const shields = sim.players.map(pl => pl.shield);
          c.send({ t: 'start', mission: sim.mission, seed: this.seed, diff: sim.difficulty, n: sim.players.length, you: slot, names, mods: sim.mods, daily: this.isDaily, shields });
          setTimeout(() => { if (c.open && this.sim === sim) c.send({ t: 'snap', s: encodeSnap(sim) }); }, 200);
          this.log(`${nm} reconnected to the operation!`, 'me');
          this.lobby();
          return;
        }
      }
      this.lobby();
      return;
    }
    if (m.t === 'lobbyMeta') {
      const cur = this.lobbyMeta.get(c) ?? { ready: false, prim: 'carbine' as PrimaryLoadout, sec: 'pistol' as SecondaryLoadout };
      cur.ready = !!m.ready;
      if (m.prim) cur.prim = m.prim;
      if (m.sec) cur.sec = m.sec;
      this.lobbyMeta.set(c, cur);
      this.lobby();
      return;
    }
    if (m.t === 'debReady') {
      const cur = this.lobbyMeta.get(c) ?? { ready: true, prim: 'carbine' as PrimaryLoadout, sec: 'pistol' as SecondaryLoadout };
      cur.debReady = !!m.ready;
      this.lobbyMeta.set(c, cur);
      this.lobby();
      this.updateDebReadyUi();
      return;
    }
    const sim = this.sim, i = this.connIdx.get(c); if (!sim || !i || sim.over) return; const pa = sim.players[i]; if (!pa) return;
    const num = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    if (m.t === 'ping') { sim.playerPing(pa, num(m.o[0]), num(m.o[1]), num(m.o[2]), num(m.d[0]), num(m.d[1]), num(m.d[2])); return; }
    if (!pa.alive) return;
    switch (m.t) {
      case 'in': { const x = num(m.x), z = num(m.z), d = Math.hypot(x - pa.x, z - pa.z); if (!pa.downed && d < 3 && !sim.solidCell(Math.floor(x), Math.floor(z))) { pa.x = x; pa.z = z; pa.walk += d * 2.4; sim.pushTrail(pa); } pa.yaw = num(m.yaw); pa.pitch = num(m.pitch); pa.crouch = !!m.cr; pa.prone = !!m.pr; pa.jumpY = Math.max(0, Math.min(0.8, num(m.jy))); pa.moving = !pa.downed && !!m.mv; pa.torch = m.tc !== undefined ? !!m.tc : pa.torch; pa.ads = !!m.ads; pa.weapon = num(m.wp); pa.shield = !!m.sh; pa.speaking = !!m.sp; break; }
      case 'fire': if (!pa.downed) sim.fire(pa, num(m.o[0]), num(m.o[1]), num(m.o[2]), num(m.d[0]), num(m.d[1]), num(m.d[2]), Math.min(34, num(m.dmg)), { nonLethal: !!m.nl, taser: !!m.ts, pen: m.pen ? 1 : 0 }); break;
      case 'use': sim.playerUse(pa); break;
      case 'crack': sim.playerUse(pa, { crack: true }); break;
      case 'sensor': sim.deploySensor(pa); break;
      case 'c2': sim.playerC2(pa); break;
      case 'wedge': sim.playerWedge(pa); break;
      case 'peek': sim.playerPeek(pa); break;
      case 'shout': sim.playerShout(pa); break;
      case 'breachSync': sim.toggleBreachSync(pa); break;
      case 'share': sim.shareGear(pa); break;
      case 'bang': {
        if (pa.downed) break;
        const gk = m.kind === 'smoke' ? 'smoke' : m.kind === 'gas' ? 'gas' : 'bang';
        if (gk === 'smoke' && pa.smokes > 0) { pa.smokes--; sim.throwGrenade(num(m.o[0]), num(m.o[1]), num(m.o[2]), num(m.d[0]), num(m.d[1]), num(m.d[2]), 'smoke'); }
        else if (gk === 'gas' && pa.gases > 0) { pa.gases--; sim.throwGrenade(num(m.o[0]), num(m.o[1]), num(m.o[2]), num(m.d[0]), num(m.d[1]), num(m.d[2]), 'gas'); }
        else if (gk === 'bang' && pa.bangs > 0) { pa.bangs--; sim.throwGrenade(num(m.o[0]), num(m.o[1]), num(m.o[2]), num(m.d[0]), num(m.d[1]), num(m.d[2]), 'bang'); }
        break;
      }
      case 'cmd': sim.command(m.cmd, m.aim ?? null, pa); break;
    }
  }
  get mirror() { return this.net.role === 'client'; }
  lock() { if (!AUTO) { const p: any = $('c').requestPointerLock(); if (p?.catch) p.catch(() => { }); } }
  resume() { show('pause', false); this.state = 'play'; this.lock(); if (S.mic) this.voice.start(); this.last = performance.now(); }
  pause() { if (this.state !== 'play') return; this.state = 'pause'; show('pause', true); this.micState(this.voice.state); this.keys.clear(); this.mouseDown = false; }

  // ---------------- mission start ----------------
  private starting = false;
  async start(mission: number, seed: number, n = 1, me = 0, diff: number = S.diff, names: string[] = [], mods: CoopMods = {}, shields: boolean[] = [], preplan: PrePlan = {}) {
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
      for (const id of ['lobby', 'debrief', 'pause', 'brief', 'firstrun', 'help', 'settings', 'menu']) show(id, false);
      show('loading', true);
      await nextFrame();
      await nextFrame();
      await withTimeout(assetsDone, 10000);
      setLoad(62, 'Building operation environment...');
      await nextFrame();

      this.mission = mission; this.seed = seed; this.audio.init(); void this.audio.setMenuMusic(false); this.audio.stopDispatch();
      document.body.classList.remove('menu-wait');
      this.netTargets.clear(); this.pings = []; this.breachBannerT = 0;
      // career roster: injured officers sit out, rookies take their place (solo only)
      if (!this.net.online && !mods.roster) {
        mods.roster = deployRoster(career).map(o => ({ name: o.name, role: o.role, speed: o.speed, hp: o.hp }));
      }
      const sim = this.sim = new Sim(mission, seed, diff, n, mods, preplan); if (me) sim.player = sim.players[me];
      sim.players.forEach((pl, i) => {
        if (names[i]) pl.name = names[i];
        if (!mods.pistolOnly && shields[i]) pl.shield = true;
      });
      this.stepPh.clear();
      this.recentSay.clear(); this.recentBarkActor.clear(); this.recentBarkKind.clear(); this.recentBarkLine.clear(); this.lastTeamShoutT = 0;
      const mp = this.net.online; $('btnRestart').classList.toggle('hidden', mp || career.ironman); $('btnAgain').classList.toggle('hidden', this.net.role === 'client'); $('btnNext').classList.toggle('hidden', this.net.role === 'client'); show('vc', mp);
      show('coopHud', sim.players.length > 1);
      show('breachBanner', false); show('ffWarn', false);
      this.post?.dispose(); this.post = null; this.postScene = null;
      this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x070a10); this.scene.fog = new THREE.FogExp2(0x070a10, 0.0135);
      if (S.qual > 0) { this.scene.environment = studioEnv(this.renderer); this.scene.environmentIntensity = S.qual >= 3 ? 0.3 : S.qual === 2 ? 0.22 : 0.14; }
      this.ambLight = new THREE.AmbientLight(0x9fb0c8, (mods.blackout ? (S.qual ? 0.05 : 0.1) : (S.qual ? 0.15 : 1.1)));
      this.nvgLight = new THREE.AmbientLight(0x6aff99, 0);
      this.scene.add(this.ambLight, this.nvgLight, new THREE.HemisphereLight(0xb8c8ff, 0x2a241c, mods.blackout ? (S.qual ? 0.08 : 0.18) : (S.qual ? 0.2 : 0.55)));
      const moon = new THREE.DirectionalLight(0xa8c0ff, mods.blackout ? 0.3 : 0.7); moon.position.set(-8, 14, 6); this.scene.add(moon);
      this.level?.dispose();
      this.level = new LevelView(sim, S.qual); this.scene.add(this.level.group);
      this.fx = new FX(); this.scene.add(this.fx.group);
      this.views.clear(); for (const a of sim.actors) { if (a === sim.player) continue; const v = new ActorView(a); this.views.set(a, v); this.scene.add(v.root); }
      this.scene.add(this.camera); this.camera.add(this.torch); this.torch.position.set(0.15, -0.1, 0); this.camera.add(this.torch.target); this.torch.target.position.set(0, 0, -1);
      if (!mods.pistolOnly) sim.player.shield = (this.net.online ? this.lobbyPrim : S.primary) === 'shield';
      else sim.player.shield = false;
      const ws = this.weaponSpecs;
      this.yaw = sim.player.yaw; this.pitch = 0; this.weapon = 0; this.ammo = [ws[0].mag, ws[1].mag]; this.reserve = [ws[0].res, ws[1].res]; this.reloadT = 0; this.fireCd = 0; this.recoil = 0; this.recoilPitch = 0; this.recoilRoll = 0; this.camShake = 0; this.dmgFx = 0; this.hitFx = 0; this.hitHead = false; this.endT = 0;
      this.shieldHits = 0; this.suppressFx = 0; this.highReadyK = 0; this.speedReload = false; this.reloadShell = false; this.reloadDur = 2; this.breathT = 0; this.acousticT = 0; this.sensorPingSfxT = 0;
      setShieldCracks(this.vm.shield, 0);
      this.torch.castShadow = S.qual >= 2;
      this.lean = 0; this.leanTarget = 0; this.grenadeType = 'bang'; this.magnifier = false;
      this.nvgOn = false; this.bodycamOn = !!S.stream; this.wheelOn = false; this.pipOn = false; this.pipManual = false; this.pipTimer = 0; this.pipKind = 'ally'; this.optiwandDoor = null; this.dispatchOn = false; this.stress = 0; this.clubBeatT = 0; this.hbT = 0; this.radioCardT = 0; this.fireMode = 'auto';
      this.stopReplay();
      show('nvg', false); show('bodycam', this.bodycamOn); show('wheel', false); show('pipFrame', false); $('pipFrame').classList.remove('optiwand'); show('pipMeta', false); show('dispatchPanel', false); show('radioCard', false); $('bcCensor').innerHTML = '';
      $('bcSector').textContent = SECTOR_LOCS[mission] ?? 'SECTOR UNKNOWN';
      this.renderer.toneMappingExposure = S.qual ? 1.0 : 1.15;
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
      if (!this.mirror && ((preplan.teamA?.length ?? 0) > 1 || (preplan.teamB?.length ?? 0) > 1 || (preplan.pins?.length ?? 0) > 0)) {
        sim.executePreplan();
      }
      this.log(`Command: ${MISSIONS[mission].name}${this.isDaily ? ' [DAILY IRONMAN]' : ''} (${ws[0].name} + ${ws[1].name}). Q/E Lean, Shift+F Crack, O FiberCam, , Sensor, . Grenade.`, 'me');
    } finally {
      show('loading', false);
      this.starting = false;
    }
  }

  // ---------------- input ----------------
  bindInput() {
    const c = $('c');
    c.addEventListener('click', () => { if (this.state === 'play' && !document.pointerLockElement) this.lock(); });
    document.addEventListener('pointerlockchange', () => { if (!document.pointerLockElement && this.state === 'play' && !AUTO && !this.typing && !this.wheelOn && !this.dispatchOn) this.pause(); });
    document.addEventListener('mousemove', e => {
      if (this.state !== 'play' || (!document.pointerLockElement && !AUTO)) return;
      const adsMul = 1 - this.aimK * (1 - S.adsSens);
      const k = 0.0022 * S.sens * adsMul; this.yaw -= e.movementX * k; this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - e.movementY * k));
      this.sway.x += e.movementX * 0.00012; this.sway.y += e.movementY * 0.00012;
    });
    document.addEventListener('mousedown', e => {
      if (this.state !== 'play' || !document.pointerLockElement) return;
      if (e.button === 0) {
        this.mouseDown = true;
        const sp = this.sim?.player; const ws = this.weaponSpecs[this.weapon];
        // Interrupt shell-by-shell shotgun reload on click if at least 1 shell is chambered
        if (this.reloadShell && this.reloadT > 0 && this.ammo[this.weapon] > 0) {
          this.reloadT = 0; this.reloadShell = false;
        }
        if (sp?.alive && !sp.downed && !this.typing && !this.wheelOn && this.fireCd <= 0 && this.reloadT <= 0 && this.ammo[this.weapon] > 0 && !this.semiLock && !this.preShot && !ws.taser) { this.preShot = true; this.audio.shot(0, 0, true, this.activeGun(ws)); }
      }
      if (e.button === 1) { e.preventDefault(); this.ping(); }
      if (e.button === 2) this.ads = true;
    });
    document.addEventListener('contextmenu', e => { if (this.state === 'play') e.preventDefault(); });
    document.addEventListener('mouseup', e => { if (e.button === 0) { this.mouseDown = false; this.semiLock = false; } if (e.button === 2) this.ads = false; });
    // Flight through the briefing looks with 1-0 while the briefing is open.
    document.addEventListener('keydown', e => {
      if (this.typing || $('brief').classList.contains('hidden')) return;
      const m = /^Digit([0-9])$/.exec(e.code); if (!m) return;
      const st = BRIEF_STYLES[+m[1] === 0 ? 9 : +m[1] - 1]; if (!st) return;
      e.preventDefault(); this.applyBriefStyle(st.id); this.audio.ui();
    });
    document.addEventListener('keydown', e => {
      if (this.typing) { if (e.code === 'Enter') { const inp = $<HTMLInputElement>('cmdinput'); const v = inp.value.trim(); inp.value = ''; this.setTyping(false); if (v) this.heard(v, false); e.preventDefault(); } else if (e.code === 'Escape') this.setTyping(false); return; }
      if (e.code === 'Escape') { if (this.dispatchOn) { this.toggleDispatch(false); this.lock(); return; } if (this.wheelOn) { this.toggleWheel(false); this.lock(); return; } if (!$('help').classList.contains('hidden') || !$('settings').classList.contains('hidden')) { show('help', false); show('settings', false); } else if (this.state === 'pause') this.resume(); else if (this.state === 'play' && AUTO) this.pause(); return; }
      if (this.state !== 'play') return;
      if (e.code === 'Tab' || e.code === 'Space' || e.code === 'CapsLock') e.preventDefault();
      if (e.repeat) return; this.keys.add(e.code); this.onKey(e.code, e.shiftKey);
    });
    document.addEventListener('wheel', e => {
      if (this.state !== 'play' || !this.ads || !document.pointerLockElement) return;
      if (this.activeGun() === 'rifle') {
        this.magnifier = e.deltaY < 0 ? true : e.deltaY > 0 ? false : !this.magnifier;
        this.audio.ui();
        this.updateHud(true);
      }
    }, { passive: true });
    document.addEventListener('keyup', e => { this.keys.delete(e.code); if (e.code === 'KeyV') this.voice.release(); });
    window.addEventListener('blur', () => { this.voice.release(); this.keys.clear(); this.mouseDown = false; });
  }
  setTyping(on: boolean) { this.typing = on; show('cmdbox', on); const inp = $<HTMLInputElement>('cmdinput'); if (on) { this.keys.clear(); inp.focus(); } else inp.blur(); }
  onKey(code: string, shift = false) {
    const sim = this.sim!; if (sim.over) return;
    const quick: Record<string, Command['action'] | 'there'> = { Digit3: 'follow', Digit4: 'hold', Digit5: 'there', Digit6: 'cover', Digit7: 'stack', Digit8: 'breach', Digit9: 'bang', Digit0: 'restrain', F2: 'secure' };
    switch (code) {
      case 'KeyF': {
        if (this.mirror) { this.net.send({ t: shift ? 'crack' : 'use' }); break; }
        if (sim.interactTarget()) sim.playerUse(sim.player, { crack: shift });
        else this.shout(true);
        break;
      }
      case 'Comma': {
        if (this.mirror) this.net.send({ t: 'sensor' });
        else sim.deploySensor(sim.player);
        this.updateHud(true);
        break;
      }
      case 'CapsLock': this.shout(true); break;
      case 'KeyO': {
        if (this.mirror) {
          if (sim.interactTarget()?.door) this.net.send({ t: 'peek' });
          else this.shareGear();
        } else {
          const msg = sim.playerPeek(sim.player);
          if (msg) { this.log(msg, 'me'); this.audio.ui(); }
          else if (sim.players.length > 1) this.shareGear();
        }
        break;
      }
      case 'KeyU': if (this.mirror) this.net.send({ t: 'c2' }); else sim.playerC2(sim.player); break;
      case 'KeyY': if (this.mirror) this.net.send({ t: 'wedge' }); else if (sim.playerWedge(sim.player)) this.audio.wedge(); break;
      case 'KeyN': this.toggleNvg(); break;
      case 'KeyK': this.toggleBodycam(); break;
      case 'KeyP': this.togglePip(true); break;
      case 'KeyJ': this.breachSync(); break;
      case 'F8': this.toggleDispatch(); if (!this.dispatchOn) this.lock(); break;
      case 'KeyH': this.toggleWheel(); if (!this.wheelOn) this.lock(); break;
      case 'KeyB': if (this.net.online) { this.net.setMuted(!this.net.muted); this.audio.ui(); } break;
      case 'KeyR': {
        const now = performance.now();
        const isDouble = now - this.lastRT < 360;
        this.lastRT = now;
        this.reload(isDouble);
        break;
      }
      case 'KeyG': this.throwBang(); break;
      case 'Backquote': case 'Period': {
        const order: ('bang' | 'smoke' | 'gas')[] = ['bang', 'smoke', 'gas'];
        this.grenadeType = order[(order.indexOf(this.grenadeType) + 1) % order.length];
        this.audio.ui();
        this.updateHud(true);
        break;
      }
      case 'ShiftLeft': case 'ShiftRight': {
        if (this.ads && this.activeGun() === 'rifle') {
          this.magnifier = !this.magnifier;
          this.audio.ui();
          this.updateHud(true);
        }
        break;
      }
      case 'KeyV': if (S.ptt && S.mic) { if (this.voice.state !== 'listening' && this.voice.state !== 'starting') { this.voice.stop(); this.voice.start(); } if (!this.voice.held) $('heard').textContent = ''; this.voice.press(); } else this.shout(true); break;
      case 'KeyT': this.torchOn = !this.torchOn; this.audio.dry(); this.updateHud(true); break;
      case 'KeyL': this.laserOn = !this.laserOn; this.audio.dry(); this.updateHud(true); break;
      case 'KeyI': {
        const w = this.weaponSpecs[this.weapon];
        if (w.canSemi) {
          this.fireMode = this.fireMode === 'auto' ? 'semi' : 'auto';
          this.audio.fireMode();
          this.updateHud(true);
        }
        break;
      }
      case 'KeyM': this.mapOn = !this.mapOn; break;
      case 'KeyC': if (sim.player.prone) { sim.player.prone = false; sim.player.crouch = true; } else sim.player.crouch = !sim.player.crouch; break;
      case 'KeyZ': sim.player.prone = !sim.player.prone; sim.player.crouch = false; break;
      case 'KeyX': this.slow = !this.slow; this.audio.ui(); break;
      case 'Space': { const pl = sim.player; if (pl.prone || pl.crouch) { pl.prone = false; pl.crouch = false; } else if (pl.jumpY <= 0 && pl.alive) this.jumpV = 3.4; break; }
      case 'Digit1': case 'Digit2': { const w = code === 'Digit1' ? 0 : 1; if (w !== this.weapon) { this.weapon = w; this.reloadT = 0; this.reloadShell = false; this.speedReload = false; this.fireCd = 0.35; this.vmKick = -0.5; this.audio.draw(); if (!this.weaponSpecs[w].shield) this.arms.draw(); this.updateHud(true); } break; }
      case 'Tab': this.selTeam = this.selTeam === 'ALL' ? 'A' : this.selTeam === 'A' ? 'B' : 'ALL'; this.audio.ui(); this.updateHud(true); break;
      case 'Enter': this.setTyping(true); break;
      default: if (quick[code]) { const q = quick[code]; this.exec(q === 'there' ? { team: this.selTeam, action: 'move', dir: 'there' } : { team: this.selTeam, action: q }, true); }
    }
  }

  // ---------------- commands ----------------
  lastSay = ''; lastSayT = 0; lastInfo = ''; lastInfoT = 0; micS = ''; micD: string | undefined;
  private recentSay = new Map<string, number>();
  private recentBarkActor = new Map<number, number>();
  private recentBarkKind = new Map<string, number>();
  private recentBarkLine = new Map<string, number>();
  private lastTeamShoutT = 0;
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
  private showRadioCard(said: string, action: string) {
    const rc = $('radioCard');
    const esc = (s: string) => s.replace(/[<>&]/g, '');
    rc.innerHTML = `<span class="rc-tag">TAC-RADIO</span><span class="rc-said">«${esc(said)}»</span><span class="rc-act">→ ${esc(action)}</span>`;
    show('radioCard', true);
    this.radioCardT = 4.5;
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
      if (cmd.action === 'breach' || cmd.action === 'bang' || cmd.action === 'c2' || cmd.action === 'peek' || cmd.action === 'defuse') {
        this.triggerPipFor(cmd.team, cmd.who ?? null, 6);
      }
      const one = cmd.who != null ? sim.officers[cmd.who] : null;
      this.lastTeam = one ? one.team : cmd.team;
      this.selTeam = this.lastTeam;
      this.lastWho = cmd.who ?? null;
    }
    const speaker = (sim.officers[res.speaker]?.alive ? sim.officers[res.speaker] : sim.officers.find(o => o.alive)) ?? null;
    p.textContent = labels.length ? `AI › ${labels.join(' · ')}` : `AI › ${speaker ? speaker.name.toUpperCase() : 'SWAT'} RADIO`;
    const heardTxt = $('heard').textContent?.replace(/^«\s*|\s*»$/g, '') || '';
    if (heardTxt) this.showRadioCard(heardTxt, labels.join(' · ') || 'RADIO REPLY');
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
      if (cmd.action === 'breach' || cmd.action === 'bang' || cmd.action === 'c2' || cmd.action === 'peek' || cmd.action === 'defuse') {
        this.triggerPipFor(cmd.team, cmd.who ?? null, 6);
      }
      this.lastTeam = one ? one.team : cmd.team;
      this.selTeam = this.lastTeam;
      this.lastWho = cmd.who ?? null;
    }
    const p = $('parsed'); p.className = ''; this.parsedT = 4;
    p.textContent = labels.join(' · ');
    const heardTxt = $('heard').textContent?.replace(/^«\s*|\s*»$/g, '') || '';
    if (heardTxt && labels.length) this.showRadioCard(heardTxt, labels.join(' · '));
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
  reload(speed = false) {
    const w = this.weaponSpecs[this.weapon];
    if (this.ammo[this.weapon] >= w.mag || this.reserve[this.weapon] <= 0) return;
    if (this.reloadT > 0) {
      if (speed && !this.speedReload && !this.reloadShell) {
        this.speedReload = true;
        this.reloadT = Math.max(0.25, this.reloadT * 0.58);
        this.audio.reload(this.activeGun(w), this.reloadT, true);
      }
      return;
    }
    const gun = this.activeGun(w);
    if (gun === 'shotgun') {
      this.reloadShell = true;
      this.speedReload = false;
      this.reloadDur = 0.48;
      this.reloadT = this.reloadDur;
      if (!w.shield) this.arms.reload(0.9);
      this.audio.shotgunShell();
    } else {
      this.reloadShell = false;
      this.speedReload = speed;
      this.reloadDur = speed ? w.reload * 0.62 : w.reload;
      this.reloadT = this.reloadDur;
      if (!w.shield) this.arms.reload(this.reloadDur);
      this.audio.reload(gun, this.reloadDur, speed);
    }
    this.updateHud(true);
  }
  throwBang() {
    const sim = this.sim!, p = sim.player; if (!p.alive || p.downed) return;
    let gk = this.grenadeType;
    const countOf = (k: 'bang' | 'smoke' | 'gas') => k === 'smoke' ? p.smokes : k === 'gas' ? p.gases : p.bangs;
    if (countOf(gk) <= 0) {
      const alt = (['bang', 'smoke', 'gas'] as const).find(k => countOf(k) > 0);
      if (!alt) return;
      gk = alt;
      this.grenadeType = alt;
    }
    const d = this.aimDir(), o = [p.x + d.x * 0.4, this.eye - 0.1, p.z + d.z * 0.4];
    if (this.mirror) this.net.send({ t: 'bang', o, d: [d.x, d.y, d.z], kind: gk });
    else {
      if (gk === 'smoke') p.smokes--;
      else if (gk === 'gas') p.gases--;
      else p.bangs--;
      sim.throwGrenade(o[0], o[1], o[2], d.x, d.y, d.z, gk);
    }
    this.vmKick = -0.6;
    this.updateHud(true);
  }
  ping() {
    const sim = this.sim; if (!sim || !sim.player.alive || sim.over) return;
    const p = sim.player, d = this.aimDir();
    if (this.mirror) this.net.send({ t: 'ping', o: [p.x, this.eye, p.z], d: [d.x, d.y, d.z] });
    else sim.playerPing(p, p.x, this.eye, p.z, d.x, d.y, d.z);
  }
  breachSync() {
    const sim = this.sim; if (!sim || !sim.player.alive || sim.player.downed || sim.over) return;
    if (this.mirror) this.net.send({ t: 'breachSync' });
    else sim.toggleBreachSync(sim.player);
    this.audio.ui();
  }
  shareGear() {
    const sim = this.sim; if (!sim || !sim.player.alive || sim.player.downed || sim.over) return;
    if (this.mirror) this.net.send({ t: 'share' });
    else sim.shareGear(sim.player);
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
    const pellets = w.pellets ?? 1;
    const ak = this.aimK;
    const semiMul = w.canSemi && this.fireMode === 'semi' ? 0.52 : 1;
    const laserMul = this.laserOn && !w.taser ? 0.72 : 1;
    const moveMul = moving ? (2.6 - ak * 1.5) : 1;
    const crouchMul = p.crouch ? 0.6 : 1;
    const adsSpreadMul = pellets > 1 ? (1 - ak * 0.42) : (1 - ak * 0.96);
    const adsRecoilMul = 1 - ak * 0.78;
    const firstAimedShot = pellets === 1 && ak > 0.82 && this.recoil <= w.kick * 1.15;
    const sp = firstAimedShot ? 0 : (w.spread * semiMul * laserMul * moveMul * crouchMul * adsSpreadMul + this.recoil * 0.25 * adsRecoilMul);

    // Sync camera world matrix so ADS shots originate at the exact optical screen center (including lean)
    const bobScale = 1 - ak * 0.85;
    const lo = sim.leanOffset(p, this.lean);
    const ox = p.x + lo.lx, oy = this.eye + Math.sin(this.bob * 2) * 0.022 * bobScale - Math.abs(lo.actual) * 0.06, oz = p.z + lo.lz;
    this.camera.position.set(ox, oy, oz);
    this.camera.rotation.set(
      Math.min(1.45, this.pitch + this.recoilPitch),
      this.yaw,
      (!p.alive ? 0.5 : p.downed ? 0.22 : (this.bodycamOn ? 0.035 + Math.sin(this.bob) * 0.015 : Math.sin(this.bob) * 0.004 * bobScale) - lo.actual * 0.13) + this.recoilRoll,
    );
    this.camera.updateMatrixWorld();
    const baseDir = new THREE.Vector3();
    this.camera.getWorldDirection(baseDir);

    for (let i = 0; i < pellets; i++) {
      const d = baseDir.clone();
      if (sp > 0) {
        d.x += (Math.random() - 0.5) * sp * 2;
        d.y += (Math.random() - 0.5) * sp * 2;
        d.z += (Math.random() - 0.5) * sp * 2;
        d.normalize();
      }
      if (this.mirror) { this.net.send({ t: 'fire', o: [ox, oy, oz], d: [d.x, d.y, d.z], dmg: w.dmg, nl: !!w.nonLethal, ts: !!w.taser, pen: w.pen ?? 0 }); }
      else sim.fire(p, ox, oy, oz, d.x, d.y, d.z, w.dmg, { nonLethal: !!w.nonLethal, taser: !!w.taser, pen: w.pen ?? 0 });
    }
    const gunType = this.activeGun(w);
    if (this.mirror && !this.preShot && !w.taser) this.audio.shot(0, 0, true, gunType);
    this.preShot = false;
    const kickScale = (1 - ak * 0.35) * semiMul;
    this.stress = Math.min(1, this.stress + 0.14);
    this.recoil = Math.min(0.11, this.recoil + w.kick * kickScale);
    this.pitch = Math.min(1.45, this.pitch + w.kick * 0.38 * kickScale);
    this.recoilPitch = Math.min(0.08, this.recoilPitch + w.kick * (gunType === 'shotgun' ? 1.8 : 1.15) * kickScale);
    this.recoilRoll += (Math.random() - 0.5) * w.kick * 0.85 * (1 - ak * 0.5);
    this.yaw += (Math.random() - 0.5) * w.kick * 0.42 * (1 - ak * 0.6);
    this.camShake = Math.max(this.camShake, gunType === 'shotgun' ? 0.014 : 0.004);
    this.vmKick = 1;
    if (!w.shield) this.arms.fire();
    if (!w.taser) {
      this.vm.flash.visible = true; this.vm.flash.material.rotation = Math.random() * 6; setTimeout(() => { this.vm.flash.visible = false; }, 45);
      // Lingering muzzle smoke + eject brass shell / shotgun hull to the right
      const f = fwd(this.yaw), rx = -f.z, rz = f.x;
      this.fx.gunsmoke(ox + f.x * 0.55 + rx * (0.08 * (1 - ak)), oy - 0.07, oz + f.z * 0.55 + rz * (0.08 * (1 - ak)), f.x, Math.sin(this.pitch), f.z, gunType === 'shotgun' ? 3 : 2);
      const hull = gunType === 'shotgun';
      const col = hull ? (w.nonLethal ? 0x2f85d8 : 0xb82424) : 0xd8a840;
      this.fx.shell(ox + f.x * 0.32 + rx * 0.14, oy - 0.1, oz + f.z * 0.32 + rz * 0.14, rx * (1.8 + Math.random() * 0.9) + (Math.random() - 0.5) * 0.4, 1.3 + Math.random() * 0.8, rz * (1.8 + Math.random() * 0.9) + (Math.random() - 0.5) * 0.4, col, hull);
    }
  }

  // ---------------- events ----------------
  pan(x: number, z: number) { const p = this.sim!.player, dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz) || 1; return { d, pan: ((dx * Math.cos(this.yaw) - dz * Math.sin(this.yaw)) / d) * Math.min(1, d / 3) }; }
  log(text: string, cls = '') { const el = document.createElement('div'); el.className = cls; el.textContent = text; const box = $('log'); box.appendChild(el); while (box.children.length > 6) box.firstChild!.remove(); setTimeout(() => el.remove(), 7000); }
  handle(e: Ev) {
    const sim = this.sim!, p = sim.player, fx = this.fx;
    switch (e.t) {
      case 'shot': {
        const own = e.by === p, a = new THREE.Vector3(e.x, e.y, e.z), b = new THREE.Vector3(e.x2, e.y2, e.z2);
        if (own) {
          const r = fwd(this.yaw), ak = this.aimK, lo = sim.leanOffset(p, this.lean);
          a.set(p.x + lo.lx + r.x * 0.5 - r.z * (0.12 * (1 - ak)), this.eye - (0.12 - 0.07 * ak), p.z + lo.lz + r.z * 0.5 + r.x * (0.12 * (1 - ak)));
        } else this.views.get(e.by)?.muzzle();
        fx.tracer(a, b); const pn = this.pan(e.x, e.z);
        const muffle = !own && !sim.los(p.x, p.z, e.x, e.z);
        if (own && this.preShot) this.preShot = false;
        else if (!(own && this.mirror)) this.audio.shot(pn.d, pn.pan, own, own ? this.activeGun() : e.by.kind === 'suspect' ? 'smg' : 'rifle', muffle);
        fx.flashAt(a.x, a.y, a.z, own ? 14 : 22);
        fx.burst(a.x, a.y, a.z, 2, 0x9aa4b0, 0.9, -0.3, 0.35);
        if (e.hit === 'wall') {
          const mat = e.mat ?? 'concrete';
          const sparkCol = mat === 'metal' ? 0xffe090 : mat === 'wood' ? 0xc29258 : 0xb8b0a0;
          fx.burst(e.x2, e.y2, e.z2, 9, sparkCol, 2.5, 6, 0.38);
          if (mat !== 'wood') fx.burst(e.x2, e.y2, e.z2, 4, 0xffd080, 4.6, 9, 0.18);
          if (mat === 'wood') fx.debris(e.x2, e.y2, e.z2, 4, 'wood');
          const dx = e.x2 - e.x, dy = e.y2 - e.y, dz = e.z2 - e.z, len = Math.hypot(dx, dy, dz) || 1;
          const nx = e.nx ?? -(dx / len), ny = e.ny ?? -(dy / len), nz = e.nz ?? -(dz / len);
          fx.hole(e.x2, e.y2, e.z2, nx, ny, nz, mat);
          const q = this.pan(e.x2, e.z2); if (q.d < 12) this.audio.impact(q.d, q.pan);
        }
        else if (e.hit === 'actor') {
          fx.burst(e.x2, e.y2, e.z2, e.head ? 20 : 12, 0x8a0f0f, e.head ? 3.1 : 2.4, 7, 0.55);
          if (own) {
            this.hitFx = 1;
            this.hitHead = !!(e.head || e.kill);
            this.audio.hitmark(!!e.head, !!e.kill);
          }
        }
        break;
      }
      case 'pen': {
        fx.burst(e.x, e.y, e.z, 8, 0xb68652, 2.6, 5, 0.4);
        fx.debris(e.x, e.y, e.z, 5, 'wood');
        fx.hole(e.x, e.y, e.z, e.nx, e.ny, e.nz, 'wood');
        break;
      }
      case 'taser': {
        const a = new THREE.Vector3(e.x, e.y, e.z), b = new THREE.Vector3(e.x2, e.y2, e.z2);
        fx.tracer(a, b, 0x50d8ff);
        const pn = this.pan(e.x, e.z); this.audio.taser(pn.d, pn.pan);
        fx.burst(e.x2, e.y2, e.z2, 10, 0x60e0ff, 2.4, 7, 0.45);
        break;
      }
      case 'c2': { const q = this.pan(e.x, e.z); this.audio.c2(q.d, q.pan); if (q.d < 14) this.camShake = Math.max(this.camShake, (1 - q.d / 14) * 0.045); fx.flashAt(e.x, 1.2, e.z, 600, 0.12, 0xffa848); fx.burst(e.x, 1.1, e.z, 45, 0xffb860, 6, 4, 0.6); fx.burst(e.x, 1.1, e.z, 25, 0x8a6d48, 4, 6, 0.9); fx.debris(e.x, 1.0, e.z, 14, 'wood'); break; }
      case 'glass': { const q = this.pan(e.x, e.z); this.audio.glass(q.d, q.pan); fx.burst(e.x, 1.5, e.z, 28, 0xb8e8ff, 4.2, 7, 0.7); fx.debris(e.x, 1.35, e.z, 10, 'glass'); break; }
      case 'smoke': case 'gas': {
        const q = this.pan(e.x, e.z);
        this.audio.smokeHiss(q.d, q.pan);
        fx.burst(e.x, 0.35, e.z, 18, e.t === 'gas' ? 0xa3e635 : 0xd0d8e0, 2.2, -0.3, 0.9);
        break;
      }
      case 'optiwand': {
        this.pipKind = 'optiwand';
        this.optiwandDoor = e.door;
        this.optiwandSide = e.side;
        this.optiwandMeta = e.msg;
        this.pipOn = true;
        this.pipManual = false;
        this.pipTimer = 7.5;
        $('pipFrame').classList.add('optiwand');
        $('pipLabel').textContent = 'FIBERCAM // UNDER-DOOR CAM';
        $('pipMeta').textContent = e.msg;
        show('pipMeta', true);
        show('pipFrame', true);
        this.audio.ui();
        break;
      }
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
      case 'phone': { const q = this.pan(e.x, e.z); if (q.d < 18) this.audio.phoneRing(q.d, q.pan); break; }
      case 'bomb': { if (e.kind === 'defused') { this.audio.defuse(); this.log('Explosive device disarmed!', 'me'); } else { this.audio.c2(0, 0); fx.flashAt(e.x, 1, e.z, 900, 0.2, 0xff4020); this.log('Explosive detonated!', 'warn'); } break; }
      case 'hurt': this.views.get(e.a)?.wound(); if (e.a === p) { this.dmgFx = 1; this.stress = Math.min(1, this.stress + 0.42); this.audio.hurt(); this.recoil += 0.03; } else if (e.a.kind !== 'officer') { /* hit marker only for own shots handled below */ } break;
      case 'death': if (e.a !== p) { fx.burst(e.a.x, 1.1, e.a.z, 26, 0x8a0f0f, 2.6, 8, 0.7); fx.burst(e.a.x, 0.5, e.a.z, 14, 0x6a0808, 1.4, 6, 0.9); } if (e.a.kind === 'officer') this.log(`${e.a.name} has been killed.`, 'warn'); break;
      case 'door': { const q = this.pan(e.door.cx + 0.5, e.door.cz + 0.5); this.audio.door(q.d, q.pan, e.open, !!e.kick); break; }
      case 'say': {
        const o = e.a;
        const key = e.text.replace(/^Team [AB]: /, ''), now = performance.now();
        const prevT = this.recentSay.get(key) ?? 0;
        const minGap = e.shout ? 5000 : 8000;
        const dup = now - prevT < minGap || (e.shout && now - this.lastTeamShoutT < 4000);
        if (!(e.shout && now - prevT < 3500)) this.log(`${o.name}: ${key}`, o.team);
        if (dup) break;
        this.recentSay.set(key, now); this.lastSay = key; this.lastSayT = now;
        if (e.shout) this.lastTeamShoutT = now;
        this.audio.radio();
        const ms = (!e.shout || Math.random() < 0.6) ? this.speak(e.text, o, { pitch: [0.85, 1.25, 0.65, 1.05][o.slot] ?? 1, rate: e.shout ? 1.35 : 1.2, gain: e.shout ? 1 : 0.85 }) : 0;
        if (o.kind === 'officer' && !e.shout) this.audio.radioSquelch(ms ? Math.min(1.8, ms / 1000) : 0.4);
        break;
      }
      case 'bang': { const q = this.pan(e.x, e.z); this.audio.bang(q.d, q.pan, p.flash); if (q.d < 12) this.camShake = Math.max(this.camShake, (1 - q.d / 12) * 0.032); fx.flashAt(e.x, 1, e.z, 900, 0.12, 0xffffff); fx.burst(e.x, 0.3, e.z, 60, 0xffffff, 7, 3, 0.5); fx.burst(e.x, 0.3, e.z, 30, 0x999999, 2, -0.5, 1.6); break; }
      case 'throw': this.audio.step(0.3); break;
      case 'shout': if (e.a !== p) {
        const now = performance.now(), prevT = this.recentSay.get(SHOUTS[0]) ?? 0;
        if (now - prevT < 4500 || now - this.lastTeamShoutT < 4000) break;
        this.recentSay.set(SHOUTS[0], now); this.lastTeamShoutT = now;
        this.log(`${e.a.name}: Police! Drop the weapon!`, '');
        const q = this.pan(e.a.x, e.a.z);
        if (!this.audio.hasLine(SHOUTS[0]) || !S.tts) this.audio.vocal('shout', 0.9, q.d, q.pan);
        else this.speak(SHOUTS[0], e.a, { gain: 1 / (1 + q.d * 0.1), pan: q.pan });
      } break;
      case 'bark': {
        const a = e.a, q = this.pan(a.x, a.z); if (q.d > 22) break;
        const near = sim.los(p.x, p.z, a.x, a.z) ? 1 : 0.45, pitch = (a.kind === 'civ' ? 1.25 : 0.85) + (a.variant % 3) * 0.12;
        const d2 = q.d / near; // muffled through walls
        const clip = !!S.tts && this.audio.linesReady; // recorded lines replace the synthetic shout
        if (e.kind === 'pain') { this.audio.vocal('pain', pitch, d2, q.pan); break; }
        if (e.kind === 'die') { this.audio.vocal('die', pitch, d2, q.pan); break; }

        const now = performance.now();
        const actorGap = e.kind === 'surrender' ? 2500 : 9000;
        const kindGap = e.kind === 'spot' ? 7000 : e.kind === 'surrender' ? 2200 : 6000;
        if (now - (this.recentBarkActor.get(a.id) ?? 0) < actorGap) break;
        if (now - (this.recentBarkKind.get(e.kind) ?? 0) < kindGap) break;

        const pickFresh = (l: string[], minFallback = 20000) => {
          const fresh = l.filter(x => now - (this.recentBarkLine.get(x) ?? 0) >= 35000);
          if (fresh.length) return fresh[Math.floor(Math.random() * fresh.length)];
          const oldest = [...l].sort((x, y) => (this.recentBarkLine.get(x) ?? 0) - (this.recentBarkLine.get(y) ?? 0))[0];
          return now - (this.recentBarkLine.get(oldest) ?? 0) >= minFallback ? oldest : '';
        };

        let line = '';
        if (e.kind === 'spot') { line = pickFresh(['Cops!', 'The cops are here!', "They're coming in!", 'Shoot them!', 'We got company!', 'Get them!']); if (line && !clip) this.audio.vocal('shout', pitch, d2, q.pan); }
        else if (e.kind === 'unrest') { line = pickFresh(["I'm out of here!"]); if (line && !clip) this.audio.vocal('shout', pitch, d2, q.pan); }
        else if (e.kind === 'panic') { line = pickFresh(['Help!', 'No, no!', "Don't shoot!", "What's going on?"]); if (line) this.audio.vocal('whimper', pitch, d2, q.pan); }
        else if (e.kind === 'surrender') {
          line = a.kind === 'civ'
            ? pickFresh(["Don't shoot, please!", "I'll do what you say!", 'Help me!', "Please don't hurt me!"], 10000)
            : pickFresh(["Don't shoot! I give up!", 'Okay, okay! I give up!', "I'm dropping the gun!"], 10000);
          if (line && (!clip || a.kind === 'civ')) this.audio.vocal(a.kind === 'civ' ? 'whimper' : 'yes', pitch, d2, q.pan);
        }
        if (line && q.d < 16) {
          this.recentBarkActor.set(a.id, now);
          this.recentBarkKind.set(e.kind, now);
          this.recentBarkLine.set(line, now);
          this.log(`${a.kind === 'civ' ? 'Civilian' : 'Suspect'}: ${line}`, '');
          this.speak(line, a, { pitch: Math.min(2, pitch * 1.1), rate: 1.25, gain: Math.max(0.15, near * (1 - q.d / 20)), pan: q.pan, muffle: near < 1 });
        }
        break;
      }
      case 'cuff': { const q = this.pan(e.a.x, e.a.z); if (q.d < 10) this.audio.cuff(); if (e.by === p) this.log(e.a.kind === 'suspect' ? 'You secured a suspect.' : 'You secured a civilian.', 'me'); break; }
      case 'surrender': { const q = this.pan(e.a.x, e.a.z); if (q.d < 14 && sim.los(p.x, p.z, e.a.x, e.a.z)) this.log(e.a.kind === 'suspect' ? 'Suspect gives up – cuff them!' : 'Civilian complies – cuff them before you move on.', ''); break; }
      case 'marker': fx.marker(e.x, e.z, TEAM_COLOR[e.team]); break;
      case 'ping': {
        const col = e.label === 'HOSTILE' || e.label === 'BOMB' ? 0xff4a4a : e.label === 'BREACH' ? 0xf0b429 : e.label === 'CIVILIAN' ? 0x4fd07a : 0x38bdf8;
        const hex = '#' + col.toString(16).padStart(6, '0');
        fx.ping(e.x, e.y, e.z, col, `${e.label} (${e.by.name.slice(0, 7)})`);
        this.pings.push({ x: e.x, z: e.z, label: e.label, color: hex, t: 7 });
        this.audio.ping(e.label === 'HOSTILE' || e.label === 'BOMB');
        this.log(`${e.by.name} pinged ${e.label}`, e.label === 'HOSTILE' ? 'warn' : 'me');
        break;
      }
      case 'downed': {
        this.audio.fail();
        this.log(`${e.a.name} is DOWNED! Hold F near them to revive!`, 'warn');
        if (e.a === p && sim.players.some(pl => pl !== p && pl.alive && !pl.downed)) {
          const aliveIdx = this.pipActors().findIndex(a => a.kind === 'player' && a.alive && !a.downed);
          if (aliveIdx >= 0) { this.pipActorIdx = aliveIdx; this.pipOn = true; this.pipTimer = 0; show('pipFrame', true); }
        }
        break;
      }
      case 'revive': {
        this.audio.ok();
        this.log(`${e.by.name} revived ${e.a.name}!`, 'me');
        if (e.a === p && !this.pipManual) { this.pipOn = false; show('pipFrame', false); }
        break;
      }
      case 'breachSync': {
        const bb = $('breachBanner');
        if (e.step < 0) { show('breachBanner', false); this.breachBannerT = 0; }
        else if (e.step === 0) { bb.textContent = 'BREACH GO!'; show('breachBanner', true); this.breachBannerT = 1.4; this.audio.ok(); }
        else { bb.textContent = `BREACH SYNC IN ${e.step}...`; show('breachBanner', true); this.breachBannerT = 2.0; this.audio.radio(); }
        break;
      }
      case 'share': {
        if (e.to === p) {
          if (e.kind === 'ammo') { const ws = this.weaponSpecs; this.reserve[0] += ws[0].mag; this.reserve[1] += ws[1].mag; }
          this.audio.ok();
          this.log(`Received ${e.kind === 'bang' ? 'a flashbang' : 'spare ammo'} from ${e.from.name}!`, 'me');
        } else if (e.from === p) {
          this.audio.ui();
        }
        break;
      }
      case 'info': {
        const now = performance.now();
        if (e.text === this.lastInfo && now - this.lastInfoT < 1500) break;
        this.lastInfo = e.text; this.lastInfoT = now;
        this.log(e.text, 'warn'); this.audio.fail();
        break;
      }
      case 'shield': {
        this.shieldHits++;
        const cracks = Math.min(3, Math.ceil(this.shieldHits / 2));
        setShieldCracks(this.vm.shield, cracks);
        const dir = new THREE.Vector3(e.x, e.y, e.z).sub(this.camera.position).normalize();
        const hitPos = this.camera.position.clone().addScaledVector(dir, 0.55);
        fx.shieldHit(hitPos.x, hitPos.y, hitPos.z);
        this.audio.shieldClang();
        this.camShake = Math.max(this.camShake, 0.011);
        this.recoilRoll += (Math.random() - 0.5) * 0.014;
        break;
      }
      case 'suppress': {
        this.suppressFx = Math.min(1, Math.max(this.suppressFx, e.strength));
        this.stress = Math.min(1, this.stress + e.strength * 0.25);
        this.camShake = Math.max(this.camShake, 0.008 * e.strength);
        this.audio.impact(2.5, (Math.random() - 0.5) * 0.6);
        break;
      }
      case 'trap': {
        const cx = e.door.cx + 0.5, cz = e.door.cz + 0.5;
        if (e.kind === 'disarmed') {
          this.audio.trapDisarm();
          this.log('Door tripwire disarmed.', 'me');
        } else if (e.kind === 'found') {
          this.audio.ping(true);
          this.log('Door tripwire spotted! Press F to disarm.', 'warn');
        } else {
          const q = this.pan(cx, cz);
          this.audio.c2(q.d, q.pan);
          if (q.d < 12) this.camShake = Math.max(this.camShake, (1 - q.d / 12) * 0.048);
          fx.flashAt(cx, 1.1, cz, 700, 0.14, 0xff6020);
          fx.burst(cx, 1.0, cz, 40, 0xff9040, 6.2, 5, 0.65);
          fx.debris(cx, 1.0, cz, 12, 'wood');
          this.log('Door booby-trap detonated!', 'warn');
        }
        break;
      }
      case 'evidence': {
        this.audio.bagEvidence();
        this.log('Dropped weapon bagged as evidence (+25).', 'me');
        break;
      }
      case 'sensor': {
        if (e.kind === 'ping') {
          const now = performance.now();
          if (now - this.sensorPingSfxT > 1600) {
            this.sensorPingSfxT = now;
            this.audio.sensor();
          }
          this.pings.push({ x: e.x, z: e.z, label: 'MOTION', color: '#38bdf8', t: 1.5 });
        } else {
          this.audio.sensor();
          this.log('Acoustic wall sensor deployed.', 'me');
        }
        break;
      }
      case 'end': this.endT = 2.2; this.log(e.win ? 'The building is secure. Good work!' : 'You are down. The operation is aborted.', e.win ? 'me' : 'warn'); break;
    }
    // Note: e.t === 'shot' already sets hitFx/hitHead & plays hitmark audio above.
    if (e.t === 'hurt' && e.a === p) { this.camShake = Math.max(this.camShake, 0.018); }
  }
  debrief() {
    const sim = this.sim!, sc = sim.score(), win = !!sim.over?.win; this.state = 'end'; this.voice.stop(); if (document.pointerLockElement) document.exitPointerLock();
    show('nvg', false); show('bodycam', false); show('wheel', false); show('pipFrame', false); show('dispatchPanel', false); show('radioCard', false);
    this.pipOn = false; this.dispatchOn = false; $('bcCensor').innerHTML = '';
    $('debTitle').textContent = (win ? 'Mission completed' : (sim.over?.reason || 'Mission failed')) + (this.isDaily ? ' · DAILY IRONMAN' : '');
    $('debRank').textContent = `Grade ${sc.letter} · ${sc.rank} · ${Math.round(sim.time)}s`;
    const aw = sim.awards();
    $('debAwards').innerHTML = aw.map(a => `<div class="award-pill">${a.title}<small>${a.desc}</small></div>`).join('');
    const mvpEl = $('debSquadMvp');
    if (sim.players.length > 1) {
      const mvp = sim.squadMvp();
      mvpEl.innerHTML = mvp.map((m, idx) => `<div class="mvp-card ${idx === 0 ? 'top' : ''}"><div class="mvp-name">${m.name.replace(/[<>&]/g, '')}</div><div class="mvp-badge">${m.badge}</div><div class="mvp-stat">Arrests: ${m.arrests} · Kills: ${m.kills} · Acc: ${m.accuracy}%</div></div>`).join('');
      show('debSquadMvp', true);
    } else show('debSquadMvp', false);
    this.updateDebReadyUi();
    $('debTable').innerHTML = sc.parts.filter(p => p.max > 0 || p.pts < 0).map(p => `<tr><td>${p.label}</td><td class="${p.pts < 0 ? 'neg' : ''}">${p.pts}${p.max ? ' / ' + p.max : ''}</td></tr>`).join('') + `<tr class="total"><td>Total</td><td>${sc.total} / 100</td></tr>`;
    $('debNotes').innerHTML = sim.debriefNotes().map(n => `<div>• ${n}</div>`).join('');
    // ---- career: XP, unlocks, injuries, campaign order ----
    const solo = !this.net.online;
    const downed = sim.officers.filter(o => o.hp <= 0 || !o.alive).map(o => o.name);
    const res: AppliedResult = applyMissionResult(career, {
      win, mission: this.mission, score: sc.total,
      downed: solo ? downed : [], ironman: solo && (career.ironman || this.isDaily),
    });
    if (win) career.arrests += sim.stats.suspectsArrested;
    saveCareer(career);
    if (win) {
      if ((best[this.mission] ?? -1) < sc.total) { best[this.mission] = sc.total; localStorage.setItem('teamai.best', JSON.stringify(best)); }
      if (this.isDaily) {
        const di = dailyInfo();
        if ((dailyBest[di.key] ?? -1) < sc.total) { dailyBest[di.key] = sc.total; localStorage.setItem('teamai.daily', JSON.stringify(dailyBest)); }
      }
    }
    this.updateRankDock();
    $('mBest').textContent = `${clearedCount(best)}/${MISSIONS.length} Ops Completed`;
    this.selectMission(this.mission);
    {
      const lines: string[] = [];
      if (res.ironmanPenalty) lines.push(`<div class="dc-line neg">IRONMAN · operation failed — no XP earned</div>`);
      if (res.xpGained > 0) lines.push(`<div class="dc-line">+${res.xpGained} XP · ${res.xpAfter} XP total · ${rankOf(res.xpAfter).name}</div>`);
      if (res.rankUp) lines.push(`<div class="dc-line up">RANK UP · ${res.rankUp.name} — ${res.rankUp.note}</div>`);
      for (const g of res.unlocked) lines.push(`<div class="dc-line up">UNLOCKED · ${GEAR_NAMES[g]} — Armory › Loadout</div>`);
      for (const inj of res.injured) lines.push(`<div class="dc-line neg">INJURED · ${inj.name} sits out ${inj.ops} op${inj.ops > 1 ? 's' : ''} — a rookie stands in</div>`);
      for (const h of res.healed) lines.push(`<div class="dc-line">BACK ON DUTY · ${h}</div>`);
      if (campaignComplete(best, MISSIONS.length)) lines.push(`<div class="dc-line up">CAMPAIGN COMPLETE · every sector secured — try the Daily Raid or a random raid</div>`);
      else if (!win && best[this.mission] == null) lines.push(`<div class="dc-line">${MISSIONS[this.mission].name} is still uncleared — the next operation stays locked until it is done.</div>`);
      $('debCareer').innerHTML = lines.join('');
    }
    const nextIdx = this.mission + 1;
    const nextOk = nextIdx < MISSIONS.length && missionUnlocked(best, nextIdx);
    const showNext = nextOk && this.net.role !== 'client' && !this.isDaily;
    $('btnNext').classList.toggle('hidden', !showNext);
    if (showNext) $('btnNext').textContent = `Next mission · ${MISSIONS[nextIdx].name}`;
    // ironman: no retry of a failed operation
    $('btnAgain').classList.toggle('hidden', this.net.role === 'client' || (career.ironman && !win && !this.isDaily));
    show('hud', false); show('debrief', true); win ? this.audio.ok() : this.audio.fail();
    this.startReplay();
  }
  private stopReplay() {
    this.replayPlaying = false;
    if (this.replayRaf) { cancelAnimationFrame(this.replayRaf); this.replayRaf = 0; }
  }
  private startReplay() {
    this.stopReplay();
    const sim = this.sim; if (!sim) return;
    const l = sim.level, k = 6, base = document.createElement('canvas');
    base.width = l.w * k; base.height = l.h * k;
    const bg = base.getContext('2d')!;
    for (let z = 0; z < l.h; z++) for (let x = 0; x < l.w; x++) {
      const v = l.cells[z * l.w + x];
      bg.fillStyle = v === WALL ? '#8fa3b5' : v === DOOR ? '#f2c14e' : v === WINDOW ? '#68b6e0' : v === LOW || v === HIGH ? '#33414d' : v === 1 ? '#18212a' : '#0b0f14';
      bg.fillRect(x * k, z * k, k, k);
    }
    this.replayBase = base;
    const c = $<HTMLCanvasElement>('debMap');
    c.width = base.width; c.height = base.height;
    this.replayTime = 0; this.replayPlaying = true; this.replayLast = performance.now();
    $('btnReplayToggle').textContent = 'Pause';
    const tl = $('debTimeline');
    const maxT = Math.max(1, sim.time);
    const kindClass: Record<string, string> = { death: 'kill', arrest: 'arrest', bang: 'bang', c2: 'breach', bomb: 'breach' };
    const tlEvs = sim.replayEvents.filter(ev => ev.kind === 'death' || ev.kind === 'arrest' || ev.kind === 'bang' || ev.kind === 'c2' || ev.kind === 'bomb');
    tl.innerHTML = '';
    for (const ev of tlEvs) {
      const m = document.createElement('button');
      m.type = 'button';
      m.className = `dt-ev ${kindClass[ev.kind] || ''}`;
      m.style.left = `${Math.max(1, Math.min(99, (ev.t / maxT) * 100))}%`;
      m.title = `${ev.kind.toUpperCase()} @ ${Math.floor(ev.t)}s`;
      m.onclick = () => {
        this.replayPlaying = false;
        $('btnReplayToggle').textContent = 'Play';
        this.replayTime = ev.t;
        this.drawReplay(ev.t);
      };
      tl.appendChild(m);
    }
    const step = () => {
      if (this.state !== 'end' || $('debrief').classList.contains('hidden')) { this.stopReplay(); return; }
      const now = performance.now(), dt = Math.min(0.05, (now - this.replayLast) / 1000); this.replayLast = now;
      if (this.replayPlaying) {
        this.replayTime += dt * 8;
        if (this.replayTime > maxT + 2) this.replayTime = 0;
      }
      this.drawReplay(Math.min(maxT, this.replayTime));
      this.replayRaf = requestAnimationFrame(step);
    };
    this.replayRaf = requestAnimationFrame(step);
  }
  private drawReplay(t: number) {
    const sim = this.sim; if (!sim || !this.replayBase) return;
    const c = $<HTMLCanvasElement>('debMap'), g = c.getContext('2d')!, k = 6;
    g.drawImage(this.replayBase, 0, 0);
    const sec = Math.floor(t);
    $('debReplayTime').textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    const frames = sim.replayFrames;
    if (!frames.length) return;
    let fi = frames.length - 1;
    for (let i = 0; i < frames.length; i++) { if (frames[i].t >= t) { fi = i; break; } }
    // Draw player trail up to time t
    g.strokeStyle = 'rgba(255,255,255,0.28)'; g.lineWidth = 1.5; g.beginPath();
    let started = false;
    for (let i = 0; i <= fi; i++) {
      const pl = frames[i].actors.find(a => a.kind === 'player');
      if (!pl) continue;
      if (!started) { g.moveTo(pl.x * k, pl.z * k); started = true; } else g.lineTo(pl.x * k, pl.z * k);
    }
    g.stroke();
    // Draw events near current time
    for (const ev of sim.replayEvents) {
      if (ev.t > t) continue;
      const age = t - ev.t;
      if (ev.kind === 'shot' && age < 0.7 && ev.x2 != null && ev.z2 != null) {
        g.strokeStyle = `rgba(255,220,120,${1 - age / 0.7})`; g.lineWidth = 1.2;
        g.beginPath(); g.moveTo(ev.x * k, ev.z * k); g.lineTo(ev.x2 * k, ev.z2 * k); g.stroke();
      } else if ((ev.kind === 'bang' || ev.kind === 'c2') && age < 1.8) {
        g.strokeStyle = ev.kind === 'c2' ? 'rgba(255,150,50,0.85)' : 'rgba(255,255,255,0.85)';
        g.lineWidth = 1.6; g.beginPath(); g.arc(ev.x * k, ev.z * k, (1 + age * 4) * (k * 0.5), 0, 6.28); g.stroke();
      } else if (ev.kind === 'death') {
        g.fillStyle = '#ef4444'; g.fillRect(ev.x * k - 2.5, ev.z * k - 2.5, 5, 5);
      } else if (ev.kind === 'arrest') {
        g.fillStyle = '#4fd07a'; g.beginPath(); g.arc(ev.x * k, ev.z * k, 2.8, 0, 6.28); g.fill();
      }
    }
    // Draw actors at frame fi
    for (const a of frames[fi].actors) {
      if (!a.alive) continue;
      g.fillStyle = a.kind === 'player' ? '#ffffff' : a.kind === 'officer' ? (a.team === 'A' ? '#ff5a5a' : '#5aa2ff') : a.kind === 'suspect' ? (a.restrained ? '#facc15' : '#fb923c') : '#86efac';
      g.beginPath(); g.arc(a.x * k, a.z * k, a.kind === 'player' ? 3.5 : 2.8, 0, 6.28); g.fill();
    }
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
    this.mapT = 0; this.drawMap();
  }
  drawMap() {
    const m = $<HTMLCanvasElement>('minimap'); m.style.display = this.mapOn ? '' : 'none'; if (!this.mapOn || !this.mapBase) return;
    const g = m.getContext('2d')!, sim = this.sim!, k = 4; g.drawImage(this.mapBase, 0, 0);
    for (const d of sim.level.doors) {
      if (d.open > 0.5) { g.fillStyle = '#18212a'; g.fillRect(d.cx * k, d.cz * k, k, k); }
      else if (d.wedged) { g.fillStyle = '#ff9820'; g.fillRect(d.cx * k, d.cz * k, k, k); }
      else if (d.locked) { g.fillStyle = '#e04848'; g.fillRect(d.cx * k, d.cz * k, k, k); }
      if (d.trapped && d.trapKnown) { g.fillStyle = '#ff3838'; g.fillRect(d.cx * k + 1, d.cz * k + 1, 2, 2); }
    }
    for (const ev of sim.evidence) {
      if (ev.secured) continue;
      g.fillStyle = '#facc15'; g.fillRect(ev.x * k - 1.5, ev.z * k - 1.5, 3, 3);
    }
    for (const sn of sim.sensors) {
      g.strokeStyle = 'rgba(56,189,248,0.85)'; g.lineWidth = 1;
      g.beginPath(); g.arc(sn.x * k, sn.z * k, 4, 0, 6.28); g.stroke();
    }
    if (sim.level.breaker) { g.fillStyle = sim.powerOn ? '#4fd07a' : '#555'; g.fillRect(sim.level.breaker.x * k - 2, sim.level.breaker.z * k - 2, 4, 4); }
    if (sim.bomb && !sim.bomb.defused) { g.fillStyle = '#ff2a2a'; g.fillRect(sim.bomb.x * k - 2, sim.bomb.z * k - 2, 4, 4); }
    for (const a of sim.actors) {
      if (a.kind === 'player' && a !== sim.player) {
        g.fillStyle = !a.alive ? '#64748b' : a.downed ? '#ff4a4a' : '#38bdf8';
        g.beginPath(); g.arc(a.x * k, a.z * k, 3.2, 0, 6.28); g.fill();
      }
      else if (a.kind === 'officer' && a.alive) { g.fillStyle = a.team === 'A' ? '#ff5a5a' : '#5aa2ff'; g.fillRect(a.x * k - 2, a.z * k - 2, 4, 4); }
      else if (a.restrained && a.alive) { g.fillStyle = a.kind === 'suspect' ? '#c08a2a' : '#4fd07a'; g.fillRect(a.x * k - 1.5, a.z * k - 1.5, 3, 3); }
    }
    for (const pg of this.pings) {
      g.strokeStyle = pg.color; g.lineWidth = 1.5;
      g.beginPath(); g.arc(pg.x * k, pg.z * k, 4 + Math.sin(pg.t * 8) * 1.5, 0, 6.28); g.stroke();
    }
    const p = sim.player, f = fwd(this.yaw); g.fillStyle = '#fff'; g.beginPath(); g.moveTo(p.x * k + f.x * 6, p.z * k + f.z * 6); g.lineTo(p.x * k - f.x * 3 - f.z * 3.5, p.z * k - f.z * 3 + f.x * 3.5); g.lineTo(p.x * k - f.x * 3 + f.z * 3.5, p.z * k - f.z * 3 - f.x * 3.5); g.fill();
  }
  updateHud(force = false) {
    const sim = this.sim; if (!sim) return; this.hudT -= 1; if (!force && this.hudT > 0) return; this.hudT = 8;
    const p = sim.player, r = sim.remaining(), ws = this.weaponSpecs, curW = ws[this.weapon], gun = this.activeGun(curW);
    ($('hpbar').firstElementChild as HTMLElement).style.width = Math.max(0, p.hp) + '%'; $('hptxt').textContent = String(Math.ceil(Math.max(0, p.hp)));
    const modeTag = curW.canSemi ? ` · ${this.fireMode.toUpperCase()}` : '';
    $('wname').textContent = curW.name + modeTag + (this.reloadT > 0 ? ' – RELOADING' : '');
    const ac = $('acount'); ac.innerHTML = `<b>${this.ammo[this.weapon]}</b> / ${this.reserve[this.weapon]}`; ac.className = this.ammo[this.weapon] <= 4 ? 'low' : '';
    const gSel = this.grenadeType;
    $('bangs').innerHTML = `<span class="gchip ${gSel === 'bang' ? 'on' : ''}">FLASH ${p.bangs}</span><span class="gchip smoke ${gSel === 'smoke' ? 'on' : ''}">SMK ${p.smokes}</span><span class="gchip gas ${gSel === 'gas' ? 'on' : ''}">CS ${p.gases}</span><span>C2 ${p.c2} · WDG ${p.wedges} · SNS ${p.sensors}${this.laserOn && !curW.taser ? ' · LSR' : ''}${this.torchOn ? ' · LT' : ''}</span>`;
    const magEl = $('magBadge');
    if (this.ads && gun === 'rifle') {
      magEl.classList.remove('hidden');
      magEl.classList.toggle('on', this.magnifier);
      magEl.textContent = this.magnifier ? '3× MAGNIFIER ON [SHIFT]' : '1× HOLO [SHIFT]';
    } else magEl.classList.add('hidden');
    $('objective').innerHTML = `SUSPECTS <b>${r.suspects}</b> · CIVILIANS <b>${r.civs}</b>${sim.level.breaker ? ` · POWER <b>${sim.powerOn ? 'ON' : 'OFF'}</b>` : ''}`;
    const bt = $('bombtimer');
    if (sim.bomb && !sim.bomb.defused) {
      bt.classList.remove('hidden');
      const sec = Math.max(0, Math.ceil(sim.bomb.time)), mm = Math.floor(sec / 60), ss = String(sec % 60).padStart(2, '0');
      bt.textContent = `BOMB ACTIVE · ${mm}:${ss}`;
    } else bt.classList.add('hidden');
    if (this.bodycamOn) {
      $('bcTime').textContent = new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';
      const baseBpm = p.hp < 40 ? 132 : p.hp < 70 ? 96 : 74;
      const runBpm = (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) ? 18 : 0;
      const bpm = Math.min(182, Math.round(baseBpm + runBpm + this.stress * 48));
      $('bcBpm').textContent = `${bpm} BPM`;
    }
    if (this.pipOn && this.pipKind !== 'optiwand') {
      const list = this.pipActors();
      const o = list[this.pipActorIdx];
      if (o) $('pipLabel').textContent = `${o.kind === 'player' ? 'ALLY CAM' : 'HELMET CAM'} // ${o.name.toUpperCase()}${o.kind === 'officer' ? ' [' + o.team + ']' : ''}${!o.alive ? ' · KIA' : o.downed ? ' · DOWNED' : ''}`;
    }
    if (sim.players.length > 1) {
      const mates = sim.players.filter(pl => pl !== p);
      $('coopHud').innerHTML = mates.map(m => {
        const cls = !m.alive ? 'dead' : m.downed ? 'downed' : '';
        const hpW = m.downed ? Math.max(4, (m.bleedT / 40) * 100) : Math.max(0, m.hp);
        return `<div class="coop-card ${cls}"><div class="coop-top"><span>${m.name.replace(/[<>&]/g, '')}${m.shield ? ' [SHD]' : ''}</span><span>${m.speaking ? '<b class="coop-mic">MIC</b> ' : ''}${m.readyBreach ? '<b class="coop-rdy">RDY</b> ' : ''}${!m.alive ? 'KIA' : m.downed ? `DOWN ${Math.ceil(m.bleedT)}s` : `${Math.ceil(m.hp)} HP`}</span></div><div class="coop-hp"><i style="width:${hpW}%"></i></div></div>`;
      }).join('');
    }
    let html = '';
    for (const t of ['A', 'B'] as Team[]) {
      const T = sim.teams[t]; html += `<div class="tcard ${t} ${this.selTeam === t || this.selTeam === 'ALL' ? 'sel' : ''}"><h4>TEAM ${t}<span>${orderText(T.order.type)}${T.fire === 'hold' ? ' · HOLD FIRE' : ''}</span></h4>`;
      for (const o of sim.officers.filter(o => o.team === t)) html += `<div class="mem ${o.alive ? '' : 'dead'}"><span>${o.name}${o.solo && o.alive ? `<em>${orderText(o.solo.order.type)}</em>` : ''}</span><i><u style="width:${o.hp}%;background:${o.hp > 60 ? '#5fe08a' : o.hp > 30 ? '#f2c14e' : '#e04848'}"></u></i></div>`;
      html += '</div>';
    }
    $('team').innerHTML = html;
    $('quick').innerHTML = `<kbd>Tab</kbd> <b>${this.selTeam === 'ALL' ? 'ALL' : 'TEAM ' + this.selTeam}</b> · <kbd>Q/E</kbd> Lean · <kbd>.</kbd> Grenade · <kbd>,</kbd> Sensor · <kbd>Caps</kbd> Shout · <kbd>F2</kbd> Sök &amp; Säkra · <kbd>H</kbd> Wheel · <kbd>N</kbd> NVG · <kbd>P</kbd> Cam${sim.players.length > 1 ? ' · <kbd>J</kbd> Sync · <kbd>O</kbd> Share' : ''}`;
    const it = sim.interactTarget(), pr = $('prompt');
    if (p.downed && p.alive) {
      pr.style.opacity = '1'; pr.textContent = `DOWNED — BLEEDOUT IN ${Math.max(0, Math.ceil(p.bleedT))}s (WAIT FOR TEAMMATE)`;
      $('progress').style.opacity = '1'; ($('progress').firstElementChild as HTMLElement).style.width = (p.bleedT / 40) * 100 + '%';
    }
    else if (p.reviving) { pr.style.opacity = '1'; pr.textContent = `Reviving ${p.reviving.name}…`; $('progress').style.opacity = '1'; ($('progress').firstElementChild as HTMLElement).style.width = (p.reviveT / 2.8) * 100 + '%'; }
    else if (p.cuff) { pr.style.opacity = '1'; pr.textContent = 'Cuffing…'; $('progress').style.opacity = '1'; ($('progress').firstElementChild as HTMLElement).style.width = (p.cuffT / 1.6) * 100 + '%'; }
    else if (sim.bomb && !sim.bomb.defused && sim.bomb.defuseT > 0) { pr.style.opacity = '1'; pr.textContent = 'Defusing bomb…'; $('progress').style.opacity = '1'; ($('progress').firstElementChild as HTMLElement).style.width = (sim.bomb.defuseT / 2.2) * 100 + '%'; }
    else {
      $('progress').style.opacity = '0';
      if (it?.revive) { pr.style.opacity = '1'; pr.innerHTML = `<kbd>F</kbd> Revive ${it.revive.name} (${Math.ceil(it.revive.bleedT)}s)`; }
      else if (it?.actor) { pr.style.opacity = '1'; pr.innerHTML = '<kbd>F</kbd> Handcuff'; }
      else if (it?.evidence) { pr.style.opacity = '1'; pr.innerHTML = '<kbd>F</kbd> Bag Evidence (+25)'; }
      else if (it?.bomb) { pr.style.opacity = '1'; pr.innerHTML = '<kbd>F</kbd> Defuse Bomb'; }
      else if (it?.breaker) { pr.style.opacity = '1'; pr.innerHTML = `<kbd>F</kbd> ${sim.powerOn ? 'Cut Building Power' : 'Restore Power'}`; }
      else if (it?.door) {
        pr.style.opacity = '1';
        if (it.door.trapped && it.door.trapKnown) {
          pr.innerHTML = '<kbd>F</kbd> Disarm Tripwire · <kbd>U</kbd> Breach Charge';
        } else {
          pr.innerHTML = it.door.locked ? '<kbd>F</kbd> Pick Lock · <kbd>U</kbd> Breach Charge · <kbd>O</kbd> FiberCam'
            : `<kbd>F</kbd> ${it.door.target ? 'Close' : 'Open'} · <kbd>Shift+F</kbd> Crack · <kbd>O</kbd> FiberCam · <kbd>Y</kbd> ${it.door.wedged ? 'Unwedge' : 'Wedge'}${sim.players.length > 1 ? ' · <kbd>J</kbd> Sync' : ''}`;
        }
      } else if (this.ammo[this.weapon] <= 0 && this.reserve[this.weapon] > 0 && this.reloadT <= 0) {
        pr.style.opacity = '1';
        pr.innerHTML = '<kbd>R</kbd> Reload · <kbd>2×R</kbd> Speed Reload';
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
    p.torch = this.torchOn; p.ads = this.ads; p.weapon = this.weapon;
    if (p.alive && !p.downed && !sim.over && !this.typing) {
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
      if (this.reloadT > 0) {
        this.reloadT -= dt;
        if (this.reloadT <= 0) {
          if (this.reloadShell) {
            if (this.ammo[this.weapon] < ws.mag && this.reserve[this.weapon] > 0) {
              this.ammo[this.weapon]++;
              this.reserve[this.weapon]--;
            }
            if (this.ammo[this.weapon] < ws.mag && this.reserve[this.weapon] > 0) {
              this.reloadT = 0.48;
              this.reloadDur = 0.48;
              this.audio.shotgunShell();
            } else {
              this.reloadShell = false;
            }
          } else {
            if (this.speedReload && this.ammo[this.weapon] > 0) {
              // Speed reload discards partial magazine for rapid mag swap
              this.ammo[this.weapon] = 0;
            }
            const n = Math.min(ws.mag - this.ammo[this.weapon], this.reserve[this.weapon]);
            this.ammo[this.weapon] += n;
            this.reserve[this.weapon] -= n;
            this.speedReload = false;
          }
          this.updateHud(true);
        }
      } else if (this.mouseDown && this.fireCd <= 0 && (this.isWeaponAuto(ws) || !this.semiLock)) { this.fire(); if (!this.isWeaponAuto(ws)) this.semiLock = true; }
      if (!this.mouseDown || this.fireCd > 0.25) this.preShot = false;
    }
    if (this.net.online) {
      const spk = this.net.sampleSpeaking();
      p.speaking = spk.local;
      if (this.net.role === 'host') {
        for (const [conn, idx] of this.connIdx) {
          const pl = sim.players[idx];
          if (pl) pl.speaking = !!spk.peers[conn.peer];
        }
      }
      // Spatial proximity + radio bandpass for every connected player peer
      const peerIds = this.lobbyIds;
      sim.players.forEach((pl, idx) => {
        if (pl === p || !pl.alive) return;
        const pid = peerIds[idx];
        if (!pid) return;
        const q = this.pan(pl.x, pl.z);
        this.net.updatePeerSpatial(pid, q.d, q.pan, sim.los(p.x, p.z, pl.x, pl.z));
      });
    }
    if (this.mirror) {
      // Smoothly interpolate all remote actors between 15 Hz snapshots
      const lk = Math.min(1, dt * 16);
      for (const [a, tg] of this.netTargets) {
        if (a === p) continue;
        a.x += (tg.x - a.x) * lk;
        a.z += (tg.z - a.z) * lk;
        const dy = Math.atan2(Math.sin(tg.yaw - a.yaw), Math.cos(tg.yaw - a.yaw));
        a.yaw += dy * lk;
      }
      this.inT -= dt; if (this.inT <= 0) { this.inT = 0.05; this.net.send({ t: 'in', x: p.x, z: p.z, yaw: this.yaw, pitch: this.pitch, cr: p.crouch, pr: p.prone, jy: p.jumpY, mv: !p.downed && (K.has('KeyW') || K.has('KeyA') || K.has('KeyS') || K.has('KeyD')), tc: this.torchOn, ads: this.ads, wp: this.weapon, sh: p.shield, sp: p.speaking }); }
      sim.events.length = 0;
    } else {
      sim.update(dt);
      if (this.net.role === 'host') {
        if (sim.events.length) this.net.broadcast({ t: 'ev', e: sim.events.map(encodeEv) });
        this.snapT -= dt; if (this.snapT <= 0) { this.snapT = 1 / 15; this.net.broadcast({ t: 'snap', s: encodeSnap(sim) }); }
      }
      for (const e of sim.events) this.handle(e); sim.events.length = 0;
    }
    // Lobby live voice indicator refresh if lobby stays visible
    if (!$('lobby').classList.contains('hidden')) {
      this.lobbyVoiceTimer -= dt;
      if (this.lobbyVoiceTimer <= 0) { this.lobbyVoiceTimer = 0.3; this.lobby(); }
    }
    // footsteps of everyone nearby
    for (const a of sim.actors) {
      if (a === p || !a.alive || !a.moving) continue; const ph = Math.floor(a.walk / Math.PI), last = this.stepPh.get(a); this.stepPh.set(a, ph);
      if (last !== undefined && ph !== last && !a.prone) { const q = this.pan(a.x, a.z); if (q.d < 14) this.audio.step((a.kind === 'officer' || a.kind === 'player' ? 0.2 : 0.14) / (1 + q.d * 0.25), q.pan); }
    }
    if (this.net.online) { const vc = $('vc'); vc.textContent = this.net.micOk ? (this.net.muted ? 'VOICE CHAT: MIC OFF (B)' : `SPATIAL RADIO ON · ${this.net.voiceCount} peers · B = mute`) : 'VOICE CHAT: no microphone – listen-only'; vc.className = this.net.muted || !this.net.micOk ? 'off' : ''; }
    this.level!.update(dt, sim.time, p.x, p.z); for (const v of this.views.values()) v.update(dt, sim.time); this.fx.update(dt, sim);
    for (const pg of this.pings) pg.t -= dt;
    this.pings = this.pings.filter(pg => pg.t > 0);
    if (this.breachBannerT > 0) { this.breachBannerT -= dt; if (this.breachBannerT <= 0 && sim.breachSyncT <= 0) show('breachBanner', false); }
    // camera + recoil recovery + shockwave shake
    this.recoil = Math.max(0, this.recoil - dt * (this.fireMode === 'semi' ? 0.3 : 0.24));
    this.recoilPitch *= Math.max(0, 1 - dt * 11);
    this.recoilRoll *= Math.max(0, 1 - dt * 12);
    this.camShake = Math.max(0, this.camShake - dt * 0.085);
    this.dmgFx = Math.max(0, this.dmgFx - dt * 1.4); this.hitFx = Math.max(0, this.hitFx - dt * 5);
    // Lean Q / E smooth update + wall-safe camera offset
    this.leanTarget = p.alive && !p.downed && !p.prone && !this.typing ? (K.has('KeyQ') ? -1 : 0) + (K.has('KeyE') ? 1 : 0) : 0;
    this.lean += (this.leanTarget - this.lean) * Math.min(1, dt * 11);
    const lo = sim.leanOffset(p, this.lean);

    const targetEye = (!p.alive ? 0.35 : p.downed ? 0.48 : p.prone ? 0.36 : p.crouch ? 1.12 : 1.62) + (p.alive && !p.downed ? p.jumpY : 0) - Math.abs(lo.actual) * 0.06;
    this.eye += (targetEye - this.eye) * Math.min(1, dt * (p.jumpY > 0 ? 30 : 9));
    { const st = $('stance'), run = (K.has('ShiftLeft') || K.has('ShiftRight')) && !p.prone && !p.crouch, t = !p.alive ? '' : p.downed ? 'DOWNED · BLEEDING OUT' : p.prone ? 'CRAWLING · SILENT' : p.crouch ? 'CROUCHING · SILENT' : run ? 'RUNNING · HEARD FAR AWAY' : this.slow ? 'SNEAKING · SILENT' : Math.abs(lo.actual) > 0.25 ? (lo.actual < 0 ? 'LEAN LEFT' : 'LEAN RIGHT') : ''; if (st.textContent !== t) { st.textContent = t; st.className = run || p.downed ? 'loud' : ''; } }
    const bobScale = 1 - this.aimK * 0.85;
    const shkX = this.camShake > 0 ? (Math.random() - 0.5) * this.camShake : 0;
    const shkY = this.camShake > 0 ? (Math.random() - 0.5) * this.camShake : 0;
    this.camera.position.set(p.x + lo.lx + shkX, this.eye + Math.sin(this.bob * 2) * 0.022 * bobScale + shkY, p.z + lo.lz);
    this.camera.rotation.set(
      Math.min(1.45, this.pitch + this.recoilPitch + shkY * 0.4),
      this.yaw + shkX * 0.3,
      (!p.alive ? 0.5 : p.downed ? 0.22 : (this.bodycamOn ? 0.035 + Math.sin(this.bob) * 0.015 : Math.sin(this.bob) * 0.004 * bobScale) - lo.actual * 0.13) + this.recoilRoll,
    );
    const ws0 = this.weaponSpecs[this.weapon];
    const gun0 = this.activeGun(ws0);
    { const sprint = (K.has('ShiftLeft') || K.has('ShiftRight')) && !p.prone && !p.crouch && (K.has('KeyW') || K.has('KeyA') || K.has('KeyS') || K.has('KeyD'));
      const want = this.ads && p.alive && !p.downed && this.reloadT <= 0 && !sprint && !this.typing && !!document.pointerLockElement || (AUTO && this.ads) ? 1 : 0;
      this.aimK += (want - this.aimK) * Math.min(1, dt * 12); if (Math.abs(want - this.aimK) < 0.002) this.aimK = want;
      const baseFov = this.bodycamOn ? 92 : 74;
      const zoomFov = gun0 === 'rifle' ? (this.magnifier ? 26 : 44) : 54;
      const fov = baseFov + (zoomFov - baseFov) * this.aimK;
      if (Math.abs(this.camera.fov - fov) > 0.01) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); } }
    this.torch.intensity = this.torchOn && p.alive && !p.downed ? 22 : 0;
    const cross = $('cross');
    // IFF friendly crosshair check + tactical laser + IR NVG beam + near-wall weapon lowering
    let nearWall = false;
    if (p.alive && !p.downed && !sim.over) {
      const ad = this.aimDir();
      const rh = sim.ray(p.x + lo.lx, this.eye, p.z + lo.lz, ad.x, ad.y, ad.z, 26, p, false);
      nearWall = !this.ads && rh.kind === 'wall' && rh.d < 0.85;
      const friendly = !!(rh.actor && (rh.actor.kind === 'player' || rh.actor.kind === 'officer' || (rh.actor.kind === 'civ' && !rh.actor.hostile)));
      cross.classList.toggle('friend', friendly);
      if (friendly) {
        $('ffWarn').textContent = rh.actor!.kind === 'civ' ? 'CIVILIAN — HOLD FIRE' : `FRIENDLY (${rh.actor!.name.toUpperCase()}) — HOLD FIRE`;
        show('ffWarn', true);
      } else show('ffWarn', false);
      const wsNow = this.weaponSpecs[this.weapon];
      if (this.laserOn && !wsNow.taser && this.reloadT <= 0 && rh.d < 22) {
        const hx = rh.x - ad.x * 0.03, hy = rh.y - ad.y * 0.03, hz = rh.z - ad.z * 0.03;
        const fw = fwd(this.yaw);
        const ox = p.x + lo.lx + fw.x * 0.35 - fw.z * (0.14 * (1 - this.aimK));
        const oy = this.eye - (0.12 - 0.05 * this.aimK);
        const oz = p.z + lo.lz + fw.z * 0.35 + fw.x * (0.14 * (1 - this.aimK));
        this.fx.setLaser(true, hx, hy, hz, ox, oy, oz, this.nvgOn);
      } else {
        this.fx.setLaser(false);
      }
    } else {
      cross.classList.remove('friend');
      show('ffWarn', false);
      this.fx.setLaser(false);
    }
    this.highReadyK += ((nearWall ? 1 : 0) - this.highReadyK) * Math.min(1, dt * 12);
    // view model
    const g = this.vm.group; this.vmKick += (0 - this.vmKick) * Math.min(1, dt * 14); this.sway.multiplyScalar(Math.max(0, 1 - dt * 9));
    const rl = this.reloadT > 0 ? Math.sin(Math.min(1, this.reloadT / Math.max(0.1, this.reloadDur)) * Math.PI) : 0;
    const ak = this.aimK, AIM = AIMPOS;
    const cantRoll = this.nvgOn && !ws0.shield ? -0.38 * ak : 0;
    const cantLift = this.nvgOn && !ws0.shield ? 0.024 * ak : 0;
    const hrDip = this.highReadyK * 0.09;
    g.position.set(0.17 * (1 - ak) - this.sway.x * (1 - ak * 0.8) + Math.sin(this.bob) * 0.006 * bobScale, -0.16 + ak * 0.075 + cantLift - hrDip + this.sway.y * (1 - ak * 0.8) - rl * 0.16 + Math.abs(Math.cos(this.bob)) * 0.006 * bobScale + Math.min(0, this.vmKick) * 0.2, -0.5 + this.highReadyK * 0.14 + Math.max(0, this.vmKick) * 0.05);
    g.rotation.set(Math.max(0, this.vmKick) * 0.07 - rl * 0.7 - this.highReadyK * 0.45, 0.03 * (1 - ak) + this.sway.x * 2 * (1 - ak * 0.8), rl * 0.5 + cantRoll);
    this.vm.rifle.visible = gun0 === 'rifle' && !ws0.shield;
    this.vm.shotgun.visible = gun0 === 'shotgun' && !ws0.nonLethal;
    this.vm.beanbag.visible = gun0 === 'shotgun' && !!ws0.nonLethal;
    this.vm.pistol.visible = gun0 === 'pistol' || !!ws0.shield;
    this.vm.shield.visible = !!ws0.shield;
    g.visible = p.alive && !p.downed;
    if (this.arms.ready) { // animated arms: the clips do the reloading and walking, the code only adds sway and recoil
      const a = this.arms.root, dip = 0, mv = !p.alive || p.downed || this.typing || !(K.has('KeyW') || K.has('KeyA') || K.has('KeyS') || K.has('KeyD')) ? 0 : (K.has('ShiftLeft') || K.has('ShiftRight')) && !p.crouch && !p.prone ? 2 : 1;
      const wIdx = gun0 === 'rifle' ? 0 : gun0 === 'shotgun' ? (ws0.nonLethal ? 3 : 2) : (ws0.taser ? 4 : 1);
      const am = AIM[wIdx] ?? AIM[0];
      a.position.set(-this.sway.x * (1 - ak * 0.85) + am[0] * ak, this.sway.y * (1 - ak * 0.85) + Math.min(0, this.vmKick) * 0.2 - dip * 0.16 + am[1] * ak + cantLift - hrDip, Math.max(0, this.vmKick) * 0.035 + am[2] * ak + this.highReadyK * 0.14);
      a.rotation.set(Math.max(0, this.vmKick) * 0.035 * (1 - ak * 0.6) - dip * 0.7 + am[3] * ak - this.highReadyK * 0.45, this.sway.x * 2 * (1 - ak * 0.85) + am[4] * ak, dip * 0.5 + cantRoll); a.visible = p.alive && !p.downed && !ws0.shield;
      this.arms.setSight(ak > 0.35, this.magnifier && gun0 === 'rifle');
      this.arms.update(dt, wIdx, mv); a.updateMatrixWorld(true); this.vm.flash.position.copy(g.worldToLocal(this.arms.muzzle.getWorldPosition(new THREE.Vector3())));
    }
    // overlays & dynamic audio
    this.stress = Math.max(0, this.stress - dt * 0.12);
    this.suppressFx = Math.max(0, this.suppressFx - dt * 1.45);
    $('suppress').style.opacity = String(Math.min(1, this.suppressFx * 0.95));
    this.audio.setDeafness(p.alive ? Math.min(1, p.flash * 1.35) : 0);
    this.acousticT -= dt;
    if (this.acousticT <= 0) {
      this.acousticT = 0.28;
      const rk = roomAt(sim.level, p.x, p.z)?.kind;
      const ac: 'exterior' | 'hall' | 'tight' = !rk ? 'exterior' : (rk === 'office' || rk === 'bedroom' || rk === 'storage' || rk === 'vault' || rk === 'corridor') ? 'tight' : 'hall';
      this.audio.setRoomAcoustic(ac);
    }
    if (p.alive && !p.downed && !sim.over && this.stress > 0.38) {
      this.breathT -= dt;
      if (this.breathT <= 0) {
        this.breathT = Math.max(0.85, 1.8 - this.stress * 0.85);
        this.audio.breath(this.stress);
      }
    }
    if (this.radioCardT > 0) { this.radioCardT -= dt; if (this.radioCardT <= 0) show('radioCard', false); }
    if (this.pipTimer > 0) {
      this.pipTimer -= dt;
      if (this.pipTimer <= 0 && !this.pipManual && this.pipOn) {
        this.pipOn = false; this.pipKind = 'ally'; this.optiwandDoor = null;
        $('pipFrame').classList.remove('optiwand'); show('pipMeta', false); show('pipFrame', false);
      }
    }
    // Ambient club bass & low-HP heartbeat
    if (sim.level.name === 'Club Eclipse' && p.alive && !sim.over) {
      this.clubBeatT -= dt;
      if (this.clubBeatT <= 0) {
        this.clubBeatT = 0.48;
        const cx = sim.level.w * 0.5, cz = sim.level.h * 0.5;
        const q = this.pan(cx, cz);
        if (q.d < 24) this.audio.clubPulse(q.d, q.pan, !sim.los(p.x, p.z, cx, cz));
      }
    }
    if (p.alive && p.hp < 35 && !sim.over) {
      this.hbT -= dt;
      if (this.hbT <= 0) { this.hbT = p.hp < 20 ? 0.55 : 0.78; this.audio.heartbeat(1 - p.hp / 35); }
    }
    this.censorT -= dt;
    if (this.censorT <= 0) { this.censorT = 0.04; this.updateCensors(); }
    $('dmg').style.opacity = String(Math.max(this.dmgFx, p.hp < 35 && p.alive ? 0.35 : 0, p.alive ? 0 : 0.8));
    const fl = $('flash');
    const inGas = sim.clouds.some(cl => cl.kind === 'gas' && Math.hypot(p.x - cl.x, p.z - cl.z) < cl.r);
    if (inGas && p.flash < 0.2) {
      fl.style.background = 'rgba(170, 215, 75, 0.55)';
      fl.style.opacity = '0.48';
    } else {
      fl.style.background = '#fff';
      fl.style.opacity = String(Math.min(1, p.flash * 1.6));
    }
    const hm = $('hitmark'); hm.style.opacity = String(this.hitFx);
    hm.classList.toggle('head', this.hitHead);
    hm.classList.toggle('kill', this.hitHead && this.hitFx > 0.2);
    const deg = (((-this.yaw * 180 / Math.PI) % 360) + 360) % 360;
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const di = Math.round(deg / 45) % 8;
    $('compass').innerHTML = `${dirs[(di + 7) % 8]} · <b>${dirs[di]} ${String(Math.round(deg) % 360).padStart(3, '0')}°</b> · ${dirs[(di + 1) % 8]}`;
    const gap = 6 + this.recoil * 260 + (K.has('KeyW') || K.has('KeyA') || K.has('KeyS') || K.has('KeyD') ? 7 : 0) - (p.crouch ? 2 : 0);
    cross.style.setProperty('--gap', gap * (1 - this.aimK * 0.55) + 'px');
    cross.style.setProperty('--arms-op', String(1 - this.aimK));
    cross.classList.toggle('ads', this.aimK > 0.35);
    cross.style.opacity = p.alive ? '1' : '0'; // keep crisp optical center dot visible when zooming down sights
    if (this.parsedT > 0) { this.parsedT -= dt; if (this.parsedT <= 0) { $('parsed').textContent = ''; $('heard').textContent = ''; } }
    this.updateHud();
    this.mapT -= dt;
    if (this.mapT <= 0) { this.mapT = 0.055; this.drawMap(); }
    if (this.endT > 0) { this.endT -= dt; if (this.endT <= 0) this.debrief(); }
  }
  private updateCensors() {
    const box = $('bcCensor');
    if (!this.bodycamOn || !S.censor || !this.sim || this.state !== 'play') {
      if (box.childElementCount) box.innerHTML = '';
      return;
    }
    const sim = this.sim, p = sim.player;
    this.camera.updateMatrixWorld();
    const v = new THREE.Vector3(), fw = new THREE.Vector3();
    this.camera.getWorldDirection(fw);
    let html = '';
    for (const a of sim.actors) {
      if (a === p || !a.alive) continue;
      if (a.kind !== 'civ' && !a.restrained) continue;
      const dx = a.x - p.x, dz = a.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > 22 || dx * fw.x + dz * fw.z <= 0.2) continue;
      if (!sim.los(p.x, p.z, a.x, a.z)) continue;
      v.set(a.x, a.prone ? 0.32 : a.crouch ? 1.05 : 1.56, a.z).project(this.camera);
      if (v.z > 1) continue;
      const sx = (v.x * 0.5 + 0.5) * 100;
      const sy = (-v.y * 0.5 + 0.5) * 100;
      if (sx < 2 || sx > 98 || sy < 2 || sy > 98) continue;
      const sz = Math.max(22, Math.min(72, 260 / Math.max(1.5, d)));
      html += `<div class="censor-box" style="left:${sx.toFixed(1)}%;top:${sy.toFixed(1)}%;width:${sz.toFixed(0)}px;height:${(sz * 0.72).toFixed(0)}px">REDACTED</div>`;
    }
    box.innerHTML = html;
  }
  /** Builds (or rebuilds) the post chain for the current level scene. */
  ensurePost(): PostFX | null {
    if (S.qual <= 0) return null;
    if (!this.post || this.postScene !== this.scene) {
      this.post?.dispose();
      this.post = new PostFX(this.renderer, this.scene, this.camera, this.viewScene, this.viewCam, {
        bloom: S.qual >= 3 ? 0.3 : 0.22,
        radius: S.qual >= 3 ? 0.64 : 0.54,
        threshold: 1.6,
      });
      this.postScene = this.scene;
      this.post.setQuality(S.qual);
      this.post.setSize(innerWidth, innerHeight, this.renderer.getPixelRatio());
    }
    return this.post;
  }
  render() {
    const r = this.renderer;
    r.setScissorTest(false);
    r.setViewport(0, 0, innerWidth, innerHeight);
    r.clear();
    if (this.state === 'menu') {
      if (!this.menu.ready) return;
      const now = performance.now(), dt = Math.min(0.05, (now - this.menuT) / 1000);
      this.menuT = now; this.menu.resize(innerWidth / innerHeight); this.menu.update(dt);
      r.render(this.menu.scene, this.menu.cam);
    }
    else if (this.sim) {
      const post = this.ensurePost();
      if (post) {
        post.flash = Math.min(1, this.dmgFx * 0.6 + this.hitFx * 0.3);
        post.render(1 / 60);
      } else {
        r.render(this.scene, this.camera); r.clearDepth(); r.render(this.viewScene, this.viewCam);
      }
      if (this.pipOn && S.pip && this.state === 'play') {
        const w = 240, h = 146, padX = 18, padY = innerHeight - 146 - 146;
        const x = Math.max(0, innerWidth - w - padX), y = Math.max(0, padY);
        if (this.pipKind === 'optiwand' && this.optiwandDoor) {
          const d = this.optiwandDoor, s = this.optiwandSide;
          const cx = d.cx + 0.5 + (d.horiz ? 0 : -s * 0.28);
          const cz = d.cz + 0.5 + (d.horiz ? -s * 0.28 : 0);
          const yaw = d.horiz ? (s > 0 ? 0 : Math.PI) : (s > 0 ? Math.PI / 2 : -Math.PI / 2);
          this.pipCam.fov = 98;
          this.pipCam.aspect = w / h;
          this.pipCam.updateProjectionMatrix();
          this.pipCam.position.set(cx, 0.18, cz);
          this.pipCam.rotation.set(0.14, yaw, 0);
          r.setScissorTest(true);
          r.setViewport(x, y, w, h);
          r.setScissor(x, y, w, h);
          r.clear();
          r.render(this.scene, this.pipCam);
          r.setScissorTest(false);
          r.setViewport(0, 0, innerWidth, innerHeight);
        } else {
          const list = this.pipActors();
          const o = list[this.pipActorIdx] ?? list[0];
          if (o) {
            this.pipCam.fov = 78;
            this.pipCam.aspect = w / h;
            this.pipCam.updateProjectionMatrix();
            this.pipCam.position.set(o.x, !o.alive ? 0.35 : o.downed ? 0.52 : o.crouch ? 1.16 : 1.66, o.z);
            this.pipCam.rotation.set(o.alive && !o.downed ? (o.kind === 'player' ? o.pitch : -0.04) : 0.45, o.yaw, o.alive && !o.downed ? 0.02 : 0.6);
            const ownView = this.views.get(o);
            if (ownView) ownView.root.visible = false;
            r.setScissorTest(true);
            r.setViewport(x, y, w, h);
            r.setScissor(x, y, w, h);
            r.clear();
            r.render(this.scene, this.pipCam);
            r.setScissorTest(false);
            r.setViewport(0, 0, innerWidth, innerHeight);
            if (ownView) ownView.root.visible = true;
          }
        }
      }
    }
  }
}

const game = new Game();
const propsDone = loadProps();
const weaponsDone = loadWeapons().then(async () => {
  if (weaponsReady) { upgradeViewModel(game.vm); game.menu.upgradeWeapons(); }
  if (S.qual > 0 && await game.arms.load()) { // animated arms replace the static weapon (not on the lowest graphics setting)
    game.vm.rifle.clear(); game.vm.pistol.clear(); game.vm.shotgun.clear(); game.vm.beanbag.clear();
    game.viewCam.add(game.arms.root); game.viewScene.environment = studioEnv(game.renderer); game.viewScene.environmentIntensity = 0.5;
  }
});
const modelsDone = loadModels().then(() => {
  $('modelStatus').textContent = modelsReady ? '' : 'The 3D characters could not be loaded – built-in figures are used.';
});
assetsDone = Promise.all([propsDone, weaponsDone, modelsDone]);
document.body.classList.add('menu-wait');
const revealMenu = () => {
  if (game.menu.ready) return;
  game.menu.ready = true;
  game.menuT = performance.now();
  document.body.classList.remove('menu-wait');
};
const menuSafety = setTimeout(revealMenu, 6000);
if (S.qual > 0) {
  game.menu.env(game.renderer);
  operatorEnv(game.menu.scene.environment);
  void Promise.all([
    game.menu.whenReady(),
    game.menu.hero(3).then(async heroOk => {
      if (!heroOk) { await modelsDone; game.menu.squad(); }
    }),
    game.menu.vehicle('./models/vehicle/marauder.glb'),
  ]).finally(() => {
    clearTimeout(menuSafety);
    revealMenu();
  });
} else {
  void Promise.all([
    game.menu.whenReady(),
    modelsDone.then(() => game.menu.squad()),
  ]).finally(() => {
    clearTimeout(menuSafety);
    revealMenu();
  });
}
(window as any).__ta = game;
