import * as THREE from 'three';
import { Sim, Actor, Command, Team, Ev, fwd } from './sim/sim';
import { MISSIONS, WALL, DOOR, LOW, HIGH } from './sim/level';
import { parseCommand, ACTION_LABEL, DIR_LABEL } from './sim/commands';
import { LevelView, ActorView, FX, makeViewModel, TEAM_COLOR } from './game/world';
import { GameAudio, Speech } from './game/audio';
import { Voice } from './game/voice';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const show = (id: string, on: boolean) => $(id).classList.toggle('hidden', !on);
const params = new URLSearchParams(location.search);
const AUTO = params.has('auto');

// ---------------- settings ----------------
const defaults = { sens: 1, vol: 0.8, mic: 1, lang: 'sv-SE', tts: 1, head: 0, qual: 1, diff: 1 };
type Settings = typeof defaults;
const S: Settings = { ...defaults, ...JSON.parse(localStorage.getItem('teamai.settings') || '{}') };
const best: Record<string, number> = JSON.parse(localStorage.getItem('teamai.best') || '{}');
if (params.has('q')) S.qual = +params.get('q')!;
const saveSettings = () => localStorage.setItem('teamai.settings', JSON.stringify(S));

const WEAPONS = [
  { name: 'KARBIN', mag: 30, rate: 0.095, dmg: 34, auto: true, spread: 0.004, reload: 2.0, kick: 0.011 },
  { name: 'PISTOL', mag: 15, rate: 0.15, dmg: 26, auto: false, spread: 0.008, reload: 1.4, kick: 0.016 },
];
const ORDER_LABEL: Record<string, string> = { follow: 'FÖLJER', hold: 'HÅLLER', move: 'FÖRFLYTTAR', cover: 'SKYDDAR DIG', stack: 'VID DÖRR', breach: 'STORMAR', door: 'DÖRR', restrain: 'SÄKRAR' };

class Game {
  renderer: THREE.WebGLRenderer; scene = new THREE.Scene(); camera = new THREE.PerspectiveCamera(74, 1, 0.06, 120);
  viewScene = new THREE.Scene(); viewCam = new THREE.PerspectiveCamera(52, 1, 0.01, 10); vm = makeViewModel();
  torch = new THREE.SpotLight(0xfff0d6, 22, 32, 0.5, 0.6, 1.2);
  sim: Sim | null = null; level: LevelView | null = null; views = new Map<Actor, ActorView>(); fx = new FX();
  audio = new GameAudio(); speech = new Speech(); voice = new Voice();
  state: 'menu' | 'play' | 'pause' | 'end' = 'menu'; mission = 0; seed = 1;
  yaw = 0; pitch = 0; keys = new Set<string>(); mouseDown = false; eye = 1.62; bob = 0; stepAcc = 0; recoil = 0; vmKick = 0; sway = new THREE.Vector2();
  weapon = 0; ammo = [30, 15]; reserve = [150, 60]; fireCd = 0; reloadT = 0; semiLock = false; torchOn = true; mapOn = true;
  selTeam: Team | 'ALL' = 'ALL'; lastTeam: Team | 'ALL' = 'ALL'; typing = false; dmgFx = 0; hitFx = 0; hudT = 0; last = performance.now(); mapBase: HTMLCanvasElement | null = null; endT = 0; parsedT = 0;

  constructor() {
    const canvas = $<HTMLCanvasElement>('c');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.15; this.renderer.autoClear = false;
    this.camera.rotation.order = 'YXZ'; this.viewScene.add(this.viewCam); this.viewCam.add(this.vm.group);
    this.viewScene.add(new THREE.AmbientLight(0xffffff, 1.1)); const vl = new THREE.DirectionalLight(0xffffff, 1.6); vl.position.set(0.5, 1, 0.6); this.viewScene.add(vl);
    window.addEventListener('resize', () => this.resize()); this.resize();
    this.bindInput(); this.bindUI(); this.buildMenu();
    this.voice.onFinal = t => this.heard(t, true); this.voice.onInterim = t => { $('heard').textContent = '« ' + t + ' … »'; this.parsedT = Math.max(this.parsedT, 3); };
    this.voice.onState = (s, d) => this.micState(s, d);
    this.applySettings();
    requestAnimationFrame(() => this.frame());
    if (AUTO) this.start(+(params.get('auto') || 0), +(params.get('seed') || 1));
  }
  resize() {
    const w = innerWidth, h = innerHeight; this.renderer.setPixelRatio(Math.min(devicePixelRatio, S.qual > 1 ? 2 : S.qual ? 1.5 : 1)); this.renderer.setSize(w, h, false);
    this.camera.aspect = this.viewCam.aspect = w / h; this.camera.updateProjectionMatrix(); this.viewCam.updateProjectionMatrix();
  }
  applySettings() {
    this.audio.setVolume(S.vol); this.speech.enabled = !!S.tts; this.speech.lang = S.lang; this.voice.setLang(S.lang);
    ($('sSens') as HTMLInputElement).value = String(S.sens); ($('sVol') as HTMLInputElement).value = String(S.vol);
    for (const [id, k] of [['sMic', 'mic'], ['sLang', 'lang'], ['sTts', 'tts'], ['sHead', 'head'], ['sQual', 'qual'], ['sDiff', 'diff']] as const) ($(id) as HTMLSelectElement).value = String(S[k]);
    if (!S.mic) this.voice.stop(); else if (this.state === 'play') this.voice.start();
    this.resize();
  }

