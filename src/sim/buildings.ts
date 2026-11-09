// BuildingManager section reader. Mirrors BuildingManager.Data.Serialize (acs/BuildingManager.cs:40), format 121034;
// older formats follow the version branches of Data.Deserialize (BuildingManager.cs:884).
// Per-building columns are written only for slots whose m_flags != 0, in id order; we scatter them back to id-indexed arrays.
import { SaveData, SaveError, section, endSection } from './reader';

/** new Array16<Building>(49152u) (BuildingManager.cs:3283). Slot 0 is never used. */
export const BUILDING_COUNT = 49152;

/** All arrays are indexed by building id (0..49151); values are meaningless where flags[id] === 0. */
export interface SaveBuildings {
  /** number of slots with m_flags != 0 (the rows the save stores) */
  count: number;
  /** Building.m_flags (Created = 1, CustomName = 8, Untouchable = 0x10, Completed = 0x10000, Active = 0x20000, Abandoned = 0x40000, Collapsed = 0x400000, ...) */
  flags: Uint32Array;
  /** index into prefabNames (PrefabCollection<BuildingInfo> simulation index) */
  prefab: Uint16Array;
  /** BuildingInfo names by simulation index; null for indices no building uses */
  prefabNames: (string | null)[];
  /** m_position, game metres: x/z ground plane (origin = map centre), y = height */
  posX: Float32Array; posY: Float32Array; posZ: Float32Array;
  /** m_angle, radians */
  angle: Float32Array;
  /** m_width / m_length in 8 m cells */
  width: Uint8Array; length: Uint8Array;
  /** m_citizenUnits: first CitizenUnit of the building's chain (0 = none) */
  citizenUnits: Uint32Array;
  /** m_level, 0-based (ItemClass.Level1 = 0). Zoned info panel shows m_level + 1 level bars (ZonedBuildingWorldInfoPanel.UpdateLevels). */
  level: Uint8Array;
  /** m_happiness 0..100 as last simulated. Zoned panel icon = Citizen.GetHappinessLevel: <=15 Bad, <=30 Poor, <=44 Good, <=69 Excellent, else Superb (Citizen.cs:1085). */
  happiness: Uint8Array;
  /** m_problems (Notification.Problem1 / Problem2 bitmasks) — the notification icons over the building */
  problems1: BigUint64Array; problems2: BigUint64Array;
}

