# Can the `.crp` save replace the `.cslmap` export?

Exploratory study, 2026-11-09. No application code was changed. Test subject: 서랑시, save
`!w_nweg_23%002E0%002E1.crp` (format 121034) against the export written at the same moment,
`서랑시-20261107-234707.cslmap` (exporter FileVersion 4.1).

## Verdict

1. **No. A `.crp` file alone cannot replace `.cslmap` without losing functionality.** 14 of the 51 export
   fields the app uses are defined by *prefabs* (NetInfo, BuildingInfo, ItemClass, lane definitions), not by
   the save. Those 14 drive road classification, map styling, routing (lane direction, speed, access),
   building categories and 3D heights, and which segments and buildings exist at all.
2. **What blocks 100%:**
   - prefab metadata (all of it)
   - the export timestamp (`DateTime.Now` at export; the save holds its own timestamp instead)
   - game-locale strings for auto-generated names and default line colours
   - about 1,000 terrain and water cells reshaped at runtime by quay and canal prefabs
3. **How much can be reproduced reliably:**
   - **Field level, save only, exact:** 28 of 51 fields (55%).
   - **With small fixed vanilla tables and locale data:** about 36 of 51 (70%). That counts the near-exact terrain and water fields, the generated names, line type and default colour.
   - **Prefab-dependent:** the remaining 14 (27%).
   - **Value level:** almost all geometry and topology reproduces bit-exactly (see "Evidence" below).
4. **Closing the gaps:**
   - **Workshop prefabs:** closable. The data is in the user's local workshop `.crp` asset files, which needs a port of the game's package deserializer.
   - **Vanilla prefabs:** closable. Either parse Unity asset bundles from the game install, or ship a derived table; the second has legal questions.
   - **Mod-generated prefabs (Network Extensions 2, Metro Overhaul, Elevated Train Station Track, …):** these exist only in memory while the game runs. No file holds them. That gap is fundamental for save-only input.
   - **Export timestamp:** unrecoverable, but the save timestamp is a reasonable substitute.
5. **As the primary input:** practical only as a hybrid. The save supplies every instance (what is where, connected how, named what). A *prefab dictionary* supplies what each prefab is. A save-only mode with heuristic fallbacks would visibly degrade routing and styling for any modded city.
6. **Recommended architecture:** see the last section. In short:
   - split `CityData` into an instance layer and a prefab layer;
   - add a `.crp` reader in the worker;
   - resolve prefabs through a chain: cached dictionary from past exports, a tiny in-game dictionary dump, local workshop assets, then a vanilla table, then heuristics flagged in the UI;
   - keep `.cslmap` as a first-class input.

## Method

- **Requirements:** taken from the code (audit of `src/` and `tools/`; the full table with file:line evidence is
  in the scratchpad `audit.md`). Two readers touch raw exports:
  - `src/parse.ts` reads everything;
  - `src/history.ts:28-41` (`scanExport`) has its own attribute-order-sensitive regexes for City Time Machine.
- **Provenance:** decompiled the exporter itself (`CSLMapViewMod.dll`, `MapInfoExporter.cs`, 435 lines). Every
  export field is one read of live game memory, so each field has a precise origin. Then traced each origin
  through the decompiled game (`Assembly-CSharp`, `ColossalManaged`) to decide whether it is:
  - serialized,
  - derived on load from serialized data, or
  - taken from a prefab.
- **Comparison:** wrote readers for the save's NetManager, BuildingManager, TerrainManager, WaterSimulation,
  NaturalResourceManager, InstanceManager, DistrictManager, TransportManager and PathManager sections, and
  the 81 Tiles mod blob `fakeDM`.
  - Each section reader must land exactly on the next section's tag; that check passed for all of them.
  - Then compared values entity by entity against the export, not just counts.

## Compatibility matrix

Legend:
- **D**: directly in the save.
- **R**: exactly reconstructable from saved data with cited game logic.
- **R+mod**: same, but needs mod data that is also in the save.
- **X-vanilla / X-workshop / X-runtime**: needs vanilla game assets, workshop asset files, or a prefab that a mod creates at runtime.
- **X-locale**: needs game localisation.
- **N**: not recoverable.

Criticality is from the audit: **B** = a feature breaks, **Dg** = degrades, **C** = cosmetic.

### City
| Field | Class | Result vs export | Crit |
|---|---|---|---|
| `name` | D (save metadata `cityName`) | equal | B (Time Machine, saved tolls) |
| `generated` | **N** (`DateTime.Now` at export); substitute = save `timeStamp` | export 23:47:05, save 23:47:11.75 | B for Time Machine semantics, but the substitute works |
| `seaLevel` | D (`m_currentSeaLevel`) | 31.0 = 31.0 | Dg (5 discoveries) |

