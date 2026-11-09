# Traffic-aware routing: derivation, calibration, validation

2026-11-10. Implementation: `src/sim/traffic.ts` (the curve) and `Router.applyTraffic` / `setTraffic`. Scratch
scripts: `scratchpad/simtest/traffic` (`speeds.ts` extracts cars, `an1.py`–`an5.py` analyse, `validate.mts` runs
routes). Tests: `npm run check:sim`, section 3c.

## 1. What the save has

| Question | Answer (decompiled game 1.17 / TM:PE 11.9.4) |
|---|---|
| How is segment traffic stored? | One byte per segment, `NetSegment.m_trafficDensity`, 0–100, **not per direction** |
| How is it computed? | Every vehicle step (each vehicle every 16 frames), `CarAI` adds `2.5 × (vehicle length + 1)` to its segment's `m_trafficBuffer`. Every 256 frames `RoadBaseAI.SimulationStep` turns the buffer into `min(100, buffer × 100 / (16 × car-lane length))`, then moves the stored density at most 5 points toward it. So 100 % means vehicles (plus 1 m each) occupy 40 % of the lane length, averaged over the last 256 frames |
| What time window? | 256 frames is 1/256 of a game day (`DAYTIME_FRAMES` = 65,536), about 5.6 in-game minutes. Because of the 5-point step, the value lags: going from 0 to 100 takes about 20 updates, roughly 2 in-game hours. It describes the moment the game was saved, not a daily average |
| Speeds or travel times? | No per-segment speed or travel time is saved. TM:PE measures mean speeds per segment direction while running (`TrafficMeasurementManager.meanSpeed`), but doesn't save them (`SerializableDataExtension` has no such record). `PathUnit.m_speed` is the pathfinder's own estimate, not a measurement |
| Vehicle speeds? | **Yes.** `VehicleManager` saves each vehicle's velocity, and its path unit and position index give the segment and lane it is on |
| How do the game and TM:PE use density? | Neither turns it into a travel time. Vanilla `PathFind` multiplies a segment's route-choice cost by a random factor in [0.9, 1 + density/100), but not its duration. TM:PE's advanced AI (on in all four test cities) uses its unsaved measured mean speed the same way, as a route-choice cost |

So no formula from the game maps density to speed, and 80 % density does **not** mean 20 % speed. The relation
has to be measured.

## 2. Calibration

**Data.** 19 same-moment save/export pairs (format 121034) from 4 cities: 서랑시 (12 saves), 라스 크루즈,
스프링데일 and Quda City. The 18 older pairs (format 118011) were left out because their vehicle section has
another layout the scratch reader doesn't handle.

**Cars counted.** Every spawned private car on a vehicle lane of a matched segment: 27,463 in all. Excluded:
- dummy traffic, trailers, line vehicles, cargo carried on another vehicle, service vehicles;
- cars still waiting for a path;
- lanes with TM:PE "no limit".

**Measure.** The ratio of a car's speed to its lane limit: `|velocity| / (8 × limit in game units)`, using
`CarAI.CalculateTargetSpeed`'s 8 units per 50 km/h. The lane limit is the TM:PE lane limit, else TM:PE's
road-type default, else the prefab limit.

Cars stopped at lights or in queues are included, because that wait is part of the trip. For the cars on a segment
at one instant, the mean speed is the space-mean speed, so travel time ≈ length / mean speed.

| Density band | Mean speed / limit (all) | Highways | Other roads | Cars |
|---|---|---|---|---|
| 0–10 | 0.88 | 0.89 | 0.87 | 7,946 |
| 10–20 | 0.83 | 0.85 | 0.81 | 5,719 |
| 20–30 | 0.80 | 0.82 | 0.78 | 3,635 |
| 30–40 | 0.79 | 0.81 | 0.77 | 2,634 |
| 40–50 | 0.76 | 0.78 | 0.73 | 1,742 |
| 50–60 | 0.56 | 0.51 | 0.63 | 1,064 |
| 60–70 | 0.48 | 0.39 | 0.57 | 958 |
| 70–80 | 0.42 | 0.36 | 0.49 | 645 |
| 80–90 | 0.38 | 0.35 | 0.41 | 555 |
| 90–100 | 0.25 | 0.28 | 0.23 | 2,565 |

The curve is flat up to about 50 % (the 40 %-occupancy design point of the density scale), then falls steeply. All
four cities show the same knee (band means at 50–60: Quda 0.79, 라스 크루즈 0.44, 서랑시 0.61, 스프링데일 0.41).

