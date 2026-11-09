# Routing audit after Phase 1

2026-11-09. Reference pair: 서랑시 export `서랑시-20261107-234707.cslmap` + save `!w_nweg_23%002E0%002E1.crp`.
Cross-checked on four more matched pairs: 서랑시 (March, format 118011), 라스 크루즈, Quda City and 스프링데일.
Scratch scripts are in `scratchpad/simtest` (`ow49.ts`, `ends.ts`, `kr.ts`, `phase2.ts`). Regression tests are in
`npm run check:sim`. Nothing in this audit is committed or deployed.

## 1. The 49 reversed one-way roads

The export-only inference (`src/oneway.ts`) works in two steps.
- **Junction rules** lock neighbouring one-way segments into groups.
- **Orientation:** each group is oriented by its strongest evidence: transit paths, then a keep-right vote,
  then the raw lane value.

Each part was measured against the save's exact directions:

| Part | 서랑시 Nov | 서랑시 Mar | 라스 크루즈 | Quda | 스프링데일 |
|---|---|---|---|---|---|
| Junction links correct | 1126/1126 | 1070/1070 | 1955/1955 | 655/655 | 65/65 |
| Keep-right votes correct | 189/205 | 184/194 | 995/1061 | 297/299 | 0/1 |
| Raw lane value correct | 67% | 65% | 66% | 63% | 93% |
| Transit evidence correct (before fix) | 283/284 | 267/268 | 160/160 | 67/67 | 55/55 |

**Root causes:**
1. **A bug: walking-tour paths counted as driving evidence.** Pedestrians walk one-way roads both ways. Segment
   21050 (Oneway Road) got its "transit" direction from 노리산 트래킹 투어, a walking tour. That marked it
   *confirmed*, so the router refused to drive it the legal way. Fixed in `oneway.ts`: routes of walking-tour
   lines are no longer evidence. Transit evidence is now 282/282 and 266/266, and correct in every city.
   This helps users without a save too.
   - **Regression test:** every transit-backed direction must agree with the save. It fails on the old code and passes now.
2. **No evidence in the export (the remaining 48).** Every wrong group is wrong in all its members, while the
   junction links inside it are right; only the group's orientation is wrong. Of the 34 open ends of wrong groups:
   - **23 meet a two-way road.** The export carries nothing about the direction there. The typical case is a
     ramp onto a Network Extensions 2 two-way highway (`Highway2L2W`).
   - **7 sit at a node where 4–5 one-ways meet.** No exact rule determines direction there.
   - **4 are three one-ways at a non-Y geometry.** These are just as ambiguous.

   Such groups fall back to keep-right (16 wrong, almost all highway ramps) or to the raw lane value (32 wrong).
   The export lacks the segment's `Invert` flag, which is what decides the direction.

   **Network types:** mostly `HighwayRamp` / `HighwayRampElevated` / `HighwayRamp Tunnel`, then a few `Oneway Road` and
   `One-Lane Oneway`. No single mod is the cause. NE2 two-way highways make ramps unanchored more often.

**No replacement heuristic was added:**
- **Keep-right on ramps** is 86.8% right (315/363 across 5 cities), against 60.8% for the raw lane value. It is
  the best signal the export has, so it stays.
- **Inverting the raw value for ramps** would only be another guess.

**Remaining limitation:** export-only users still get about 3% of one-way roads backwards (48 of 1,416 here).
- Keep-right directions are obeyed as rules, so a wrong one forces a detour.
- Raw-value directions are only penalised.

A matched save removes all of them.

## 2. TM:PE semantics: what was wrong and is now fixed

Each point was checked against the decompiled TM:PE 11.9.4.

| Finding | Before | Now |
|---|---|---|
| TM:PE applies each rule kind only while its feature is enabled. The switches live in the `TMPE_Options` blob (byte 20 speed limits, 21 vehicle restrictions, 24 junction restrictions, 13 allow U-turns, 35 restriction aggression; `OptionsManager.SaveData`) | applied regardless | options decoded; each rule kind applies only when enabled; missing or unknown options mean no TM:PE rule |
| Vehicle restrictions below Strict aggression are a path-cost factor (`PATHFIND_PENALTIES` ×10/×100/×1000), not a ban (`CustomPathFind`) | hard ban | ban only for Strict; otherwise TM:PE's factor during the search, excluded from the shown time. This save: High, ×1000 |
| Car lanes for restrictions and speed | any lane with a Car vehicle type, including bus lanes and parking | lanes private cars drive (`Vehicle` + `Car`), as `access.ts` already defines them; speed limits only on lanes TM:PE can customise (`SpeedLimitManager.LANE_TYPES/VEHICLE_TYPES`) |
| Transit piece limit with only some lanes overridden | took the max of the overridden lanes only, which could under-state the limit | max over all lanes of that vehicle type, using effective limits |
| U-turns | only an explicit "no U-turn" banned one | TM:PE's own rule: explicit setting, else its default (`JunctionRestrictionsManager.GetDefaultUturnAllowed`; this save has "allow U-turns" off, so 7,206 segment ends forbid it); with junction restrictions off, only dead ends / one-way-out nodes |
| Stale loads | a gzipped save that finished parsing after a newer load, a clear, or a map switch could apply its rules to the current router | each load carries a token checked with the router and the map before applying |
| Page clearing rules right after a load (found in Phase 1) | — | fixed in Phase 1, verified again here in the UI |

