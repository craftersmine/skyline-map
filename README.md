# Skyline Map

**Google Maps for your Cities: Skylines city.** Open a [CSLMapView](https://steamcommunity.com/sharedfiles/filedetails/?id=845665815) export in the browser and get a real map with search, directions, an automatic metro map, travel-time maps and, if you add your save file, live traffic and city stats.

**[Open the app →](https://skyline.codz.me)** · **[Try the sample city →](https://skyline.codz.me/?sample)**

[![CI](https://github.com/hjun1052/skyline-map/actions/workflows/ci.yml/badge.svg)](https://github.com/hjun1052/skyline-map/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

![Skyline Map showing a city with transit lines, stations and terrain](public/showcase/d-hero-1600.webp)

## What it does

- **A real map:** roads at their true width, buildings and lots, water, forests, terrain and labels, in Default, Terrain and Night styles, with 3D buildings.
- **Search and info panels:** stations, districts, roads, buildings and lines.
- **Directions:** by car, transit, walking and bike, with alternatives, turn-by-turn steps, transfers, tolls and fares.
- **Navigation simulation:** drive a car route virtually with a tilted follow camera, turn-by-turn banner, optional voice guidance (English, Korean, Russian) and playback controls.
- **Transit map:** a metro-style schematic drawn automatically from your lines.
- **How far can I get?** Areas reachable in 15, 30, 45 or 60 minutes.
- **What if it closes?** Close a road, bridge or station and see which trips and lines break.
- **City time-lapse:** watch the city grow across older exports.
- **Save file (optional):** load your `.crp` save for traffic, line ridership, land value, noise, crime and pollution. Directions then follow your TM:PE one-ways, speed limits, U-turn bans and lane arrows, with an optional traffic-aware mode.
- **English, Korean and Russian** interface, desktop and phone layouts, with metric or imperial units.

Everything runs in the browser. Map and save files are read on the visitor's own device and never uploaded. Cities: Skylines 1 only.

## Run it locally

You need Node.js 20.19+ or 22.12+ (CI uses Node 24).

```bash
git clone https://github.com/hjun1052/skyline-map.git
cd skyline-map
npm ci
npm run dev
```

Open the address Vite prints and click **Try a sample city**, or drop in your own `.cslmap` file.

The dev server also lists the exports in your CSLMapView folder on the start screen. On macOS it looks in `~/Library/Application Support/Steam/steamapps/common/Cities_Skylines/CSLMapView`; set `CSLMAP_DIR=/path/to/folder` to use another folder.

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Type check and production build into `dist/` |
| `npm run preview` | Serve the production build |
| `npm run check` | Geometry, transit-time, pricing and file-finder self-checks |
| `npm run check:i18n` | Fails if any UI string has no Korean translation |
| `npm run check:data` | Runs 11 data checks (routing, transit, tolls, districts, reach…) on the sample city |
| `npm run check:<name> [files…]` | Runs one data check on your own exports (see [docs/architecture.md](docs/architecture.md)) |
| `npm run check:sim` | Save-file checks; needs real saves and exports on your computer, so it doesn't run in CI |

## Project layout

| Path | What's there |
|---|---|
| `src/` | The app. Parsing, map building and routing run in a Web Worker (`worker.ts`, `build.ts`, `router.ts`); the page handles the map and UI (`main.ts` and the `*-ui.ts` files) |
| `src/sim/` | Readers for game saves (`.crp`) and TM:PE data |
| `tools/` | Check scripts and the blog generator |
| `docs/` | How features work ([architecture.md](docs/architecture.md)), save-file data ([sim-data.md](docs/sim-data.md)) and research notes |
| `public/` | Static files: icons, fonts, showcase screenshots and the sample city |
| `blog/`, `showcase.html`, `privacy.html` | Extra pages built alongside the app |

## Contributing

Bug reports, ideas and pull requests are welcome ([open an issue](https://github.com/hjun1052/skyline-map/issues/new/choose)). Read [CONTRIBUTING.md](CONTRIBUTING.md) first: it covers setup, the checks to run, translations and how reviews work. To report a security problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Credits

- Map exports come from the [CSLMapView](https://steamcommunity.com/sharedfiles/filedetails/?id=845665815) mod. Its original web viewer inspired the format knowledge; no code from it is used.
- Rendering by [MapLibre GL JS](https://maplibre.org/). Font: [Pretendard](https://github.com/orioncactus/pretendard) (SIL OFL 1.1).
- Lane-arrow rules follow [TM:PE](https://github.com/CitiesSkylinesMods/TMPE)'s behaviour.
- The sample city is the maintainer's own city, with labels translated to English.
- Russian translation by [craftersmine](https://github.com/craftersmine).

Cities: Skylines is a trademark of Paradox Interactive. This project is not affiliated with Paradox Interactive or Colossal Order.

## License

[GNU Affero General Public License v3.0](LICENSE). You may use, change and share the code. If you run a modified version as a public website, you must publish your source code under the same license.
