# Skyline Atlas

A map viewer for **Cities: Skylines** [CSLMapView](https://steamcommunity.com/sharedfiles/filedetails/?id=845665815) exports (`.cslmap` / `.cslmap.gz`), styled to look like Google Maps.

```bash
npm install
npm run dev        # http://localhost:5173
```

The dev server lists the exports in your CSLMapView folder on the start screen. It looks in
`~/Library/Application Support/Steam/steamapps/common/Cities_Skylines/CSLMapView` by default; to use another folder, set `CSLMAP_DIR=/path npm run dev`.
You can also drag a file onto the window or pick one with the file browser. Both work in a static build (`npm run build` → `dist/`).

## Features

- WebGL vector rendering with MapLibre GL: smooth zoom, rotation (right-drag) and tilt
- Roads drawn at their real width at high zoom, with casings and clean junctions. Highways, arterials, local streets, paths, bridges and tunnels each have their own style
- Zoned lots tinted by use, with smaller buildings drawn inside each lot. Buildings extrude in 3D when the camera tilts
- Water, forests, built-up areas and airport grounds traced from the game's heightmap and density grids, then smoothed
- Hillshading and optional 3D terrain from the heightmap. Terrain mode adds elevation tints and contour lines
- Transit overlay: each line in its own colour, with parallel lines offset side by side, plus station and bus-stop markers
- Labels for districts, parks, roads (merged along whole streets), points of interest and stations, with collision handling. Stations and buildings use the names you gave them in game (the export's `myname` attribute); a station you didn't name shows only its icon
- District areas, shown (highlighted with stats) when you select a district. The export has no district shapes and only public-transport nodes carry a real district id, so areas are rebuilt from those samples plus each district's label point on the game's 33.75 m district grid, clipped to land (`npm run check:districts`: 92–100% of hidden samples land in the right district)
- Line panels list stops in order using your station names; road panels show speed limit, lanes and bike lanes; a Cycling overlay shows bike routes
- Directions like Google Maps: driving, transit, walking and cycling, with alternatives, turn-by-turn steps, transit itineraries using your line and station names, draggable start/end pins, and a right-click "Directions from/to here" menu. Routing runs in the worker on the game's road network and lines. Driving obeys one-way streets and charges time for crossroads and turns (right < left < U-turn). Transit ride times come from the real road/track speed limits, capped at realistic vehicle speeds, with acceleration, braking, dwell at stops, and junction and traffic delays for buses; waiting times are labelled estimates (no timetable in the export); turn bans, traffic lights and TM:PE rules are not in the export
- Measure tool (ruler button or right-click → Measure distance), like Google Earth's: click to add points, drag to adjust, click the first point to close a shape for area and perimeter, metric/imperial, plus an elevation profile with total climb from the heightmap. Backspace undoes, Esc closes
- Toll booths: markers with an info panel (the road it sits on, roads it connects), "This route has tolls" on driving routes and a toll step where the gate is passed, plus an Avoid tolls option. A route counts as tolled only when it drives through a booth's gate segment, never just for using a highway. Fees aren't in the export; add them under City pricing
- City pricing (menu → Tolls, fares & currency): your own currency, toll fees (per booth or a city default) and transit fares (per mode or per line: base fare plus distance surcharges, charged on the distance actually ridden). Transfers can pay every ride, one ticket per journey, or a distance-integrated fare, with a time window and transfer limit. Directions show toll totals, per-booth fees and a fare breakdown. Prices live in IndexedDB per city, never in the map file; entries are re-matched to booths/lines by id, name and position, so they survive newer exports, and unmatched ones are kept. Export/import as JSON.
- Phones get a Google Maps-style layout: draggable bottom sheets (peek / half / full, flick to snap) for places, directions results and pricing; directions inputs in a top card; layers and tools as round buttons under the search bar; a directions button bottom-right; the compass only when the map is turned or tilted.
- English and Korean UI (menu → Language, or on the welcome screen; defaults to the browser language). Turn-by-turn directions are written in the chosen language, with Korean particles fitted to road names (서빛로로 우회전, 중앙역으로…).
- Transit map (chip or menu → Transit map): an automatic schematic diagram in the style of the Seoul / London maps, generated from the real network. Station order, interchanges, shared tracks, branches, loops, line names and colours are kept; lines are rearranged onto horizontal, vertical and 45° runs with even station spacing. Stations that are one place on the ground (within 120 m, or 260 m with matching names like 노리사역 / 노리사선착장) sit side by side with a walking-transfer link. Filter by mode (ferries, buses… remembered), tap a line to highlight it, tap a station for its lines and "From here / To here" to plan a journey on the diagram; routes from Directions can be shown on it too.
- Search, an info panel for any feature you click, a list of transit lines, Default / Terrain / Night styles, PNG export, and shareable URLs (`?map=…#zoom/lat/lng`)

## Layout

| File | Role |
|---|---|
| `src/parse.ts` | Fast regex reader for the export XML |
| `src/build.ts` | Classification, lots/buildings, transit, labels, landcover (runs in a Web Worker) |
| `src/geo.ts` | Projection, marching squares, smoothing, line merging |
| `src/access.ts` | Who may walk, drive or cycle on each network type, from its lanes plus documented exceptions |
| `src/oneway.ts` | Recovers one-way driving directions the export leaves ambiguous (junction rules + transit routes + keep-right rule) |
| `src/transit-time.ts` | Transit travel-time model (operating speeds, acceleration, stops, junctions, estimated waits) |
| `src/measure.ts` | Measure tool (distance, area, elevation profile) |
| `src/tolls.ts` | Toll booths ↔ their gate/approach segments ↔ the roads they sit on |
| `src/context.ts` | City pricing data: currency format, fare/transfer/toll maths, entity matching, import validation, IndexedDB |
| `src/context-ui.ts` | Pricing store for the open city and the pricing editor sheet |
| `src/sheet.ts` | Draggable bottom sheet used on phones |
| `src/schematic.ts` | Schematic layout: topology, octilinear grid routing (A*), compaction, line order, offsets |
| `src/schematic-render.ts` | Schematic SVG, label placement, best-of-several layout search |
| `src/schematic-view.ts` | Transit map screen: pan/zoom, filters, selection, journeys |
| `src/i18n.ts`, `src/i18n-ko.ts` | `t()` translation helper, Korean particles, Korean strings |
| `src/router.ts` | Directions engine: road/path/transit graphs, Dijkstra, turn instructions (runs in the worker) |
| `src/directions.ts` | Directions panel, route drawing and pins |
| `src/dem.ts` | Serves the heightmap as raster-dem tiles through a custom protocol |
| `src/style.ts` | Cartographic style (palettes, widths per zoom, label rules) |
| `src/icons.ts` | POI and transit pictograms drawn on canvas |
| `src/main.ts` | UI: loading, search, selection, layer switching |

Game coordinates (metres, x = east, z = north) are projected onto Web Mercator at the equator, where one game metre is exactly one metre of map scale. Scale bars, road widths and building heights therefore stay physically correct.

`npm run check` runs the geometry, transit-time and pricing self-checks. `npm run check:i18n` fails if any UI string lacks a Korean translation. `npm run check:schematic` lays out every city's transit map (add `--bus` for bus networks), checks station order, octilinearity, spacing and labels, and writes SVGs to `.schem/` for review. `npm run check:tolls` validates booth detection and toll flags/avoidance on random trips. `npm run check:transit` checks transit speeds per mode (scaled by stop spacing), bus-vs-car times and door-to-door ratios against real-world ranges. `npm run check:districts` scores district reconstruction on hidden transit nodes. `npm run check:access` prints the walk/drive/bike table for every network type in your exports and asserts known cases. `npm run check:route-geometry` checks that walking routes follow the exported paths (see below). `npm run check:groups` checks multi-part assets and the `og` flag (see below). `npm run check:oneway` scores one-way direction recovery against the transit routes in each export (held-out accuracy, currently 97–100%).

### Access rules
Directions use each network type's lanes as the source of truth: walking needs a pedestrian lane, driving a general car lane, cycling a bike lane or an ordinary road (bikes are pushed on footpaths). Exceptions where lanes mislead: station platforms and airport/ship aprons carry boarding lanes but aren't public paths; highways (incl. outside connections) aren't for pedestrians; busways and bus-station roads have only public-transport lanes; pedestrian zones carry car lanes for service vehicles only; racetracks are private.

### Where routes join the network
Walking, cycling and transit routes join the network at the nearest point on a usable path (not the nearest junction) and follow that path's real geometry from there, like Google Maps. That applies to the start, the end and every transit stop, so the dotted line never cuts straight across a block to a junction. Only paths nearly as close as the nearest one are joined; reaching a farther one costs double, so stepping across open ground is never cheaper than walking round. A path on a separate, unconnected walking network is never joined instead: the export has areas reachable only by highway (no walkable link exists, in the game either), and walking there is reported as impossible rather than drawn across. Driving joins roads the same way: the trip starts and ends part-way along the nearest road a car may use, and from there may only head the ways that road allows (a confident one-way only forward), so it drives round the block instead of cutting across to a junction. A trip can't begin or end part-way along a motorway, ramp or highway, so those are joined only when no other road is in reach. Nearby junctions are used only when the joined roads have no legal way on (or, with Avoid tolls, only lead through a gate). A trip in open country joins the nearest ordinary road up to 3 km away rather than a motorway carriageway.

One-way directions come in three strengths (see One-way directions below). **Confirmed** — vehicles were seen driving it, or junction rules lock it to such a segment — is never driven against: when no route respects it, Directions reports that no legal driving route exists. **Likely** (keep-right on divided roads, ~95% right) is obeyed as a rule; only if no route at all respects it may a route drive against it, and that route is never shown as ordinary: its card and details carry a warning and a warning step marks the spot. **Uncertain** (the raw lane value, 64–78% right) only adds a penalty. Investigating the last-resort routes on 2,100 random trips per run showed almost all came from trip ends far from roads snapping to a single junction on a motorway carriageway (reachable only the wrong way, or only from outside the map), not from wrong direction data; with ends joining the nearest ordinary road instead, one trip remained, in an area served only by motorways whose directions are confirmed, and it is now reported as having no legal route. `npm run check:route-geometry` plans random walking, transit and driving trips in every city and fails if any drawn piece leaves the exported segments, if a link to the network is longer than the way to the nearest usable road or path, or if a legal driving route runs against a confident one-way.

### Multi-part assets and grade separation
Assets made of several buildings (station halls and platforms, stadium stands, a mall's wings) are linked in the export as a chain: the main building's `subb` names the first part, each part's `prntb` the one before it. The chains run up to 24 deep, so every part is resolved back to its main building (`buildingGroups` in `src/build.ts`). Parts take the asset's name and one shared height, and clicking any part selects the whole asset. Parts with a borrowed type are handled by where they sit: overlays inside the main footprint (glass, balconies, roofs exported as "Airplane Facility") are left out, and pieces reaching outside it (platforms and stairs exported as props, mall wings) are drawn as the asset. Stops match the nearest footprint of a named station's whole asset, not just its main building's centre; a hall of another mode counts as slightly farther, so a metro stop under a train hall still goes to the metro station the player named. Walking, cycling and transit routes to or from an asset end at its nearest edge rather than its centre.

The node `og` (on ground) flag corrects bridges and tunnels: the game switches a road to its Elevated/Bridge/Tunnel/Slope variant whenever it leaves the ground, so a plain variant between two on-ground nodes is at grade, whatever the coarse heightmap says (it runs 20–45 m off on steep slopes). Exports without `og` keep the height test. `npm run check:groups` validates the chains, compares station matching and walking against the previous rules, and counts what `og` returns to grade: 1–29% of bridges and 11–75% of tunnels per city on the current exports, never adding any.

### One-way directions
The export marks one-way lanes as "Forward" relative to each segment but omits the game's per-segment invert flag, so the raw value is only 51–89% right. `src/oneway.ts` links segments through junction rules (a chain node has one way in and one way out; a merge/diverge has a matching pair and an opposite trunk — never contradicted in testing), then orients each linked group by transit routes (vehicles really drove it), else the keep-right rule on divided roads, else the raw value. Confident directions are hard rules and get arrows on the map; directions decided only by the raw value are a heavy routing penalty instead of a ban, so a wrong guess never strands a route.

Inspired by the format knowledge in the original CSLMapView web viewer; no code from it is used. Fonts: Pretendard (SIL OFL 1.1).
