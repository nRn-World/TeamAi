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
