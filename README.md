# TeamAi

Voice-commanded tactical first-person shooter for the browser (inspired by SWAT 4). You lead Team A and Team B with your voice while you play with keyboard and mouse. The whole game – text, speech recognition and spoken lines – is in English.

## Running

```
npm install
npm run dev      # http://localhost:5173 – use Chrome or Edge for voice control
npm test         # headless simulation + tests of the voice-command parser
npm run playtest # fast headless playthrough used as a CI gate (a few seconds)
npm run build    # production build in dist/
npm run smoke:browser # Chromium smoke at High (shadows, post FX, F3 metrics)
```

## Structure

- `src/sim/` – game logic without graphics (levels, pathfinding, AI, orders, scoring, command parser). Also runs in Node for the tests.
- `src/game/` – three.js graphics, textures, characters, sound, speech recognition, networking.
- `src/main.ts` – game loop, input, HUD and menus.

## Licences

Code dependencies: three.js (MIT), Vite (MIT), TypeScript (Apache-2.0), PeerJS (MIT). Third-party assets and their authors are listed in the game under Settings → Credits & licences; every CC BY asset ships with its `license.txt`.

## Career, ranks and the roster

`src/game/career.ts` holds the meta-game (pure logic, unit-tested in `tests/sim.test.ts`):

- **Ranks unlock kit.** 0 XP Rookie Officer (TX-4 carbine + P-17), 200 Tactical Officer (ARC-2 stunner),
  500 Senior Breacher (S-87 shotgun), 950 Entry Team Lead (LL-12 launcher), 1500 Tactical Commander
  (ballistic shield), 2400 Master Operator (+20 % XP). Locked items show up in the Armory with the rank
  that opens them, and the loadout select refuses anything the rank does not carry.
- **Campaign order.** Operation N opens when N-1 has been completed; the mission strip marks locked
  operations, the Armory shows the next operation and the cleared count, and the debrief offers
  *Next mission · name* only when it is actually unlocked.
- **Consequences.** Officers who end an operation down sit out 1–3 operations. While they recover a
  rookie (lower speed, lower HP, no role perk) takes their slot, which is passed to the sim through
  `CoopMods.roster`; the Armory lists who is fit, and the debrief reports who was hurt and who is back.
- **Ironman.** A toggle in the Armory: no restarts (the pause menu hides *Restart mission*) and a failed
  operation earns no XP — but the injuries still come home. The daily raid always runs under the same rule.
- **Onboarding.** The first launch shows a *First deployment* card with the six controls that matter and
  the scoring rule (arrests pay, bodies do not). *START TRAINING* (or `?training=1`) runs an optional,
  repeatable first deployment with no live threats and a six-step controls/ROE checklist; finishing it
  marks the tutorial as done, while *END TRAINING* returns to the menu without changing progress.

## Feedback, performance and stairs

- **Debrief.** The debrief keeps the score, awards, notes and replay, and adds a *Rules of engagement*
  block: arrests, unauthorized force, civilians killed by police, officers down, evidence and non-lethal
  hits. It ends in CLEAN or REVIEW with a short explanation of what to correct.
- **High performance.** `F3` (or `?perf=1`) shows FPS, p95 frame time, draw calls, triangles and the
  active render scale. On High/Ultra the render scale adapts between 70 % and 100 % when frame time
  stays above 24 ms, so a slower GPU keeps a playable frame rate; the menu and mission start reset it.
- **Smoke test.** `tools/browser-smoke.mts` boots the production build at High in Chromium/SwiftShader,
  checks shadows, post FX, first-person arms and the perf probe, and runs in GitHub Actions with a
  screenshot artifact. It intentionally reports timings on the software renderer instead of enforcing
  an FPS threshold.
- **Stairs.** Kista's stair flights are walkable by both the player and the live squad; the minimap
  marks stair endpoints with their floor (`F1`, `F2`) and the HUD shows `STAIRS ↑/↓` when you are on
  a flight.

