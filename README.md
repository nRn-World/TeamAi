# TeamAi

Voice-commanded tactical first-person shooter for the browser (inspired by SWAT 4). You lead Team A and Team B with your voice while you play with keyboard and mouse. The whole game – text, speech recognition and spoken lines – is in English.

## Running

```
npm install
npm run dev      # http://localhost:5173 – use Chrome or Edge for voice control
npm test         # headless simulation + tests of the voice-command parser
npm run build    # production build in dist/
```

## Structure

- `src/sim/` – game logic without graphics (levels, pathfinding, AI, orders, scoring, command parser). Also runs in Node for the tests.
- `src/game/` – three.js graphics, textures, characters, sound, speech recognition, networking.
- `src/main.ts` – game loop, input, HUD and menus.

## Licences

Code dependencies: three.js (MIT), Vite (MIT), TypeScript (Apache-2.0), PeerJS (MIT). Third-party assets and their authors are listed in the game under Settings → Credits & licences; every CC BY asset ships with its `license.txt`.

## Voices

The lines in `voice/lines.json` are rendered by the workflow `.github/workflows/voices.yml` with the speech model Kokoro-82M (Apache-2.0) and stored in `public/voice/`. Edit or add lines in `voice/lines.json` and push; the clips are regenerated automatically.

Each entry has the text `t`, the roles that speak it `r` (`p` player, `o` officer, `s` suspect, `c` civilian) and optionally `s: 1` for a shouted line. Every role has its own set of voices (`voice/make.py`), so the four officers, the suspects and the civilians all sound like different people, and women figures have women's voices. Shouted lines are spoken faster, pitch-raised, heavily compressed, given a presence boost, light overdrive and a short room echo. Lines without a clip are read by the browser's speech synthesis.

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

## Weapon sounds

Shots, reloads, clicks and the flashbang are built from recordings of real firearms in `public/sfx/` (all CC0, sources in `public/sfx/LICENSE.txt`). The carbine is an AR-15, the pistol a Walther PPQ and the suspects' weapon a Carl Gustav m/45. At a distance the sound crossfades to a recording of the same weapon from far away. If the files cannot be loaded the synthetic sounds are used.

## Weapon models

The carbine is «Low-Poly M4a1» by TastyTony and the pistol «Glock17» by sigmuuus (both CC BY 4.0, source and licence in `public/models/weapons/*/license.txt`). `src/game/weapons.ts` loads and normalises the models; if they cannot be loaded the built-in box weapons are used.

## First-person arms

The first-person view shows animated gloved arms from «Animated FPS hands (rifle animation pack)» by Cransh (CC BY 4.0, `public/models/fpsarms/license.txt`). The pack's own animations are used for idle, walk, run, fire, reload and weapon switch. In carbine mode the arms hold the pack's rifle with a red-dot sight, in pistol mode the Glock in the right hand. The arms are only loaded above graphics level Low; otherwise, or if the files cannot be fetched, the simpler weapon model is shown.

## Aiming and civilians

Hold the right mouse button to zoom in and aim: the field of view narrows, the weapon comes up to the eye, the mouse slows down and the spread shrinks. Civilians who see the police close by kneel on their own with their hands up. Without handcuffs they get up and run when no officer has seen them for about seven seconds. The teams therefore cuff everyone nearby who has given up, without a separate order.
