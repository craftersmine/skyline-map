# Traffic rules from the save in routing: investigation

2026-11-09. **Status: phase 1 implemented and audited** (docs/research/routing-audit.md corrects several semantics described below: TM:PE option switches, restriction aggression, U-turn defaults); phase 2 open.
Test pair: 서랑시 export `서랑시-20261107-234707.cslmap` + save `!w_nweg_23%002E0%002E1.crp` (match
verdict). Measurements: scratchpad `simtest/rules.ts`. Nothing here is implemented yet.

## Answer

**No.** The router (`src/router.ts`) is built once from the export when the map opens (`worker.ts`, `load`). A
`.crp` is parsed later in the same worker (`loadSim`). Its results only go to the page for display, and
`Router` never sees them. Directions, reach, closures and transit times all use the export alone today:
- **driving speed:** the fastest car lane's prefab speed × 50 km/h, × 0.85 in town;
- **access:** from lane types;
- **one-way directions:** inferred (`oneway.ts`);
- **turns:** costed from geometry only.

## What the save can add, verified

| Rule | Source in the save | Verified how | This city |
|---|---|---|---|
| Exact one-way direction | lane direction (export) + `NetSegment.Flags.Invert` (save) + `m_invertTraffic` (save). This is the game's own rule, `PathFind.cs:779` and `NetInfo.cs:1103` | 283/284 transit-driven segments agree | 1,416 one-way segments. The inference gets **49 wrong**: raw lane value 32 of 254 (13%), keep-right 16 of 476, transit 1 of 686 |
| Lane speed limit | TM:PE `LaneSpeedLimit`, km/h. Placed through the save's lane chain only when its length equals the export's lane list | lane index → export lane gives the lane type and direction | 371 lanes on 107 segments, all car lanes. 299 faster, 72 slower than the prefab default; no road differs by direction |
| Prefab default speed | TM:PE `CustomDefaultSpeedLimits` | by prefab name | all 8 metro track types at **60 km/h** (export lane limit 150; the app caps metro at 90) |
| Vehicle restriction per lane | TM:PE `LaneAllowedVehicleTypes` (ANDed with the lane's own types by TM:PE) | placed 36/36 | 31 lanes bar private cars: 16 bus-only, 11 service/emergency only, 4 closed to all |
| Lane arrows | saved `NetLane` flags hold the effective arrows (game defaults, or TM:PE custom: 69 lanes) | not yet (see Phase 2) | 69 custom |
| Lane connections | TM:PE `LaneConnections` (source lane → target lane) | placed 53/53 | 53, all road |
| Junction restrictions | TM:PE `SegmentNodeConfs` | placed | U-turn explicitly allowed at 20 ends, never banned; pedestrian crossing banned at 30 ends |
| Priority signs | TM:PE | placed | 14 main, 13 yield, 1 stop |

**Effect on driving.** A prototype patched one-way directions and car speeds into a copy of the router. Across
400 random drives on this city:
- all 400 still find a route;
- 145 change path;
- 38 change travel time by more than 10%;
- the median time change is −1%, with p5 −17% and p95 +1.2% (most limits were raised).

## Traffic density is not speed

`m_trafficDensity` is the share of a segment's capacity used in the last simulation interval
(`RoadBaseAI.SimulationStep`: buffer × 100 / capacity, moved ±5 per step). The game uses it only to colour
the traffic view and for noise. Nothing maps it to vehicle speed, so it must not change travel times.
Acceptable, clearly labelled uses:
- **Informational:** "Passes busy roads", using the share of the route's length at a density the game paints
  red. Shown next to the route; the ETA is unchanged.
- **Optional preference, off by default:** "Prefer less busy roads". It penalises high-density segments as a
  user choice, never presented as a time estimate.

## Integration design

Rules flow only through matched segments. Unmatched ones keep today's export-based behaviour, so a "near"
save mixes cleanly.

1. **Worker, after a successful `loadSim`:** build a `SimRules` object for matched segments, then call
   `router.applyRules(rules)`. Removing the save, or opening another map, calls `router.clearRules()`. The page sends
   `simClear` on "Remove simulation data". Closures and reach share the router, so they follow automatically.
2. **Edge changes in `router.ts`, small and additive:**
   - `speedF` / `speedB` (m/s), so `driveCost(e, fwd)` reads the direction-specific limit. The town factor stays,
     because it is a modelling assumption already documented, not save data.
   - `driveF` / `driveB` access, so `driveOk(e, fwd)` also checks that some car lane allows PassengerCar in that direction.
   - Exact one-ways: `ow` from the save, `sure = confirmed = true` (never driven against).
   - `uturnBan` per segment end. The directed Dijkstra already tracks the incoming edge, so this is
     one check in the transition, and only for explicit `false`.
3. **Transit times:** `pieces()` takes the override for the piece's vehicle type. That covers the lane limits
   (car lanes also carry buses) and the prefab defaults (the metro 60 km/h).
4. **Page:** Directions shows "Using traffic rules from your save" while rules are applied, with a one-tap
   toggle to compare without them. Road panel rows already show the limits.
5. **Checks:**
   - extend `check:sim`: with rules applied, every one-way edge equals the save's exact direction;
   - a route stays legal under every TM:PE restriction it crosses;
   - routes without a save are unchanged (same paths and times as today).

## Phase 2: turn restrictions from arrows and connections

Edge-level rule: a turn into an outgoing segment is allowed if any car lane arriving there allows it. A
lane allows a turn through its connections when it has TM:PE connections; otherwise through its arrows.

To apply arrows we need TM:PE's left/forward/right classification of each outgoing segment at a node.

- **Ported from:** TM:PE's segment-end geometry code (decompiled at `scratchpad/decomp/tmpe`).
- **Validated against:** the game's own default arrows, which are in the saved `NetLane` flags of every
  lane TM:PE didn't customise. The port should reproduce those before the 69 custom ones are trusted.
- **Only when TM:PE is present.** The vanilla pathfinder doesn't enforce arrows.

## Open points

- **Left-hand traffic** (`m_invertTraffic`) is read but not yet kept by `openSaveData`; this city is right-hand.
  Left-hand cities need a test save before the exact one-way rule is enabled for them.
- **TM:PE default for U-turns** depends on its options blob (`TMPE_Options`, not decoded). Only explicit
  per-end settings are used.
- **Six Metro Overhaul slope segments** have 4 saved lanes against 3 exported. Lane rules are skipped there,
  which is already enforced.
- **One transit-driven segment** disagrees with the exact direction (283/284). Worth a look before
  treating exact directions as ground truth in `check:oneway`.
- **Priority signs** carry no timing data, so they would only appear in turn-by-turn text, not in costs.