  // ---------------- menus ----------------
  buildMenu() {
    const box = $('missions'); box.innerHTML = '';
    MISSIONS.forEach((m, i) => {
      const b = document.createElement('button'); b.className = 'mission';
      b.innerHTML = `<em>UPPDRAG ${i + 1}</em><b>${m.name}</b><small>${m.brief.split('.')[0]}.</small><small>${m.suspects} misstänkta · ${m.civs} civila</small>` + (best[i] != null ? `<span class="best">Bästa poäng: ${best[i]}/100</span>` : '');
      b.onclick = () => { this.audio.init(); this.audio.ui(); this.mission = i; $('briefTitle').textContent = `Uppdrag ${i + 1}: ${m.name}`; $('briefText').textContent = m.brief; show('menu', false); show('brief', true); };
      box.appendChild(b);
    });
    const w = $('micwarn');
    if (!Voice.supported) { w.className = 'note warn'; w.textContent = 'Din webbläsare saknar röstigenkänning (Web Speech API). Använd Chrome eller Edge för röststyrning – annars kan du ge order med Enter eller snabbtangenterna.'; }
    else { w.className = 'note'; w.textContent = 'Röststyrning: tillåt mikrofonen när webbläsaren frågar. Om spelet visas inbäddat och mikrofonen blockeras – öppna det i en egen flik.'; }
  }
  bindUI() {
    const click = (id: string, fn: () => void) => { $(id).onclick = () => { this.audio.init(); this.audio.ui(); fn(); }; };
    click('btnBack', () => { show('brief', false); show('menu', true); });
    click('btnGo', () => { show('brief', false); this.start(this.mission, (Math.random() * 1e6) | 0); this.lock(); });
    click('btnResume', () => this.resume());
    click('btnRestart', () => { show('pause', false); this.start(this.mission, (Math.random() * 1e6) | 0); this.lock(); });
    click('btnQuit', () => this.toMenu()); click('btnMenu', () => this.toMenu());
    click('btnAgain', () => { show('debrief', false); this.start(this.mission, (Math.random() * 1e6) | 0); this.lock(); });
    click('btnNext', () => { show('debrief', false); this.start((this.mission + 1) % MISSIONS.length, (Math.random() * 1e6) | 0); this.lock(); });
    for (const id of ['btnHelp', 'btnHelp2']) click(id, () => show('help', true));
    for (const id of ['btnSettings', 'btnSettings2']) click(id, () => show('settings', true));
    document.querySelectorAll<HTMLElement>('.close').forEach(b => b.onclick = () => { b.closest('.screen')!.classList.add('hidden'); this.audio.ui(); });
    const bind = (id: string, k: keyof Settings, num = true) => $(id).addEventListener('input', e => { (S as any)[k] = num ? +(e.target as HTMLInputElement).value : (e.target as HTMLInputElement).value; saveSettings(); this.applySettings(); });
    bind('sSens', 'sens'); bind('sVol', 'vol'); bind('sMic', 'mic'); bind('sLang', 'lang', false); bind('sTts', 'tts'); bind('sHead', 'head'); bind('sQual', 'qual'); bind('sDiff', 'diff');
  }
  toMenu() { this.state = 'menu'; this.speech.stop(); this.voice.stop(); for (const id of ['pause', 'debrief', 'hud', 'brief']) show(id, false); this.buildMenu(); show('menu', true); if (document.pointerLockElement) document.exitPointerLock(); }
  lock() { if (!AUTO) { const p: any = $('c').requestPointerLock(); if (p?.catch) p.catch(() => { }); } }
  resume() { show('pause', false); this.state = 'play'; this.lock(); if (S.mic) this.voice.start(); this.last = performance.now(); }
  pause() { if (this.state !== 'play') return; this.state = 'pause'; show('pause', true); this.keys.clear(); this.mouseDown = false; }