### Nodes (14,321)
| Field | Class | Result | Crit |
|---|---|---|---|
| id set | D | 14,321 = 14,321, same ids | B |
| x, y, z | D | 14,321/14,321 bit-exact | B |
| `ug`, `og` | D (flags) | 14,321/14,321 | B / Dg |
| `srv` | **X** (NetInfo service). One value per prefab; 187 prefabs, 0 inconsistent | — | Dg (district seeding uses `PublicTransport`) |
| `dist` | R+mod: 81 Tiles' patched `SampleDistrict` on the 900² `fakeDM` grid, including the mod's `-225f` quirk; which nodes get it depends on `srv` (X) | 2,544/2,544. Vanilla 512 grid gives 395 wrong | Dg |
| `elev`, `subsrv` | unused by the app | — | — |

### Segments (9,894 exported of 14,402 in the save)
| Field | Class | Result | Crit |
|---|---|---|---|
| set (exporter drops Ship/Airplane Path, Water Pipe, Transport Connection *ItemClasses*) | **X** (ItemClass) | 4,508 dropped, all from 12 vanilla prefabs. Exporter regex on names misses 1,253 segments; a keyword rule wrongly drops 287. An explicit vanilla-name list gives 0/0 here but is vanilla ItemClass data in disguise | B |
| id, `sn`, `en` | D | 9,894/9,894 | B |
| `name` (prefab name) | D (prefab table) | 9,894/9,894 | B |
| `customName` | D (InstanceManager) | 947/947 | Dg |
| `pts` | R: node positions + `m_startDirection`/`m_endDirection` → `NetSegment.CalculateMiddlePoints` → Bezier at ¼, ½, ¾ | **33,699/33,699 points bit-exact**. Requires double-precision intermediates (old Mono float semantics) and Unity's approximate `==` for the straight test; strict float32 gives only 24,547 exact | B |
| `path` (`<Sg>`) | D (PathManager units via `m_path`, following `m_nextPathUnit`) | 590/590 lists identical (25,765 entries) | B (transit lines, transit routing, oneway inference) |
| `icls` | **X** (ItemClass) | one per prefab; 189 prefabs | B (classification, style, routing defaults, access) |
| `width` | **X** (`m_halfWidth`) | one per prefab | Dg |

### Segment types (189 prefabs)
| Field | Class | Result | Crit |
|---|---|---|---|
| key | D | 189 = 189 | B |
| `highway` | **X** (`RoadBaseAI.m_highwayRules`) | — | B |
| lanes `type`, `vType`, `dir`, `pos`, `width`, `speed` | **X** (`NetInfo.m_lanes`). The save's lane chain gives *count* only (9,888/9,894); lane flags hold arrows/stops, not type, direction or speed | — | B (routing, oneway, access, speeds) |

### Buildings (9,652 exported of 11,593 created)
| Field | Class | Result | Crit |
|---|---|---|---|
| set (exporter drops pipe/wire/road/track/path ItemClasses + `Cable Car Pylon`) | **X** (ItemClass) | 1,941 dropped, 32 prefabs. Name regexes get 2,140 wrong (e.g. `Dam Node Building` ×1,935 is *kept*; metro pillars kept, rail pillars dropped). No save-side signal separates them | B |
| id | D | 9,652/9,652 found | B |
| `pts` (4 corners from `m_position`, `m_angle`, `m_width`, `m_length` × 8 m) | R (exporter formula) | **38,608/38,608 coordinates bit-exact** | B |
| `name` | D | 0 mismatches | B |
| `myname` | D (CustomName flag + InstanceManager) | 78/78 | Dg |
| `parent` (`prntb`) | R (not saved; the game sets `parent[sub]` on load, `BuildingManager.cs:2794`) | 324/324 | B (asset grouping) |
| `srv`, `subsrv`, `icls` | **X** (BuildingInfo / ItemClass). One class per prefab; 1,483 prefabs, 972 of them workshop | — | B (categories, 3D height, station mode, tolls) |

### Districts and parks (38 districts, 8 parks)
| Field | Class | Result | Crit |
|---|---|---|---|
| ids, park `type` | D | equal | B / C |
| custom names | D | 34/34 districts, 6/6 parks | Dg |
| generated names | X-locale (seed is saved; name lists are game localisation) | 4 districts, 2 parks | C |
| label `x`,`z` (`m_nameLocation`, not saved) | R+mod: 81 Tiles' own label routine on the `fakeDM` grid, computed in double precision | **38/38 and 8/8 bit-exact**. The vanilla routine is off by a mean of 3.4 km | Dg |