export function readBuildings(sd: SaveData): SaveBuildings {
  const sec = section(sd, 'BuildingManager');
  if (!sec) throw new SaveError('corrupt', 'BuildingManager section missing');
  const { s, end } = sec;
  const N = BUILDING_COUNT;
  const v = sd.version;

  const flags = new Uint32Array(N);
  s.eaU32(N - 1, flags.subarray(1));
  s.eaU32(N - 1); // m_flags2
  const ids: number[] = [];
  for (let i = 1; i < N; i++) if (flags[i]) ids.push(i);
  const n = ids.length;

  const numGuides = s.u16(), numMilestones = s.u16();
  const pidx = s.eaU16(n + numGuides + numMilestones); // PrefabCollection.Serialize per building, then guide/milestone prefabs
  const psz = s.u16();
  const prefabNames: (string | null)[] = [];
  for (let i = 0; i < psz; i++) prefabNames.push(s.ustr());
  for (let i = 0; i < numGuides + numMilestones; i++) s.obj();
  for (let i = v >= 121033 ? 71 : 65; i > 0; i--) s.obj(); // m_buildingAbandoned1 .. m_buildingNoEventAccess (6 race guides from 121033, Deserialize:1265)
  s.skip(32); // last/current global problems (4 x ulong)
  const pr = new BigUint64Array(s.eaI64(2 * n).buffer);

  const u16 = () => s.eaU16(n), u8 = () => s.eaU8(n);
  for (let k = 0; k < 13; k++) u16(); // netNode subBuilding waterSource electricity water sewage heating garbage crime mail custom1 custom2 buildWaterHeight
  for (let k = 0; k < 9; k++) u8();   // productionRate waterPollution constructState fireIntensity fireDamage productionState health childHealth seniorHealth
  const happ = u8();
  for (let k = 0; k < 5; k++) u8();   // citizenCount tempImport tempExport finalImport finalExport
  s.eaU8(11 * n);                     // 11 problem timers
  u8();                               // levelUpProgress
  const wid = u8(), len = u8();
  for (let k = 0; k < 9; k++) u8();   // education1..3 children teens youngs adults seniors fireHazard
  const lvl = u8();
  s.eaU32(n); s.eaU32(n);             // cargoTrafficRate garbageTrafficRate
  u16();                              // accessSegment
  if (v >= 121017) u16();             // eventAccessSegment (Deserialize:2313)
  s.eaI32(n);                         // cashBuffer
  for (let k = 0; k < 4; k++) u16();  // roomCost roomCostTarget roomMax roomUsed
  if (v >= 120001) for (let k = 0; k < 5; k++) u8(); // educated0..3Unemployed allUnemployed (Deserialize:2433)
  if (v >= 121005) u16();             // eventRouteIndex (Deserialize:2512)
  for (let k = 0; k < 2; k++) { const c = s.i16(); for (let i = 0; i < c; i++) { s.u16(); s.sstr(); } } // vehicle selections

  const prefab = new Uint16Array(N), width = new Uint8Array(N), length = new Uint8Array(N);
  const level = new Uint8Array(N), happiness = new Uint8Array(N), citizenUnits = new Uint32Array(N);
  const posX = new Float32Array(N), posY = new Float32Array(N), posZ = new Float32Array(N), angle = new Float32Array(N);
  const problems1 = new BigUint64Array(N), problems2 = new BigUint64Array(N);
  for (let k = 0; k < n; k++) {
    const id = ids[k];
    prefab[id] = pidx[k]; width[id] = wid[k]; length[id] = len[k]; level[id] = lvl[k]; happiness[id] = happ[k];
    problems1[id] = pr[2 * k]; problems2[id] = pr[2 * k + 1];
    s.u32(); // buildIndex
    posX[id] = s.f32(); posY[id] = s.f32(); posZ[id] = s.f32(); angle[id] = s.f32();
    s.u8(); // baseHeight
    citizenUnits[id] = s.u24();
  }
  s.skip(16 * 2 * 2 * 16); // temp/final monument effects + temp/final faculty bonus: 16 x 2 x (int32 + Vector3)
  if (v >= 121026) { // race teams (Deserialize:2703)
    let teams = 0;
    for (let k = 0; k < n; k++) if (s.bool()) teams++;
    s.eaU16(teams);
    const tsz = s.u16();
    for (let i = 0; i < tsz; i++) s.ustr();
  }
  endSection(s, end, 'BuildingManager');

  return { count: n, flags, prefab, prefabNames, posX, posY, posZ, angle, width, length, citizenUnits, level, happiness, problems1, problems2 };
}

const f = Math.fround;

/**
 * Footprint corners exactly as CSLMapView writes them (MapInfoExporter.ExportBuilding): float32 math at each Unity call,
 * order (-w,-l) (+w,-l) (+w,+l) (-w,+l). Returns [x0,z0,x1,z1,x2,z2,x3,z3]; every corner's y is posY[id].
 */
export function buildingCorners(b: SaveBuildings, id: number): number[] {
  const px = b.posX[id], pz = b.posZ[id], a = b.angle[id];
  const vx = f(f(Math.cos(a)) * 8), vz = f(f(Math.sin(a)) * 8); // new Vector3(Mathf.Cos, 0, Mathf.Sin) * 8f
  const v2x = vz, v2z = f(-vx);                                    // (vector.z, 0, -vector.x)
  const hw = f(b.width[id] / 2), hl = f(b.length[id] / 2);
  const ax = f(hw * vx), az = f(hw * vz), bx = f(hl * v2x), bz = f(hl * v2z);
  const out: number[] = [];
  for (const [sa, sb] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    out.push(f(f(px + sa * ax) + sb * bx), f(f(pz + sa * az) + sb * bz));
  }
  return out;
}
