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
