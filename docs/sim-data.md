# Simulation data from a game save (.crp)

Skyline Map can read a Cities: Skylines save on top of an open CSLMapView map. The save adds live traffic,
building occupancy, transit ridership, city statistics, TM:PE rules and simulation grids. It is optional:
every existing feature works without it, and the map itself always comes from the `.cslmap` export.
The research behind this is in [research/crp-vs-cslmap.md](research/crp-vs-cslmap.md).

## How it works

1. **Load.** The user opens a map, then *Menu → Simulation data (.crp)* and picks a save.
2. **Read.** The worker reads the save (`src/sim/index.ts`):
   - the CRP package header;
   - the MD5 checksum the game stored for the data block (`src/sim/md5.ts`);
   - the save format, which must be 118011 or 121034;
   - the sections it needs (network, buildings, citizens, transport, districts/economy, resource grids, TM:PE blob).
3. **Check.** The worker compares the save with the open map object by object (`src/sim/validate.ts`) and returns a verdict.
4. **Hand over.** Only values for individually matched objects go to the page, plus save-wide statistics labelled "whole city".
   `src/sim-ui.ts` draws the card, the map layers and the info-panel rows.

Everything runs locally in the existing Web Worker; nothing is uploaded. A 45 MB save loads in about 0.3–0.6 s.
The checksum alone takes about 0.12 s.

## Compatibility check

Files are never matched by name, path or file dates; only their contents count. An object counts as
matched only when everything below agrees bit for bit (float32). The export's geometry is recomputed from
the save exactly as CSLMapView computes it.

| Object | Matched when |
|---|---|
| Node | id exists and is created in the save; position equals the export's |
| Road / rail segment | same prefab name, same start/end nodes (both matched), and the curve recomputed from the save's node positions and directions (`NetSegment.CalculateMiddlePoints` port) equals the export's points |
| Building | same prefab name, and the footprint recomputed from position, angle, width and length equals the export's corners |
| Transit line | created; first stop equals the export's first stop; every hop between consecutive stops is a matched segment |

Identical ids alone are never trusted. A reused id with another prefab or place shows up as changed or replaced, never as a match.

### Calibration

Thresholds come from 179 real save/export pairs on the author's machine (`tools/sim-check.ts` covers the key ones):
- **Same-moment pairs:** CSLMapView's *Auto export on saving game* writes an export 1–6 s before the save,
  so those pairs show the same moment.
- **Different moments:** same-city pairs with an export from one save and the save from another.
- **Other cities:** cross-city pairs.

"Worst share" is the lowest of the node, segment and building matched shares. "Save-only" is the share of
save nodes the map doesn't have. The export lists every created node, so this side is exact.

| Pairs | n | Worst share | Save-only (max) | Verdict |
|---|---|---|---|---|
| Same moment (auto-export), formats 118011 + 121034 | 38 | 1.0000 every time | 0 | match 38 |
| Export one save older than the save | 27 | 0.952 – 1.0 | 0.036 | near 26, match 1 (nothing changed in between) |
| Export two saves older | 26 | 0.941 – 0.994 | 0.049 | near 26 |
| Export four saves older | 12 | 0.952 – 0.982 | 0.077 | near 12 |
| Export eight saves older | 5 | 0.940 – 0.953 | 0.136 | near 4, incompatible 1 |
| Export sixteen saves older (months) | 2 | 0.925 – 0.945 | 0.183 | incompatible 2 |
| Export one save newer than the save | 27 | 0.929 – 1.0 | 0.004 | near 26, match 1 |
| Export two saves newer | 26 | 0.901 – 0.982 | 0.005 | near 26 |
| Export four saves newer | 12 | 0.854 – 0.946 | 0.007 | near 8, incompatible 4 |
| Export eight or sixteen saves newer | 7 | 0.736 – 0.893 | 0.018 | incompatible 7 |
| Different cities | 12 | 0 exactly | 0.56 – 0.96 | incompatible 12 |

Rules (`judge` in `validate.ts`):
- **Match:** worst share ≥ 0.999 and save-only ≤ 0.001.
  Every same-moment pair scored exactly 1; the closest other pair scored 0.9975.
- **Near:** worst share ≥ 0.9 and save-only ≤ 0.1. Accepted; values attach only to matched objects, and the
  card says how many roads and buildings matched. This takes in every pair one or two saves apart.
- **Different city:** node share < 0.5. Other cities scored exactly 0; same-city pairs never fell below 0.83 on nodes.
- **Too far apart in time:** everything else.

The direction (older map or older save) is not claimed. In the data both directions leave objects on
both sides, so it can't be told reliably.

## What is shown, and where it comes from

Every value mirrors the game field, and the game code, that the game's own UI uses. Missing data is never shown as 0.