## Bomb operations and insertion points

The bomb timer is held until the squad earns the pressure: it starts when a player gets within 14 m of the device or when a firefight begins. Until then the HUD reads `BOMB · TIMER HELD`; afterwards it counts down, and the bomb hint under it shows the distance and a relative bearing arrow. If the whole entry team goes down with less than 30 s left, the nearest officer takes over and moves to defuse the device on their own.

Locked wooden doors are kicked open with `F` (metal vault doors still need a Breach Charge). This is what makes the Club Eclipse *Backstage Alley (Locked)* insertion usable: it starts six metres from the bomb, behind a door the team can kick in. `tools/playtest.mts` checks that route, the deployment grace and the bomb flow on every push.

## Key bindings

Movement, stance, use, reload, shout, grenade cycle and voice are rebindable under Settings → Key bindings; the bindings are stored with the rest of the settings and conflicts are swapped rather than silently dropped. The Controls screen still lists the default layout. Default keys are also shown in the HUD quick bar, which follows the shout binding.

## Furniture placement

`furnish()` in `src/sim/level.ts` no longer drops furniture on random floor cells. Each room is
split into cells that touch a wall and cells that stand in the open, and every piece that belongs
against a wall (sofas, desks, beds, shelves, lockers, bar counters, server racks) is only placed on
a wall cell, with its back to that wall and its front into the room. The pieces that are allowed to
stand free (chairs, poufs, crates) turn towards the middle of their room instead of staring at a
wall, and a desk gets a chair pulled up in front of it, facing the desk.

The budget per room and the front-clearance rule are unchanged, so walkways, doors and the
reachability check behave exactly as before; `tests/sim.test.ts` still passes and 100 % of the
wall furniture in every mission/seed now has a wall behind it (it used to be about 50 %).

## Lighting and finish

Above graphics level Low every frame goes through a three.js `EffectComposer` chain in `src/game/postfx.ts`:

