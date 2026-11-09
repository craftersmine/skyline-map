// CitizenManager section reader, reduced to per-building occupancy. Mirrors CitizenManager.Data.Serialize
// (acs/CitizenManager.cs:13), format 121034; 118011 per the Deserialize branches. CitizenUnit.m_building is not saved: a building's units are the
// chain from Building.m_citizenUnits via m_nextUnit, which is also how the game's info panels walk them.
import { SaveData, SaveError, section, endSection } from './reader';
import { SaveBuildings, BUILDING_COUNT } from './buildings';

// Array32<Citizen>(1048576u), Array32<CitizenUnit>(524288u), Array16<CitizenInstance>(65536u) (CitizenManager.cs:930-932)
const NC = 1048576, NU = 524288, NI = 65536;

// Citizen.Flags (Citizen.cs:9) / CitizenUnit.Flags (CitizenUnit.cs:7)
const C_DEAD = 0x8, C_MOVING_IN = 0x20, C_LOCATION_SHIFT = 19, LOC_VISIT = 2;
const U_HOME = 0x10, U_WORK = 0x20, U_VISIT = 0x40, U_STUDENT = 0x100;

/**
 * Per building id, counted the way the game's info panels count. -1 = the building has no CitizenUnit of that kind
 * (or the slot is unused), so the number does not apply; 0 means "has the units, nobody there".
 * "Present" below = slot citizen id != 0, citizen not Dead, not MovingIn (Citizen.Flags).
 *
 * No capacities for work/student/visit: the panels take those from the prefab (PrivateBuildingAI.CalculateWorkplaceCount,
 * PlayerBuildingAI.CountWorkPlaces, SchoolAI.StudentCount), which the save does not hold. Units are allocated
 * ceil(places / 5) (CitizenManager.CreateUnits:1148), so 5 x units would only be an upper bound.
 */
export interface BuildingOccupancy {
  /** present citizens in Home units — ZonedBuildingWorldInfoPanel.UpdateResidential:529 (the age/education chart total) */
  residents: Int32Array;
  /** Home units with >= 1 present citizen — "Households: {households}/{homes}", ResidentialBuildingAI.GetLocalizedStatusActive:242
   *  via CommonBuildingAI.GetHomeBehaviour:3454 (aliveHomeCount) */
  households: Int32Array;
  /** number of Home units (one per household, CreateUnits:1175) — the panel's household capacity (homeCount) */
  homes: Int32Array;
  /** present citizens in Work units — "Workers: {workers}/..." ZonedBuildingWorldInfoPanel.UpdateWorkers:426,
   *  CityServiceWorldInfoPanel.UpdateWorkers:1445 */
  workers: Int32Array;
  /** present citizens in Student units — CommonBuildingAI.GetStudentBehaviour:3510 aliveCount, which SchoolAI stores in
   *  m_customBuffer1 and shows as "Students" (SchoolAI.cs:67, 322) */
  students: Int32Array;
  /** present citizens in Visit units whose location is Visit — GetVisitBehaviour:3530 aliveCount (Citizen.GetCitizenVisitBehaviour:1766);
   *  includes tourists. Park/monument panels show a weekly peak of this (m_customBuffer2), not the live value. */
  visitors: Int32Array;
}

export function readOccupancy(sd: SaveData, b: SaveBuildings): BuildingOccupancy {
  const sec = section(sd, 'CitizenManager');
  if (!sec) throw new SaveError('corrupt', 'CitizenManager section missing');
  const { s, end } = sec;

  const cflags = new Uint32Array(NC);
  s.eaU32(NC - 1, cflags.subarray(1));
  let nc = 0;
  for (let i = 1; i < NC; i++) if (cflags[i]) nc++;
  const b8 = new Uint8Array(nc), b16 = new Uint16Array(nc);
  s.eaU8(nc, b8); s.eaU8(nc, b8); s.eaU16(nc, b16); s.eaU8(nc, b8); s.eaU8(nc, b8); s.eaU8(nc, b8); // health wellbeing age family jobTitle touristType

  const uflags = new Uint16Array(NU);
  s.eaU16(NU - 1, uflags.subarray(1));
  // per unit: next unit, and counts of present / present-at-Visit citizens (citizen flags are already read)
  const next = new Uint32Array(NU), present = new Uint8Array(NU), presentVisit = new Uint8Array(NU);
  let nu = 0;
  for (let u = 1; u < NU; u++) {
    if (!uflags[u]) continue;
    nu++;
    const m = s.u8();
    let p = 0, pv = 0;
    for (let k = 0; k < 5; k++) {
      if (!(m & (1 << k))) continue;
      const c = s.u24(), fl = cflags[c];
      if (fl & (C_DEAD | C_MOVING_IN)) continue;
      p++;
      if (((fl >>> C_LOCATION_SHIFT) & 3) === LOC_VISIT) pv++;
    }
    present[u] = p; presentVisit[u] = pv;
    if (m & 0x20) next[u] = s.u24();
  }
  s.eaU16(nu); // m_goods

  const iflags = new Uint32Array(NI);
  s.eaU32(NI - 1, iflags.subarray(1));
  let ni = 0;
  for (let i = 1; i < NI; i++) if (iflags[i]) ni++;
  s.eaU16(ni); // PrefabCollection<CitizenInfo> indices
  const psz = s.u16();
  for (let i = 0; i < psz; i++) s.ustr();
  // performer/racerIndex from 121028; 121028 also had a u16 that 121029 dropped (Deserialize:661)
  const extra = sd.version >= 121029 ? 2 : sd.version >= 121028 ? 4 : 0;
  for (let i = 1; i < NI; i++) {
    if (!iflags[i]) continue;
    // velocity, position (Vector3), targetPos (Vector4), targetDir (Vector2); [rgb if CustomColor]; citizen, path (u24);
    // pathPositionIndex lastPathOffset waitCounter targetSeed; [performer racer]; source, target building (u16)
    s.skip(48 + (iflags[i] & 0x1000000 ? 3 : 0) + 6 + 4 + extra + 4);
  }
  s.skip(8); // oldest original resident (temp, final), fully educated original residents
  endSection(s, end, 'CitizenManager');

  const N = BUILDING_COUNT;
  const mk = () => new Int32Array(N).fill(-1);
  const o: BuildingOccupancy = { residents: mk(), households: mk(), homes: mk(), workers: mk(), students: mk(), visitors: mk() };
  for (let id = 1; id < N; id++) {
    if (!b.flags[id]) continue;
    let homes = 0, households = 0, residents = 0, workers = 0, students = 0, visitors = 0, hasW = false, hasS = false, hasV = false;
    // same walk as CommonBuildingAI.GetHomeBehaviour & co.; the game logs "Invalid list" past 524288 steps, we refuse the data
    for (let u = b.citizenUnits[id], guard = 0; u !== 0; u = next[u]) {
      if (++guard > NU) throw new SaveError('corrupt', `citizen unit chain of building ${id} loops`);
      const fl = uflags[u];
      if (fl & U_HOME) { homes++; residents += present[u]; if (present[u]) households++; }
      if (fl & U_WORK) { hasW = true; workers += present[u]; }
      if (fl & U_STUDENT) { hasS = true; students += present[u]; }
      if (fl & U_VISIT) { hasV = true; visitors += presentVisit[u]; }
    }
    if (homes) { o.homes[id] = homes; o.households[id] = households; o.residents[id] = residents; }
    if (hasW) o.workers[id] = workers;
    if (hasS) o.students[id] = students;
    if (hasV) o.visitors[id] = visitors;
  }
  return o;
}