| Where | Value | Source | Window |
|---|---|---|---|
| Road panel, Traffic layer | Traffic % | `NetSegment.m_trafficDensity` (the game's traffic view colours by it) | current |
| Road panel | Speed limit (TM:PE) | TM:PE `LaneSpeedLimit` (km/h), placed through the save's own lane chain; only when the chain length equals the export's lane list | as set |
| Road panel | Default speed for this road type (TM:PE) | TM:PE `CustomDefaultSpeedLimits` | as set |
| Road panel | Parking | TM:PE `ParkingRestrictions` | as set |
| Building panel | Residents, Households x / y, Workers now, Students, Visitors now | the building's citizen units, counted as the game's info panels count them (present = not dead, not moving in); a row is left out when the building has no units of that kind | current |
| Building panel | Happiness | `Building.m_happiness` | last simulation pass |
| Line panel, ridership list | Passengers per week (residents · tourists) | `TransportLine.m_passengers.*.m_averageCount`, which is what the game's line panel shows | the game's smoothed weekly average |
| Line panel | Last full week | `m_finalCount` | last completed 4096-frame period |
| Line panel | Car trips saved | the line panel's own formula (ordinary lines only) | weekly average |
| Card, "Whole city, from the save" | Population, workers, jobs, unemployment, tourists, happiness, crime rate, average land value, ground pollution, education shares, tax rates | district 0 and EconomyManager, read as the population, education, tourism, crime, land value, pollution and economy views read them | last district update |
| Land value, Noise, Crime layers | per-cell values | `ImmaterialResourceManager.m_localFinalResources`: 256 × 38.4 m cells over the central 25 tiles only. Outside them the game keeps nothing, so nothing is drawn; a dashed outline marks the area | current |
| Ground pollution layer | per-cell values | `NaturalResourceManager` resource cells `m_pollution`, over the whole map | current |

Grid orientation is checked in `check:sim`: noise on building cells is about 6× the noise on the same
cells mirrored north–south.

## Routing with the save's traffic rules

A matched save also changes how Directions, "How far can I get?" and "What if it closes?" route. Rules apply to
matched segments only (`src/sim/rules.ts`, `Router.applyRules`). A TM:PE rule applies only while the save's TM:PE
options have that feature switched on (`TMPE_Options`, `readTmpeOptions`). If the options are missing or unknown,
no TM:PE rule is used.

| Rule | From (game code) | Effect in the router |
|---|---|---|
| Exact one-way direction | export lane direction + the save's segment `Invert` flag (`PathFind.cs:779`, `NetInfo.cs:1103`) | replaces the inferred direction; never driven against |
| TM:PE speed limit | per lane, else TM:PE's road-type default, else the prefab limit (`SpeedLimitManager`), on lanes TM:PE can customise | fastest car-lane limit per direction (the router's 85% town factor stays) |
| TM:PE vehicle restriction | a direction whose every car lane bars passenger cars (`CustomPathFind.CanUseLane`) | Strict aggression: banned. Low/Medium/High: TM:PE's own cost factor ×10/×100/×1000 while searching, never in the shown time |
| U-turns | TM:PE junction restrictions on: explicit setting, else TM:PE's default (dead ends and one-way-out nodes; junctions only with "allow U-turns"). Off: only dead ends / one-way-out nodes | U-turn back along the segment forbidden where the game forbids it |
| Lane arrows and lane connections (TM:PE) | at a junction, a car arriving on road A may continue onto road B only if one of A's car lanes arriving there allows it: through its TM:PE lane connections if it has any, else through its final arrows (TM:PE custom, else the game's own in `NetLane.m_flags`), with TM:PE's left/forward/right classification ported from `CalculateArrowDirection` (`RoutingManager.RecalculateLaneEndRoutingData`) | that turn forbidden, except as a trip's first turn (TM:PE relaxes arrows on the start lane) |
| TM:PE limits on transit pieces | the same limits for the vehicle type riding the piece (e.g. metro tracks held to 60 km/h) | transit ride times |

**Not applied, with reasons:**
- **U-turns without TM:PE:** the vanilla rule also turns vehicles back where the other segments lack the road's
  vehicle categories. Those are prefab data the save doesn't hold, so U-turns stay as the router has them.
- **"No limit" (TM:PE unlimited):** vehicles then drive at their own top speed, which isn't in the save, so the
  export's limit stays.