- the world scene and then the weapon scene are rendered into one HDR (half-float) target, so the gun is never fogged by the level,
- `UnrealBloomPass` picks up only the light fittings: the ceiling panels are pushed to ~1.28 in linear space and the threshold sits at 2.7, so a lamp close to a wall or a glass pane can no longer bloom the whole screen white — only the fittings themselves and the neon signs glow,
- `OutputPass` does the ACES tone map and the sRGB conversion (a render target bypasses the renderer's own tone mapping, so this pass is required),
- a small grade pass adds cool shadows / warm highlights, a vignette, film grain and a touch of edge aberration, and flashes red at the edges when you are hit,
- `FXAAPass` on High and Ultra.

Glass panes (`MeshPhysicalMaterial`) use a broad, weak specular lobe (`roughness` ~0.22, `specularIntensity` 0.45, `envMapIntensity` 0.9) so a nearby lamp cannot fire a white hotspot across the entrance.

## Friendly fire

The squad takes friendly fire. One stray round draws a warning ("Check your fire!"), but a second
round into the **same** officer within 3.5 s turns the whole entry team hostile: the team cards flip
to HOSTILE, a red banner drops, and every officer closes in and returns fire until you are down
(`Sim.squadHostile`, `Sim.ffHits`). Pellets and penetration hits from a single trigger pull count
once, so a shotgun blast near a teammate is not an instant mutiny. In co-op the previous rule still
holds: squadmates cannot hurt each other unless the friendly-fire modifier is on.

The room lighting was rebalanced for it: ambient and hemisphere light were cut back, the wall and ceiling tints are darkened, and the dynamic light pool carries the scene, so corridors read as pools of light instead of a flat white wash. Low keeps the old forward render with brighter ambient light, and `?qual=0` behaves exactly as before.

## Voices

The lines in `voice/lines.json` are rendered by the workflow `.github/workflows/voices.yml` with the speech model Kokoro-82M (Apache-2.0) and stored in `public/voice/`. Edit or add lines in `voice/lines.json` and push; the clips are regenerated automatically.

Each entry has the text `t`, the roles that speak it `r` (`p` player, `o` officer, `s` suspect, `c` civilian) and optionally `s: 1` for a shouted line. Every role has its own set of voices (`voice/make.py`), so the four officers, the suspects and the civilians all sound like different people, and women figures have women's voices. Shouted lines are spoken faster, pitch-raised, heavily compressed, given a presence boost, light overdrive and a short room echo. Lines without a clip are read by the browser's speech synthesis.

All voice clips are measured when they are loaded and played at the same loudness, shouted or not: a shout differs in delivery, strain and room echo, not in volume. `LINE_LEVEL` and the `CH_*` constants in `src/game/audio.ts` set the levels.

When you yell a challenge (key Q, or by saying «Police! Drop the weapon!» into the microphone) the game picks one of six shouted challenges at random.

## 3D characters

Officers, suspects and civilians are animated figures from «Ultimate Modular Men» and «Ultimate Modular Women» by Quaternius (CC0). `tools/pack_models.py` packs the original files (.gltf) into `public/models/*.glb` and keeps only the animations the game uses. If the files cannot be loaded the built-in block figures are used.

## Movement and noise

| Key | Movement | Heard by enemies |
|---|---|---|
| W A S D | Walk (3.5 m/s) | about 6 m |
| Shift | Run (5.3 m/s) | about 12 m |
| X (toggle) | Sneak / walk slowly (1.5 m/s) | no, no footsteps |
| C (toggle) | Crouch (1.9 m/s) | no |
| Z (toggle) | Crawl (0.9 m/s) | no, no footsteps |
| Space | Jump (stands you up if you crouch or crawl) | the landing is heard about 7 m |

Enemies can still *see* you when you are silent.

## Model in the main menu

The operators in the main menu are «S.W.A.T. Operator» by Mateusz Woliński (CC BY 4.0, source and licence in `public/models/operator/license.txt`). `tools/pack_operator.py` downscales the textures of the original download.

## Officers and the truck

The officers are the same «S.W.A.T. Operator» model in the menu and in the game (`src/game/operator.ts`). The model has a single animation (standing ready), so in the game it follows the animated stand-in skeleton: legs and hips always, the whole body when an officer goes down, and both arms are solved onto the rifle when it is shouldered. On the lowest graphics setting the simpler figures are used instead.

The armoured truck in the menu is «Paramount Marauder» (CC BY 4.0). It only existed as a Unity import, so `tools/pack_unity_prefab.py` rebuilds a `.glb` from the prefab, and glTF Transform shrinks it:

    python3 tools/pack_unity_prefab.py <Paramount_Marauder folder> out 1024 0.92
    npx @gltf-transform/cli optimize out/model.glb public/models/vehicle/marauder.glb --compress meshopt --simplify-error 0.0015 --simplify-ratio 0.35 --texture-size 1024 --texture-compress webp

Every third-party asset is credited in the game under Settings → Credits & thanks; add new ones there (title, author, source, licence, changes) and ship the model's `license.txt`.

## Weapon sounds

Shots, reloads, clicks and the flashbang are built from recordings of real firearms in `public/sfx/` (all CC0, sources in `public/sfx/LICENSE.txt`). The carbine is an AR-15, the pistol a Walther PPQ and the suspects' weapon a Carl Gustav m/45. At a distance the sound crossfades to a recording of the same weapon from far away. If the files cannot be loaded the synthetic sounds are used.

## Weapon models

The carbine is «Low-Poly M4a1» by TastyTony and the pistol «Glock17» by sigmuuus (both CC BY 4.0, source and licence in `public/models/weapons/*/license.txt`). `src/game/weapons.ts` loads and normalises the models; if they cannot be loaded the built-in box weapons are used.

## First-person arms

The first-person view shows animated gloved arms from «Animated FPS hands (rifle animation pack)» by Cransh (CC BY 4.0, `public/models/fpsarms/license.txt`). The pack's own animations are used for idle, walk, run, fire, reload and weapon switch. In carbine mode the arms hold the pack's rifle with a red-dot sight, in pistol mode the Glock in the right hand. The arms are only loaded above graphics level Low; otherwise, or if the files cannot be fetched, the simpler weapon model is shown.

## Aiming and civilians

Hold the right mouse button to zoom in and aim: the field of view narrows, the weapon comes up to the eye, the mouse slows down and the spread shrinks. Civilians who see the police close by kneel on their own with their hands up. Without handcuffs they get up and run when no officer has seen them for about seven seconds. The teams therefore cuff everyone nearby who has given up, without a separate order.

## Officers by name

The four officers have names: **Ken** and **Maya** are Team A, **Jack** and **Zoe** are Team B (`OFFICER_NAMES` in `src/sim/sim.ts`). An order that starts with a name goes to that officer alone — «Ken, you cover us», «Maya, go in», «Jack, throw flash», «Zoe, hold here» — and a following «you …» keeps addressing the same officer. The parser (`src/sim/commands.ts`, `NAMES`) also accepts common mis-hearings such as «Kenny» or «Zoey». In the sim the officer gets `Actor.solo`, an order of their own that runs through the same code as a team order (`updateGroup`); any new order to the team clears it. «Throw flash» at a door throws through the door and the officer then waits there; with no door in sight it is thrown at the spot the player aims at.

## Door sounds

Doors use recordings from Kenney's «RPG Audio» pack (CC0, `public/sfx/door-*.mp3`, sources in `public/sfx/LICENSE.txt`): latch and swing when opening, sometimes a hinge creak, the leaf meeting the frame when closing, and a slowed slam with a low thump when a team kicks a door in on «breach». Distance lowers and muffles them (`GameAudio.door`).

## Local AI: speech and order reading

Nothing here needs a server or an API key; the models run in the player's browser and are downloaded once from the Hugging Face hub, then kept in the browser cache.

- **Speech recognition** (`src/ai/localvoice.ts`, `src/ai/asr.worker.ts`): the microphone is recorded while V is held (with a short pre-roll and tail), resampled to 16 kHz and transcribed by Whisper through Transformers.js in a worker — `onnx-community/whisper-base` on WebGPU, `Xenova/whisper-tiny` on the CPU otherwise. If the model cannot be loaded the game falls back to the browser's Web Speech service (`src/game/voice.ts`). Settings → «Speech recognition engine» switches between the two.
- **Several orders, Swedish** (`src/sim/commands.ts`): `splitOrders` cuts a sentence into orders wherever a joining word is followed by a new addressee («Ken cover the door while Team B goes in with a flash»), and the fixed rules know the Swedish words for every order. No model is involved. All orders of one sentence start at once; «first … then …» is not sequenced.
- **AI order reading** (optional, experimental, off by default; `src/ai/brain.ts`, `src/ai/llm.worker.ts`): Qwen2.5 1.5B Instruct through WebLLM (WebGPU required, about 1 GB). Only an order the fixed rules cannot read is sent to the model, which answers with the action alone (JSON constrained to a schema, `src/sim/aiorders.ts`); who the order is for is still decided by the rules. In the Actions check the model named the right action for about two out of three unfamiliar wordings; the 0.5B model was tried and was not usable.
- **Online play**: the models run only for the player who speaks. What goes over the network is the finished `Command`, exactly as before.
- `tools/check-ai.mts` + the «AI model check» workflow verify in GitHub Actions that the model files exist and show how the language model answers a list of unfamiliar English and Swedish wordings; the result is posted as a comment on the commit.

The lobby sofas, lounge poufs and desk lamps added in this round are «Glam Velvet Sofa», «Specular Silk Pouf» and «Iridescence Lamp» from the Khronos Group glTF Sample Assets (Eric Chadwick © Wayfair, LLC, CC BY 4.0). They are normalised to metric scale in `src/game/props.ts`; see `public/models/props/LICENSE.txt`.