### Transit lines (37)
| Field | Class | Result | Crit |
|---|---|---|---|
| id, filter | D | 37 = 37 | B |
| custom name | D | 32/32 | Dg |
| generated name | X-locale (`lineNumber` saved; pattern from locale) | 5 lines, all consistent | C |
| `type` | X-vanilla in principle; a fixed vanilla TransportInfo→type table gives 37/37 | 37/37 | B |
| custom colour | D | 25/25 | C |
| default colour | X-vanilla (constant per transport type) | 12 lines; 5 constants | C |
| `stops` | R (walk `m_stops` → each stop's outgoing segment) | **37/37 identical lists**, 438 stops | B |

### Terrain and land cover
| Field | Class | Result | Crit |
|---|---|---|---|
| `height` (`RawHeights2`) | D except under quays. `RawHeights2 = rawHeights` except where `QuayAI` writes it (`TerrainModify.cs:916-924`), which needs X | 1,168,037/1,168,561 exact (99.955%). All 524 misses within 56 m of 81 quay segments, max 94.8 m | B (DEM, hillshade, bridge test) |
| `water` | D for depth < 1 m. Deeper cells use `BlockHeights`, rebuilt on load by network/building terrain modification (X) | Shallow: 0 mismatches. Deep: 500/121,102 wrong (0.41%), around canals, quays and beautification items | Dg |
| `terrainSize`, `forest`, `forestSize` | D | forest 262,144/262,144 exact, same orientation | C |

### Tally (51 used fields)
- **Save-only, exact (D/R/R+mod): 28.**
  - city name, seaLevel
  - node id, xyz, ug, og
  - segment id, sn/en, name, customName, pts, path
  - segType key
  - building id, name, myname, parent, pts
  - district id and label
  - park id, label and type
  - line id and stops
  - terrainSize, forest, forestSize
- **Gated:** 1. Node `dist` is exact, but which nodes receive it depends on `srv`.
- **Near-exact, or only tiny fixed tables or locale needed: 7.**
  - height and water (≥99.5% of cells)
  - district, park and line generated names
  - line type
  - default line colour
- **Prefab-dependent: 14.**
  - node srv
  - segment set, icls, width
  - highway
  - lane type, vType, dir, pos/width, speed
  - building set, srv, subsrv, icls
- **Not recoverable: 1** (export timestamp; the substitute works).

## Mods

**Not affected.** These mods do not change what the export reads, so they don't affect parity:
- **Node Controller, Network Skins, Procedural Objects, Surface Painter, Painter, Adaptive Roads' per-instance data.** CSLMapView reads only vanilla fields, so their effects are invisible in today's export too. Their data does sit in the save as mod blobs:
  - Procedural Objects: 4.2 MB, .NET BinaryFormatter
  - Node Controller: gzip XML
  - Adaptive Roads: 868 KB
- **Move It, Network Anarchy and similar.** They edit vanilla fields (positions, directions, flags), which are saved and reproduced exactly.
- **TM:PE.** Not used by the export. Its blob decodes fully (3,002,915/3,002,915 bytes) into speed limits, lane arrows, lane connections, priority signs and junction rules. A save reader could *exceed* the export here, for example real per-lane speed limits.

**Needed, and recoverable for this city:**
- **81 Tiles (EightyOne2).** It changes district sampling and label placement. Its 900² grid is in the save (`fakeDM`, version 4) and its algorithms were reproduced bit-exactly, including two quirks: `-225f` and float division on z.
- For arbitrary users this means mod-version-specific code. The original EightyOne, older EightyOne2 versions, and other area mods may use other formats. **Unknown** until tested.

**Blocking for save-only input:**
- **Network Extensions 2, Metro Overhaul, Elevated/Single Train Track** and similar mods build NetInfo prefabs in code at load time. Of the 201 network prefabs in this city:
  - 16 are workshop assets;
  - 149 were found in vanilla game data;
  - 36 were not found in any game file, covering **918 exported segments**. Most of these are confirmed in mod DLLs (`Highway2L2W`, `AsymHighwayL1R2`, `Oneway3L`, `Rail1L`, `* NoBar` metro tracks); the rest are unknown.
- Their width, class and lanes exist only at runtime. They can come only from the running game (an export or a dump) or from per-mod, per-version tables.

**Risk to parsing itself (arbitrary cities):** mods that resize vanilla buffers or move data into their own blobs would break a parser that assumes default sizes. Examples are tree-limit mods and vehicle/citizen-limit mods. This city uses default sizes everywhere checked. **Unknown** for other mod sets.

## Practical feasibility

- **Parsing in the browser:** feasible.
  - The needed sections are a 45 MB input that can be read straight from an `ArrayBuffer`.
  - The Python prototypes parse all needed sections in seconds; a JS port in the existing worker should be in the same range.
  - Memory is lower than the XML route, because there is no 20 MB string or regex pass.
  - Sections can be located by their begin tags, so unneeded ones (citizens, vehicles) are skipped.
- **File size:** saves are 2× the export (45 vs 20 MB), but carry far more data.
- **Game versions:**
  - Cities: Skylines 1 is no longer updated, so the format is stable at 121034.
  - The prototypes only mirror the current write path. Older saves would need the `s.version` branches from each `Deserialize` method. **Unknown** effort; not tested.
- **External assets:**
  - **Workshop:** feasible but heavy. The browser can read the user's workshop folder via a directory picker (Chromium only), opening only the needed files. That needs a full port of `PackageDeserializer` and the game's custom serializers.
  - **Vanilla:** needs a Unity 5.6 asset parser over about 13 GB of game data, or a shipped table.
  - **Mod-generated:** no file source exists.
- **Maintenance:** the save format is stable, but every supported mod (area mods, network-pack mods) becomes our responsibility. This is the dominant long-term cost.
- **Legal (not legal advice):**
  - Reimplementing a file format for interoperability is the usual safe ground.
  - Shipping decompiled game code verbatim is not. Port the algorithms, don't paste them.
  - Shipping game assets is not. A table of vanilla prefab properties extracted from Colossal's assets is grey and needs a decision.
  - Reading the user's own local files on their machine is the least problematic option.
  - Today's approach avoids all of this, because CSLMapView runs inside the user's own game.

## Prioritized blockers

1. **Network prefab metadata** (`icls`, `width`, `highway`, lanes): breaks classification, styling, routing, oneway and access.
2. **Building prefab metadata** (`srv`, `subsrv`, `icls`): breaks categories, 3D heights, station mode and tolls.
3. **Segment and building inclusion sets.** These are ItemClass-defined; name rules are measurably wrong (1,253 segments, 2,140 buildings).
4. **Mod-generated prefabs** (36 network prefabs, 918 segments here). No file source.
5. **Vanilla prefab source.** Unity asset parsing, or the legal decision on a shipped table.
6. **Mod variance across users**: area mods, buffer-size mods, other network packs. Untested.
7. **Older save versions.** Untested.
8. **Quay and canal terrain modification**: 524 height and 500 deep-water cells.
9. **Locale strings** for generated names and default line colours. Small.
10. **Export timestamp.** Substitute with the save timestamp; also update `history.ts`, which reads raw XML.
11. **Unexplained:** 6 Metro Overhaul slope segments have 4 saved lanes against 3 exported.

## Recommended architecture (for later; nothing built)

1. **Split the model.** Keep `CityData` as the app contract, but build it from two layers:
   - *instances*: nodes, segments, buildings, lines, terrain, names, districts;
   - a *prefab dictionary* keyed by prefab name: class, service, subservice, width, highway, lanes.
   The `.cslmap` reader fills both layers. A `.crp` reader fills the instance layer only.
2. **Prefab resolver chain, best first.** Every prefab the save references goes through:
   1. a dictionary harvested from any `.cslmap` the user has loaded before (stored in IndexedDB). Measured coverage here:
      - older exports of the same city: 100% of prefabs;
      - 12 exports of *other* cities with the same mod set: only 64% of network prefabs and 45% of building prefabs (87% of segments, 77% of buildings);
   2. an optional tiny in-game mod that dumps only the prefab dictionary (a few hundred KB, rarely re-run);
   3. local workshop assets via a directory picker;
   4. a vanilla table, if that is legally acceptable;
   5. heuristics, with unresolved prefabs flagged in the UI so degraded routing or styling is never silent.
3. **Save-only extras.** Live traffic density, commutes, ridership, vehicles, heatmaps and TM:PE rules come from the save and need no prefabs. They can light up whenever a `.crp` is present, even next to a `.cslmap`.
4. **Keep `.cslmap` first-class.** It remains the only zero-setup source of complete prefab data for modded cities.
5. **Before any build:**
   - test the readers on several other saves (vanilla city, no 81 Tiles, different area mod, old version);
   - settle the vanilla-table legal question;
   - port the parsers to TS behind the same worker messages.

## Side findings (existing app)

- **Phantom deep water.** 251 water values in this export are ≥ 32768. These are canal beds where the 16-bit subtraction wrapped. `parse.ts` divides by 64, so the app shows about 1,016 m of water there today.
- **Dangling transit path references.** 10,998 of 25,765 `<Sg>` entries point at segments the export itself dropped (pedestrian connections etc.). The app cannot resolve them; already the case today.

## Evidence files (scratchpad)

- **Location:** `/private/tmp/claude-501/-Users-hjun1052-Documents-Codes-NormalProjects-cslimap/c5f81f01-f878-4ad8-8e93-e94f3a4911da/scratchpad/save/`.
- **Comparisons:** `audit.md`, `cmp_terrain.md`, `cmp_network.md`, `cmp_places.md`, plus their `.py`/`.json`.
- **Prefab-cache coverage test:** `prefabcache.py`.
- **Parsers:** `p_*.py`, `cs.py`.
- **Decompiled sources:** the `decomp/` folder next to it. It is not to be redistributed.