- **Left-hand traffic:** one-way and per-direction rules are skipped until a left-hand save has been tested.
- **Lane arrows: only what holds for the whole road.** A turn is ruled out only when no arriving car lane allows it.
  Sequences that need a particular lane (connected into a lane that can't make the next turn) are not modelled; see
  docs/research/routing-audit.md, section 6.
- **Arrow turns left undecided:** turns sharper than 90° (live game paths contradict the reading of TM:PE there),
  toll-booth nodes, untouchable and beautification nodes, connections onto lanes that can't be placed, and saves with
  TM:PE's highway rules on (they rewrite arrows on highways at run time).
- **Priority signs, timed lights, turn-on-red:** they carry no timing data in the save.

**Toggle:** Directions shows a "Traffic rules from my save" switch while rules are loaded. Switching it off, or
removing the save, gives exactly the export-only routes; reach and closures always use the rules while a save
is loaded.

**Effect in the test city** (TM:PE 11.9.4; speed limits, restrictions and junction restrictions on; U-turns off; aggression High):
- 1,416 exact one-ways;
- 98 roads with changed car limits;
- 6 roads restricted for cars;
- 7,206 segment ends where U-turns are forbidden;
- 6 turns ruled out by lane arrows or lane connections;
- 379 transit pieces;
- metro ride time +12%;
- one trip goes from 11 min via the toll expressway to 6 min on 서빛서랑대로.

**Checks (`check:sim`, section 3b):**
- no drive breaks a rule;
- the game's own routes agree: of 3,704 citizen car trips stored in the save (239,076 turns), none makes a turn the
  arrows rule out, and none of their 87 mid-trip U-turns is at a segment end where U-turns are banned;
- turn bans never make a reachable trip unreachable;
- the option switches are honoured;
- reported times exclude penalties;
- "rules off" and cleared rules reproduce the export-only drive, reach and transit results byte for byte;
- traffic-aware routing (section 3c): off by default and byte-identical when off; never meaningfully faster than the best route without traffic; rules
  still obeyed; other modes untouched;
- rules touch matched segments only, also for partial matches.

## Traffic-aware routing (optional estimate)

Directions shows a "Traffic-aware routing" switch (교통 상황 반영) while a matched save is loaded. It is off by
default and independent of "Traffic rules from my save". It is one setting in the worker's router, so reach and
"What if it closes?" follow it too and say so.

- **Model:** each matched road's driving time × a multiplier for its `m_trafficDensity` at the moment of saving.
  The multiplier is 1.00 up to 5 %, 1.16 at 45 %, 1.56 at 55 %, 2.09 at 75 % and 3.57 at 95 % or more.
- **Where it comes from:** the curve is measured from 27,463 private cars in 19 saves of 4 cities, as speed against
  lane limit. The game itself has no density-to-speed rule; derivation, calibration and validation are in
  [research/traffic-model.md](research/traffic-model.md).
- **Search and shown time agree:** the route search minimises the traffic-adjusted time, and the card shows that
  time with "Traffic adds about N min to this route".
- **Rules still hold:** restriction penalties never count as time, and traffic never lifts a one-way, U-turn or
  lane-arrow ban.
- **Missing data:** unmatched roads keep their time without traffic, and the card says when less than 90 % of the
  route has traffic data.
- **Other modes:** walking, cycling and transit don't change.
- **Limits:**
  - density is per road, not per direction;
  - it is a single moment with up to about 2 in-game hours of lag;
  - the curve is a typical slowdown, not a live speed.

## Deliberately not shown

- **Age groups.** In the test city the district counts give 85 seniors while the raw citizen ages give
  about 21,000. A mod (probably Lifecycle Rebalance Revisited) changes the grouping. The city "Unemployment" figure
  uses those groups and is labelled "as the game shows it".
- **Cash and money.** The test city runs an unlimited-money mod, so the figures would mislead.
- **Work, student and visitor capacity.** The game takes these from the building prefab, which isn't in the save.
- **Road condition.** It is 0 everywhere unless road maintenance was ever used.
- **Vehicles, commutes, chirps and the statistics history.** They were decoded in the research but are not built into the UI yet.

## Supported and unsupported

- **Supported save formats:** 121034 (current game) and 118011 (the previous build). Both are tested on real
  same-moment pairs; 114 + 19 of the author's 143 saves use them. Anything else (for example 117013 from 2024)
  is refused with a message.
- **Mods:**
  - **81 Tiles:** the resource grids still cover only the central 25 tiles, because the mod doesn't extend them.
  - **TM:PE:** data is read when present (tested with TM:PE 11.9.4); otherwise the TM:PE rows are skipped.
  - **Buffer-resizing mods:** mods that change the game's buffer sizes make a section fail its alignment check. That
    section's data is then left out and named on the card; the rest still loads.
- **Known gaps in test coverage:**
  - saves from other players' machines and mod sets;
  - pedestrian-zone areas (in the parser but not exercised);
  - timed traffic lights in TM:PE (none in the test saves, so not decoded);
  - Windows file paths, which are only listed in the tip text.

## Checks

- `npm run check:sim` runs against your local Saves and CSLMapView folders and reports missing samples as skipped. It covers:
  - the matching pair;
  - the same bytes renamed, and gzipped;
  - grid alignment;
  - older and newer pairs, with a per-object attach guard;
  - a different city;
  - truncation;
  - random bytes;
  - corrupted bytes and a single flipped bit (both caught by the checksum);
  - a format 117013 save;
  - a workshop asset package;
  - a 118011 pair.
- `npm run check:i18n` covers every new string in Korean.
