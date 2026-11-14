# TeamAi

Röststyrd taktisk förstapersonsskjutare i webbläsaren (inspirerad av SWAT 4). Du leder Team A och Team B med rösten medan du spelar med tangentbord och mus.

## Köra

```
npm install
npm run dev      # http://localhost:5173 – använd Chrome eller Edge för röststyrning
npm test         # headless simulering + test av röstkommando-tolken
npm run build    # produktion till dist/
```

## Struktur

- `src/sim/` – spellogik utan grafik (banor, pathfinding, AI, order, poäng, kommandotolk). Körs även i Node för tester.
- `src/game/` – three.js-grafik, procedurella texturer/figurer, syntetiserat ljud, röstigenkänning.
- `src/main.ts` – spel-loop, inmatning, HUD och menyer.

## Licenser

Kod-beroenden: three.js (MIT), Vite (MIT), TypeScript (Apache-2.0). All grafik, alla figurer och allt ljud genereras av spelets egen kod – inga tredjepartsfiler.

## Röster

Replikerna i `voice/lines.json` spelas in av arbetsflödet `.github/workflows/voices.yml` (Piper + den svenska rösten NST, CC0) och sparas i `public/voice/`. Ändra eller lägg till rader i `voice/lines.json` och pusha, så skapas klippen om automatiskt. Spelet ger varje figur en egen röstprofil (tonläge, radiofilter för teamet, grövre röst för misstänkta). Rader utan klipp läses upp av webbläsarens talsyntes.

## 3D-figurer

Poliser, misstänkta och civila är animerade figurer ur «Ultimate Modular Men» och «Ultimate Modular Women» av Quaternius (CC0). `tools/pack_models.py` packar originalfilerna (.gltf) till `public/models/*.glb` och behåller bara de animationer spelet använder. Går filerna inte att ladda används de inbyggda klossfigurerna.

## Rörelse och ljud

| Tangent | Rörelse | Hörs av fiender |
|---|---|---|
| W A S D | Gå (3,5 m/s) | ca 6 m |
| Shift | Springa (5,3 m/s) | ca 12 m |
| X (av/på) | Smyga / gå långsamt (1,5 m/s) | nej, inga fotsteg |
| C (av/på) | Huka (1,9 m/s) | nej |
| Z (av/på) | Krypa (0,9 m/s) | nej, inga fotsteg |
| Mellanslag | Hoppa (reser dig om du hukar/kryper) | landningen hörs ca 7 m |

Fiender kan fortfarande *se* dig även när du är tyst.

## Modell i huvudmenyn

Insatspoliserna i huvudmenyn är «S.W.A.T. Operator» av Mateusz Woliński (CC BY 4.0, källa och licens i `public/models/operator/license.txt`). Upphovspersonen nämns under Inställningar → Tack & licenser, vilket licensen kräver. `tools/pack_operator.py` förminskar texturerna från originalnedladdningen.