**Re-checked and correct as implemented:**
- **Speed resolution order:** lane override, then road-type default, then prefab (`GetDefaultSpeedLimit`).
- **Units:** km/h as saved.
- **Lane direction:** export lane direction, flipped by `Invert` (and by left-hand traffic for vehicle lanes), as the game computes it.
- **Arrow strictness:** TM:PE's pathfinder obeys arrows strictly for spawned private cars, except on the lane a trip starts from (`CustomPathFind` relaxed transitions).

## 3. Limitations of the routing model

The router works per segment and direction; the game routes per lane. Where that loses precision:
- **Speed:** one speed per direction, the fastest car lane's limit. Lowering one lane while another stays faster
  changes nothing here. The game lets each car pick a lane.
- **Restriction penalty:** TM:PE multiplies a lane's selection cost; the router multiplies the segment's travel
  cost by the same factor. The direction of the effect matches; the magnitudes are not comparable cost models.
- **Not modelled:** lane arrows, lane connections, priority signs, timed lights, turn-on-red, parking AI,
  "enter blocked junction".
- **U-turns:** decided only for segment ends whose node is matched. Pedestrian-street transitions are left
  undecided, because they depend on prefab vehicle categories. Without TM:PE, U-turns keep the router's own penalties.
- **"No limit" lanes:** keep the export's limit, because vehicle top speeds aren't in the save.
- **Left-hand traffic:** per-direction rules are off until tested.
- **Export-only one-ways:** about 3% wrong where the export has no evidence (section 1).
- **Transit pieces:** the fastest lane of the vehicle type is used for both directions.

## 4. Phase 2 (lane arrows, lane connections): feasibility

Measured on the reference save. The saved `NetLane` flags hold the effective arrows: game defaults, or TM:PE's
custom ones applied to the lane.

| What | Count | Representable |
|---|---|---|
| Segment ends with custom arrows | 51 | 48 ban a direction in the union of all car lanes' arrows (for example seg 20775 서빛서랑대로 → node 6030: all three lanes forward-only). That is a segment-level turn ban. The other 3 keep every direction reachable from some lane, so they matter only with lane state |
| Lane-connection source ends | 26 | 22 have connections on every arriving car lane, so the allowed targets are their union. 4 mix connected lanes with TM:PE's default lane routing |
| Connections leading onto a lane whose far end has custom arrows | 0 | the lane chosen at one junction never constrains the next one in this save |

**What Phase 2 can do exactly:** segment-level turn bans from arrows and connections. Two things are needed:
- **A port of TM:PE's left/forward/right classification** of outgoing segments at a node (segment-end geometry).
  It can be validated against the game's own default arrows, which every non-custom lane stores.
- **For the 4 mixed ends:** the default lanes follow their arrows, so their union is known once directions are
  classified.

**Where a segment-level model can be wrong:**
- **Over-permitting:** it can allow a sequence that needs a lane you can't be in. An example is a connection
  into the left lane of a short segment whose left lane turns left only. That would need lane-level state.
  The save has no such case, but other cities may.
- **Prohibiting:** a segment-level ban built from the union of all lanes never forbids a turn the game allows,
  except on a trip's first lane, where TM:PE relaxes arrows. The router can exempt the first segment.

**Lane-level routing** would multiply the state space by lanes per segment (about 2–4×) and needs TM:PE's full
default lane routing (`RoutingManager`, thousands of lines) to be exact. That's a large, fragile port.

**Recommendation:**
- Do a narrow Phase 2: segment-level turn bans from arrows and connections, with the direction classifier
  validated against the game's default arrows first.
- Exempt the start segment.
- Report the remaining lane-state cases as a known limitation rather than approximating them.
- Don't build lane-level routing.

## 5. Deployed behaviour: audit results

Headless Chromium, desktop and mobile, with the reference pair:

| Step | Route (example trip) | Toggle | Result |
|---|---|---|---|
| Export only | 11 min via the toll expressway | hidden | ✓ |
| Load the matching save | 6 min via 서빛서랑대로 | shown | ✓ |
| Rules off / on | 11 min / 6 min | — | ✓ |
| Load another city's save (rejected) | 11 min (rules dropped) | hidden | ✓ |
| Load the matching save again | 6 min | shown | ✓ |
| Remove the save | 11 min | hidden | ✓ |
| Switch to another map | card back to intro, legend hidden | hidden | ✓ |

No page errors. Directions re-routes when rules are loaded or removed. Opening the simulation card closes
Directions, reach and closures, so none of them can show a result computed under other rules.

**Test results:**
- `check:sim` 40/40;
- `check:oneway`, `check:transit`, `check:route-geometry`, `check:access` (29/29) and `check:closure` pass;
- unit checks pass;
- `check:i18n` passes (792 strings);
- build passes.
- `check:reach` shows the same 2 driving failures on the previous commit, run in a clean worktree, so they
  pre-date this work.

**Remaining risks:**
- untested save formats beyond 118011/121034;
- left-hand-traffic cities;
- TM:PE versions other than 11.9.4 (the options layout is version-specific);
- mod sets that resize game buffers;
- reach and closure have no "rules off" switch of their own;
- with Phase 1 live, routes in TM:PE cities now avoid U-turns at junctions. That is correct for these saves,
  but it is a visible behaviour change.