  // ---------------- mission start ----------------
  start(mission: number, seed: number) {
    this.mission = mission; this.seed = seed; this.audio.init();
    const sim = this.sim = new Sim(mission, seed, S.diff);
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x070a10); this.scene.fog = new THREE.FogExp2(0x070a10, 0.028);
    this.scene.add(new THREE.AmbientLight(0x9fb0c8, S.qual ? 0.45 : 1.1), new THREE.HemisphereLight(0xb8c8ff, 0x2a241c, 0.55));
    const moon = new THREE.DirectionalLight(0xa8c0ff, 0.7); moon.position.set(-8, 14, 6); this.scene.add(moon);
    this.level = new LevelView(sim, S.qual); this.scene.add(this.level.group);
    this.fx = new FX(); this.scene.add(this.fx.group);
    this.views.clear(); for (const a of sim.actors) { if (a.kind === 'player') continue; const v = new ActorView(a); this.views.set(a, v); this.scene.add(v.root); }
    this.scene.add(this.camera); this.camera.add(this.torch); this.torch.position.set(0.15, -0.1, 0); this.camera.add(this.torch.target); this.torch.target.position.set(0, 0, -1);
    this.yaw = sim.player.yaw; this.pitch = 0; this.weapon = 0; this.ammo = [30, 15]; this.reserve = [150, 60]; this.reloadT = 0; this.fireCd = 0; this.recoil = 0; this.dmgFx = 0; this.endT = 0;
    this.selTeam = this.lastTeam = 'ALL'; this.state = 'play'; this.last = performance.now(); $('log').innerHTML = ''; $('heard').textContent = ''; $('parsed').textContent = '';
    this.buildMap(); show('menu', false); show('hud', true); this.updateHud(true);
    if (S.mic && !AUTO) this.voice.start();
    this.log('Insatsledning: ' + MISSIONS[mission].name + '. Ge order med rösten – lycka till.', 'me');
  }

  // ---------------- input ----------------
  bindInput() {
    const c = $('c');
    c.addEventListener('click', () => { if (this.state === 'play' && !document.pointerLockElement) this.lock(); });
    document.addEventListener('pointerlockchange', () => { if (!document.pointerLockElement && this.state === 'play' && !AUTO && !this.typing) this.pause(); });
    document.addEventListener('mousemove', e => {
      if (this.state !== 'play' || (!document.pointerLockElement && !AUTO)) return;
      const k = 0.0022 * S.sens; this.yaw -= e.movementX * k; this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - e.movementY * k));
      this.sway.x += e.movementX * 0.00012; this.sway.y += e.movementY * 0.00012;
    });
    document.addEventListener('mousedown', e => { if (this.state !== 'play' || !document.pointerLockElement) return; if (e.button === 0) this.mouseDown = true; if (e.button === 1) { e.preventDefault(); this.shout(true); } });
    document.addEventListener('mouseup', e => { if (e.button === 0) { this.mouseDown = false; this.semiLock = false; } });
    document.addEventListener('keydown', e => {
      if (this.typing) { if (e.code === 'Enter') { const inp = $<HTMLInputElement>('cmdinput'); const v = inp.value.trim(); inp.value = ''; this.setTyping(false); if (v) this.heard(v, false); e.preventDefault(); } else if (e.code === 'Escape') this.setTyping(false); return; }
      if (e.code === 'Escape') { if (!$('help').classList.contains('hidden') || !$('settings').classList.contains('hidden')) { show('help', false); show('settings', false); } else if (this.state === 'pause') this.resume(); else if (this.state === 'play' && AUTO) this.pause(); return; }
      if (this.state !== 'play') return;
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
      if (e.repeat) return; this.keys.add(e.code); this.onKey(e.code);
    });
    document.addEventListener('keyup', e => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.mouseDown = false; });
  }
  setTyping(on: boolean) { this.typing = on; show('cmdbox', on); const inp = $<HTMLInputElement>('cmdinput'); if (on) { this.keys.clear(); inp.focus(); } else inp.blur(); }
  onKey(code: string) {
    const sim = this.sim!; if (sim.over) return;
    const quick: Record<string, Command['action'] | 'there'> = { Digit3: 'follow', Digit4: 'hold', Digit5: 'there', Digit6: 'cover', Digit7: 'stack', Digit8: 'breach', Digit9: 'bang', Digit0: 'restrain' };
    switch (code) {
      case 'KeyF': sim.playerUse(); break;
      case 'KeyR': this.reload(); break;
      case 'KeyG': this.throwBang(); break;
      case 'KeyV': case 'KeyQ': this.shout(true); break;
      case 'KeyT': this.torchOn = !this.torchOn; this.audio.dry(); break;
      case 'KeyM': this.mapOn = !this.mapOn; break;
      case 'KeyC': sim.player.crouch = !sim.player.crouch; break;
      case 'Digit1': case 'Digit2': { const w = code === 'Digit1' ? 0 : 1; if (w !== this.weapon) { this.weapon = w; this.reloadT = 0; this.fireCd = 0.35; this.vmKick = -0.5; this.audio.dry(); } break; }
      case 'Tab': this.selTeam = this.selTeam === 'ALL' ? 'A' : this.selTeam === 'A' ? 'B' : 'ALL'; this.audio.ui(); this.updateHud(true); break;
      case 'Enter': this.setTyping(true); break;
      default: if (quick[code]) { const q = quick[code]; this.exec(q === 'there' ? { team: this.selTeam, action: 'move', dir: 'there' } : { team: this.selTeam, action: q }, true); }
    }
  }

  // ---------------- commands ----------------
  heard(text: string, fromMic: boolean) {
    if (this.state !== 'play' || !this.sim) return;
    if (fromMic && !S.head && this.speech.speaking) { // don't let the team's own radio voice trigger orders
      $('heard').textContent = '« ' + text.split('|')[0].trim() + ' »'; const q = $('parsed'); q.className = 'bad'; q.textContent = 'Ignorerat – teamet pratade samtidigt (säg det igen)'; this.parsedT = 4; return;
    }
    const alts = text.split('|').map(s => s.trim()).filter(Boolean); let cmd: Command | null = null;
    for (const a of alts) { cmd = parseCommand(a, this.lastTeam); if (cmd) break; }
    $('heard').textContent = '« ' + alts[0] + ' »'; this.parsedT = 4;
    const p = $('parsed');
    if (!cmd) { p.className = 'bad'; p.textContent = 'Uppfattade ingen order'; this.audio.fail(); return; }
    this.exec(cmd, !fromMic);
  }
  exec(cmd: Command, byKey: boolean) {
    const sim = this.sim!; const p = $('parsed'); p.className = ''; this.parsedT = 4;
    if (cmd.action === 'shout') { p.textContent = ACTION_LABEL.shout; this.shout(byKey); return; }
    const tname = cmd.team === 'ALL' ? 'ALLA' : 'TEAM ' + cmd.team;
    p.textContent = `${tname} › ${ACTION_LABEL[cmd.action]}${cmd.action === 'move' && cmd.dir ? ' ' + DIR_LABEL[cmd.dir] : ''}`;
    this.lastTeam = cmd.team; this.selTeam = cmd.team;
    const ok = sim.command(cmd, this.aimPoint()); if (ok) this.audio.ok(); else { this.audio.fail(); this.log('Ingen i det teamet kan svara.', 'warn'); }
    this.updateHud(true);
  }
  aimDir() { const cp = Math.cos(this.pitch); return new THREE.Vector3(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp); }
  aimPoint() { const sim = this.sim!, p = sim.player, d = this.aimDir(); const h = sim.ray(p.x, this.eye, p.z, d.x, d.y, d.z, 40, p); return h.kind === 'none' ? null : { x: h.x - d.x * 0.4, z: h.z - d.z * 0.4 }; }
  shout(tts: boolean) {
    const sim = this.sim!; if (!sim.player.alive) return; sim.playerShout();
    if (tts) this.speech.say(S.lang.startsWith('sv') ? 'Polis! Ner på marken!' : 'Police! Get down!', 0.7, 1.3, 1);
    this.log('DU: Polis! Lägg ner vapnet!', 'me');
  }
  reload() { const w = WEAPONS[this.weapon]; if (this.reloadT > 0 || this.ammo[this.weapon] >= w.mag || this.reserve[this.weapon] <= 0) return; this.reloadT = w.reload; this.audio.reload(); }
  throwBang() {
    const sim = this.sim!; if (sim.bangs <= 0 || !sim.player.alive) return; sim.bangs--; const d = this.aimDir(), p = sim.player;
    sim.throwBang(p.x + d.x * 0.4, this.eye - 0.1, p.z + d.z * 0.4, d.x, d.y, d.z); this.vmKick = -0.6;
  }
  fire() {
    const sim = this.sim!, w = WEAPONS[this.weapon], p = sim.player;
    if (this.ammo[this.weapon] <= 0) { if (!this.semiLock) { this.audio.dry(); this.semiLock = true; this.reload(); } return; }
    this.ammo[this.weapon]--; this.fireCd = w.rate;
    const moving = this.keys.has('KeyW') || this.keys.has('KeyA') || this.keys.has('KeyS') || this.keys.has('KeyD');
    const sp = w.spread * (moving ? 3.5 : 1) * (p.crouch ? 0.6 : 1) + this.recoil * 0.25, d = this.aimDir();
    d.x += (Math.random() - 0.5) * sp * 2; d.y += (Math.random() - 0.5) * sp * 2; d.z += (Math.random() - 0.5) * sp * 2; d.normalize();
    sim.fire(p, p.x, this.eye, p.z, d.x, d.y, d.z, w.dmg);
    this.recoil = Math.min(0.09, this.recoil + w.kick); this.pitch = Math.min(1.45, this.pitch + w.kick * 0.55); this.yaw += (Math.random() - 0.5) * w.kick * 0.5; this.vmKick = 1;
    this.vm.flash.visible = true; this.vm.flash.material.rotation = Math.random() * 6; setTimeout(() => { this.vm.flash.visible = false; }, 45);
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
        fx.tracer(a, b); const pn = this.pan(e.x, e.z); this.audio.shot(pn.d, pn.pan, own, own ? this.weapon === 0 : true); fx.flashAt(a.x, a.y, a.z, own ? 14 : 22);
        if (e.hit === 'wall') { fx.burst(e.x2, e.y2, e.z2, 7, 0xb8b0a0, 2.2, 6, 0.35); fx.burst(e.x2, e.y2, e.z2, 2, 0xffd080, 4, 9, 0.15); fx.hole(e.x2 - (e.x2 - e.x) * 0.002, e.y2, e.z2 - (e.z2 - e.z) * 0.002); const q = this.pan(e.x2, e.z2); if (q.d < 12) this.audio.impact(q.d, q.pan); }
        else if (e.hit === 'actor') fx.burst(e.x2, e.y2, e.z2, 12, 0x8a0f0f, 2.4, 7, 0.5);
        break;
      }
      case 'hurt': if (e.a === p) { this.dmgFx = 1; this.audio.hurt(); this.recoil += 0.03; } else if (e.a.kind !== 'officer') { /* hit marker only for own shots handled below */ } break;
      case 'death': if (e.a.kind === 'officer') this.log(`${e.a.name} har stupat.`, 'warn'); break;
      case 'door': { const q = this.pan(e.door.cx + 0.5, e.door.cz + 0.5); this.audio.door(q.d, q.pan); break; }
      case 'say': {
        const o = e.a; this.log(`${o.name}: ${e.text.replace(/^Team [AB]: /, '')}`, o.team); this.audio.radio();
        if (!e.shout || Math.random() < 0.6) this.speech.say(e.text, [0.85, 1.25, 0.65, 1.05][o.slot] ?? 1, e.shout ? 1.35 : 1.2, e.shout ? 1 : 0.85);
        break;
      }
      case 'bang': { const q = this.pan(e.x, e.z); this.audio.bang(q.d, q.pan, p.flash); fx.flashAt(e.x, 1, e.z, 900, 0.12, 0xffffff); fx.burst(e.x, 0.3, e.z, 60, 0xffffff, 7, 3, 0.5); fx.burst(e.x, 0.3, e.z, 30, 0x999999, 2, -0.5, 1.6); break; }
      case 'throw': this.audio.step(0.3); break;
      case 'cuff': { const q = this.pan(e.a.x, e.a.z); if (q.d < 10) this.audio.cuff(); if (e.by === p) this.log(e.a.kind === 'suspect' ? 'Du säkrade en misstänkt.' : 'Du säkrade en civil.', 'me'); break; }
      case 'surrender': { const q = this.pan(e.a.x, e.a.z); if (q.d < 14 && sim.los(p.x, p.z, e.a.x, e.a.z)) this.log(e.a.kind === 'suspect' ? 'Misstänkt ger upp – sätt handfängsel!' : 'Civil lyder – säkra personen.', ''); break; }
      case 'marker': fx.marker(e.x, e.z, TEAM_COLOR[e.team]); break;
      case 'info': this.log(e.text, 'warn'); this.audio.fail(); break;
      case 'end': this.endT = 2.2; this.log(e.win ? 'Byggnaden är säkrad. Bra jobbat!' : 'Du är nere. Insatsen avbryts.', e.win ? 'me' : 'warn'); break;
    }
    if (e.t === 'shot' && e.by === p && e.hit === 'actor') { this.hitFx = 1; }
  }
  debrief() {
    const sim = this.sim!, sc = sim.score(), win = !!sim.over?.win; this.state = 'end'; this.voice.stop(); if (document.pointerLockElement) document.exitPointerLock();
    $('debTitle').textContent = win ? 'Uppdraget slutfört' : 'Uppdraget misslyckades'; $('debRank').textContent = 'Omdöme: ' + sc.rank;
    $('debTable').innerHTML = sc.parts.filter(p => p.max > 0 || p.pts < 0).map(p => `<tr><td>${p.label}</td><td class="${p.pts < 0 ? 'neg' : ''}">${p.pts}${p.max ? ' / ' + p.max : ''}</td></tr>`).join('') + `<tr class="total"><td>Totalt</td><td>${sc.total} / 100</td></tr>`;
    if (win && (best[this.mission] ?? -1) < sc.total) { best[this.mission] = sc.total; localStorage.setItem('teamai.best', JSON.stringify(best)); }
    show('hud', false); show('debrief', true); win ? this.audio.ok() : this.audio.fail();
  }

  // ---------------- HUD ----------------
  micState(s: string, detail?: string) {
    const dot = $('micdot'), txt = $('micstate'); dot.className = s === 'listening' ? 'on' : s === 'denied' || s === 'error' || s === 'unsupported' ? 'err' : '';
    txt.textContent = ({ listening: 'MIKROFON PÅ – LYSSNAR', starting: 'STARTAR MIKROFON…', off: 'MIKROFON AV – tryck Enter för att skriva order', denied: 'MIKROFON BLOCKERAD – tillåt i webbläsaren / öppna i egen flik', unsupported: 'RÖSTSTYRNING STÖDS EJ HÄR – använd Chrome/Edge eller Enter', error: 'MIKROFONFEL' + (detail ? ' (' + detail + ')' : '') } as Record<string, string>)[s] ?? s;
  }
  buildMap() {
    const sim = this.sim!, l = sim.level, k = 4, c = document.createElement('canvas'); c.width = l.w * k; c.height = l.h * k; const g = c.getContext('2d')!;
    for (let z = 0; z < l.h; z++) for (let x = 0; x < l.w; x++) { const v = l.cells[z * l.w + x]; g.fillStyle = v === WALL ? '#8fa3b5' : v === DOOR ? '#f2c14e' : v === LOW || v === HIGH ? '#33414d' : v === 1 ? '#18212a' : '#0c1116'; g.fillRect(x * k, z * k, k, k); }
    this.mapBase = c; const m = $<HTMLCanvasElement>('minimap'); m.width = c.width; m.height = c.height; m.style.width = c.width * 1.15 + 'px';
  }
  drawMap() {
    const m = $<HTMLCanvasElement>('minimap'); m.style.display = this.mapOn ? '' : 'none'; if (!this.mapOn || !this.mapBase) return;
    const g = m.getContext('2d')!, sim = this.sim!, k = 4; g.drawImage(this.mapBase, 0, 0);
    for (const d of sim.level.doors) if (d.open > 0.5) { g.fillStyle = '#18212a'; g.fillRect(d.cx * k, d.cz * k, k, k); }
    for (const a of sim.actors) {
      if (a.kind === 'officer' && a.alive) { g.fillStyle = a.team === 'A' ? '#ff5a5a' : '#5aa2ff'; g.fillRect(a.x * k - 2, a.z * k - 2, 4, 4); }
      else if (a.restrained && a.alive) { g.fillStyle = a.kind === 'suspect' ? '#c08a2a' : '#4fd07a'; g.fillRect(a.x * k - 1.5, a.z * k - 1.5, 3, 3); }
    }
    const p = sim.player, f = fwd(this.yaw); g.fillStyle = '#fff'; g.beginPath(); g.moveTo(p.x * k + f.x * 6, p.z * k + f.z * 6); g.lineTo(p.x * k - f.x * 3 - f.z * 3.5, p.z * k - f.z * 3 + f.x * 3.5); g.lineTo(p.x * k - f.x * 3 + f.z * 3.5, p.z * k - f.z * 3 - f.x * 3.5); g.fill();
  }
  updateHud(force = false) {
    const sim = this.sim; if (!sim) return; this.hudT -= 1; if (!force && this.hudT > 0) return; this.hudT = 8;
    const p = sim.player, r = sim.remaining();
    ($('hpbar').firstElementChild as HTMLElement).style.width = Math.max(0, p.hp) + '%'; $('hptxt').textContent = String(Math.ceil(Math.max(0, p.hp)));
    $('wname').textContent = WEAPONS[this.weapon].name + (this.reloadT > 0 ? ' – LADDAR OM' : ''); const ac = $('acount'); ac.innerHTML = `<b>${this.ammo[this.weapon]}</b> / ${this.reserve[this.weapon]}`; ac.className = this.ammo[this.weapon] <= 5 ? 'low' : '';
    $('bangs').textContent = 'CHOCKGRANAT ' + '◉'.repeat(sim.bangs) + '○'.repeat(3 - sim.bangs);
    $('objective').innerHTML = `MISSTÄNKTA KVAR <b>${r.suspects}</b> &nbsp;·&nbsp; CIVILA ATT SÄKRA <b>${r.civs}</b>`;
    let html = '';
    for (const t of ['A', 'B'] as Team[]) {
      const T = sim.teams[t]; html += `<div class="tcard ${t} ${this.selTeam === t || this.selTeam === 'ALL' ? 'sel' : ''}"><h4>TEAM ${t}<span>${ORDER_LABEL[T.order.type]}${T.fire === 'hold' ? ' · ELD UPPHÖR' : ''}</span></h4>`;
      for (const o of sim.officers.filter(o => o.team === t)) html += `<div class="mem ${o.alive ? '' : 'dead'}">${o.name}<i><u style="width:${o.hp}%;background:${o.hp > 60 ? '#5fe08a' : o.hp > 30 ? '#f2c14e' : '#e04848'}"></u></i></div>`;
      html += '</div>';
    }
    $('team').innerHTML = html;
    $('quick').innerHTML = `<kbd>Tab</kbd> <b>${this.selTeam === 'ALL' ? 'ALLA' : 'TEAM ' + this.selTeam}</b> &nbsp; <kbd>3</kbd> Följ <kbd>4</kbd> Håll <kbd>5</kbd> Dit <kbd>6</kbd> Skydda <kbd>7</kbd> Ställ upp <kbd>8</kbd> Storma <kbd>9</kbd> Granat <kbd>0</kbd> Säkra &nbsp; <kbd>Enter</kbd> Skriv order`;
    const it = sim.interactTarget(), pr = $('prompt');
    if (sim.playerCuff) { pr.style.opacity = '1'; pr.textContent = 'Sätter handfängsel…'; $('progress').style.opacity = '1'; ($('progress').firstElementChild as HTMLElement).style.width = (sim.playerCuffT / 1.6) * 100 + '%'; }
    else { $('progress').style.opacity = '0'; if (it?.actor) { pr.style.opacity = '1'; pr.innerHTML = '<kbd>F</kbd> Sätt handfängsel'; } else if (it?.door) { pr.style.opacity = '1'; pr.innerHTML = `<kbd>F</kbd> ${it.door.target ? 'Stäng' : 'Öppna'} dörr`; } else pr.style.opacity = '0'; }
  }

  // ---------------- frame ----------------
  frame() {
    requestAnimationFrame(() => this.frame());
    const now = performance.now(), dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
    if (this.state === 'play' && this.sim) this.tick(dt);
    this.render();
  }
  tick(dt: number) {
    const sim = this.sim!, p = sim.player, K = this.keys;
    p.yaw = this.yaw; p.pitch = this.pitch;
    if (p.alive && !sim.over && !this.typing) {
      let mx = 0, mz = 0; if (K.has('KeyW')) mz += 1; if (K.has('KeyS')) mz -= 1; if (K.has('KeyD')) mx += 1; if (K.has('KeyA')) mx -= 1;
      const len = Math.hypot(mx, mz);
      if (len) {
        const run = K.has('ShiftLeft') || K.has('ShiftRight'), sp = (p.crouch ? 1.9 : run ? 5.3 : 3.5) * dt / len, f = fwd(this.yaw);
        const bx = p.x, bz = p.z; sim.movePlayer((f.x * mz - f.z * mx) * sp, (f.z * mz + f.x * mx) * sp);
        const moved = Math.hypot(p.x - bx, p.z - bz); this.bob += moved * 3.3; this.stepAcc += moved; if (this.stepAcc > (run ? 2.2 : 1.6)) { this.stepAcc = 0; this.audio.step(p.crouch ? 0.08 : run ? 0.32 : 0.18); }
      }
      this.fireCd -= dt;
      if (this.reloadT > 0) { this.reloadT -= dt; if (this.reloadT <= 0) { const w = WEAPONS[this.weapon], n = Math.min(w.mag - this.ammo[this.weapon], this.reserve[this.weapon]); this.ammo[this.weapon] += n; this.reserve[this.weapon] -= n; } }
      else if (this.mouseDown && this.fireCd <= 0 && (WEAPONS[this.weapon].auto || !this.semiLock)) { this.fire(); if (!WEAPONS[this.weapon].auto) this.semiLock = true; }
    }
    sim.update(dt);
    for (const e of sim.events) this.handle(e); sim.events.length = 0;
    this.level!.update(); for (const v of this.views.values()) v.update(dt, sim.time); this.fx.update(dt, sim);
    // camera
    this.recoil = Math.max(0, this.recoil - dt * 0.22); this.dmgFx = Math.max(0, this.dmgFx - dt * 1.4); this.hitFx = Math.max(0, this.hitFx - dt * 5);
    const targetEye = !p.alive ? 0.35 : p.crouch ? 1.12 : 1.62; this.eye += (targetEye - this.eye) * Math.min(1, dt * 9);
    this.camera.position.set(p.x, this.eye + Math.sin(this.bob * 2) * 0.022, p.z); this.camera.rotation.set(this.pitch, this.yaw, !p.alive ? 0.5 : Math.sin(this.bob) * 0.004);
    this.torch.intensity = this.torchOn ? 22 : 0;
    // view model
    const g = this.vm.group; this.vmKick += (0 - this.vmKick) * Math.min(1, dt * 14); this.sway.multiplyScalar(Math.max(0, 1 - dt * 9));
    const rl = this.reloadT > 0 ? Math.sin(Math.min(1, this.reloadT / WEAPONS[this.weapon].reload) * Math.PI) : 0;
    g.position.set(0.2 - this.sway.x + Math.sin(this.bob) * 0.006, -0.2 + this.sway.y - rl * 0.16 + Math.abs(Math.cos(this.bob)) * 0.006 + Math.min(0, this.vmKick) * 0.2, -0.5 + Math.max(0, this.vmKick) * 0.05);
    g.rotation.set(Math.max(0, this.vmKick) * 0.07 - rl * 0.7, 0.03 + this.sway.x * 2, rl * 0.5);
    this.vm.rifle.visible = this.weapon === 0; this.vm.pistol.visible = this.weapon === 1; g.visible = p.alive;
    // overlays
    $('dmg').style.opacity = String(Math.max(this.dmgFx, p.hp < 35 && p.alive ? 0.35 : 0, p.alive ? 0 : 0.8)); $('flash').style.opacity = String(Math.min(1, p.flash * 1.6));
    const hm = $('hitmark'); hm.style.opacity = String(this.hitFx);
    const gap = 6 + this.recoil * 260 + (K.has('KeyW') || K.has('KeyA') || K.has('KeyS') || K.has('KeyD') ? 7 : 0) - (p.crouch ? 2 : 0); $('cross').style.setProperty('--gap', gap + 'px');
    if (this.parsedT > 0) { this.parsedT -= dt; if (this.parsedT <= 0) { $('parsed').textContent = ''; $('heard').textContent = ''; } }
    this.updateHud(); this.drawMap();
    if (this.endT > 0) { this.endT -= dt; if (this.endT <= 0) this.debrief(); }
  }
  render() {
    const r = this.renderer; r.clear();
    if (this.sim) { r.render(this.scene, this.camera); if (this.state !== 'menu') { r.clearDepth(); r.render(this.viewScene, this.viewCam); } }
  }
}

const game = new Game();
(window as any).__ta = game;