**Model.** Pooled band means are made non-increasing (pool-adjacent-violators) and divided into the 0–10 band.
That gives a travel-time multiplier relative to free flow, linear between band mid-points:

| Density | 5 | 15 | 25 | 35 | 45 | 55 | 65 | 75 | 85 | 95+ |
|---|---|---|---|---|---|---|---|---|---|---|
| Time × | 1.00 | 1.06 | 1.10 | 1.11 | 1.16 | 1.56 | 1.85 | 2.09 | 2.29 | 3.57 |

The router's own time without traffic already assumes free flow (85 % of the limit in town), so the multiplier is
applied on top of it.

## 3. Validation

**Leave one city out.** Fit the curve on three cities and predict the fourth. The unit is a segment direction with
at least 2 cars. The target is that direction's observed slowdown against the held-out city's own free flow, on a
log scale.

| Segments | n | Error without traffic | Error with the model | Model bias |
|---|---|---|---|---|
| density < 50 | 4,205 | 0.227 | 0.232 | −0.17 |
| density ≥ 50 | 883 | 1.082 | 0.854 | −0.21 |

- On busy roads the model removes about a fifth of the error. On quiet ones it changes nothing, as it should.
- It **under-predicts** slowdowns: the bias is negative. The estimate is conservative.
- The remaining error is large because one instant is noisy: a car at a red light, or a queue at one end of the road.

**Alternatives tried and rejected:**
- **Separate curves for highways and other roads:** error 0.681 vs 0.679 on busy highways, 0.954 vs 0.978 on busy
  other roads. Not worth a second curve.
- **Direction-split density.** Direction matters: on 59 busy two-way segments, 28 had one direction moving (>0.7)
  while the other was jammed (<0.3). Splitting density by the snapshot's car counts per direction improved busy
  roads only slightly (0.854 → 0.828) and made quiet roads worse (0.232 → 0.244). It would also mean parsing every
  vehicle in the browser. Not adopted; this is the model's main known limitation.

**Routes** (250 random drives per city, traffic on vs off, rules on):

| City (save time) | Road length ≥ 50 % density | Time with traffic / without: median, p90, max | Take another way | Extra time per search |
|---|---|---|---|---|
| 서랑시, match (15:06) | 3 % | 1.05, 1.20, 1.64 | 56 of 245 | +3 ms |
| 서랑시, older map (near) | 3 % | 1.05, 1.18, 1.44 | 63 of 247 | +2 ms |
| 스프링데일 (06:43) | 19 % | 1.10, 1.25, 1.42 | 35 of 234 | 0 |
| Quda City (03:54) | 3 % | 1.02, 1.10, 1.17 | 3 of 239 | 0 |
| 라스 크루즈 (10:06) | 4 % | 1.01, 1.18, 1.72 | 24 of 249 | 0 |

**Examples on 서랑시:**
- From the 산포역 area (1617, −1961) to (7549, −3087): 13 min without traffic. With traffic, the same toll
  expressway is still best, and the card adds "Traffic adds about 5 min to this route".
- With the older map, from (3686, −2310) to (859, −771): 9 min via 산포대교 without traffic. With traffic the route
  switches to 서빛서랑대로 at 13 min; 산포대교 with traffic would take as long or longer.

**Checks** (`check:sim` 3c):
- the factor is ≥ 1, capped and non-decreasing;
- factors sit on matched drivable roads only;
- switched off, routes are identical;
- switched on, the comparison time is the same route's own time without traffic;
- no one-way, U-turn or lane-arrow ban is broken, and no trip is lost or gained;
- walking, cycling and transit are unchanged;
- reach never gets earlier;
- switching off or removing traffic restores routes exactly.

## 4. What the app does and doesn't claim

- **Time without traffic** (the default): unchanged.
- **Traffic-adjusted estimate** (switch on): each matched road's driving time × the multiplier for its density at
  the moment of saving. The route search minimises this time, and the card shows it with "Traffic adds about N min
  to this route".
- **Routing cost:** the same time, plus search-only terms that never reach the shown time (TM:PE's restriction factor,
  the avoid-tolls penalty). A last-resort route against an inferred one-way keeps its wrong-way penalty in the time,
  as before; traffic doesn't multiply that penalty.
- **Unknown:** unmatched roads keep their time without traffic. The card says when less than 90 % of the route has
  data.
- **Never affected:** walking, cycling and transit. Bus ride times use their own export-based model.
- **Limitations:**
  - density isn't directional;
  - it is one moment (with a lag of up to about 2 in-game hours), not a daily pattern;
  - junction delay is not separated from road delay;
  - the curve comes from 4 cities with TM:PE's advanced AI on; cities without TM:PE may differ.
