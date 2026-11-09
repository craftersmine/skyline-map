// City-wide statistics: DistrictManager district 0 (the whole city) and EconomyManager tax rates.
// Mirrors DistrictManager.Data.Serialize (acs/DistrictManager.cs:56) and EconomyManager.Data.Serialize
// (acs/EconomyManager.cs:65), format 121034. Only values a game panel shows are exposed, computed the way it does.
// District "final" values are the last completed district update (every 256 simulation frames, a few game hours).
import { SaveData, SaveError, Stream, section, endSection } from './reader';

/** new Array8<District>(128u), new Array8<DistrictPark>(128u), Cell[262144] (DistrictManager.cs:2610) */
const DISTRICTS = 128, PARKS = 128, GRID = 512 * 512;
/** EconomyManager.Awake (EconomyManager.cs:705): 140 tax rates, 42 budgets, 3094 income/expense, 20 loan/policy/total, 3 loans */
const TAXES = 140, BUDGETS = 42, CLASS_HIST = 3094, HIST20 = 20, LOANS = 3;
/** new Array8<Investment>(255u) (EconomyManager.cs:1939) */
const INVESTMENTS = 255;

export interface SchoolStats {
  /** District.GetEducationNRate: graduates of this level as % of the population (Education info view "graduated") */
  graduatedPct: number;
  /** m_*EligibleData.m_finalCount (Education info view "eligible") */
  eligible: number;
  /** m_productionData.m_finalEducationNCapacity (Education info view "capacity") */
  capacity: number;
}

export interface CityStats {
  /** m_populationData.m_finalCount — Population info view "Population" */
  population: number;
  /** District.GetWorkerCount: employees in commercial+industrial+office+player buildings — Population info view "Workers" */
  workers: number;
  /** District.GetWorkplaceCount: jobs in those buildings — Population info view "Workplaces" */
  workplaces: number;
  /** sum of m_educated0..3Data.m_finalUnemployed (no panel shows the count itself) */
  unemployed: number;
  /** District.GetUnemployment — Population info view "Unemployment" %. Its denominator is the district's young+adult
   *  age-group counts, which this game build/mods may classify differently from raw citizen ages. */
  unemploymentPct: number;
  /** m_educated0..3Data.m_finalCount: citizens by education level [uneducated, educated, well, highly] */
  educationLevels: [number, number, number, number];
  /** Education info view pie legend %, same order (RoundToInt; first slice absorbs rounding) */
  educationShares: [number, number, number, number];
  elementary: SchoolStats; highSchool: SchoolStats; university: SchoolStats;
  /** Education info view library: m_finalLibraryCapacity, m_libraryVisitorData.m_finalCount */
  library: { capacity: number; visitors: number };
  /** m_birthData / m_deathData final — Population info view births / deaths (per district update) */
  births: number; deaths: number;
  /** m_tourist1..3Data.m_averageVisits (smoothed) by wealth [low, mid, high] — Tourism info view; total = their sum */
  touristsByWealth: [number, number, number];
  tourists: number;
  /** m_finalHappiness 0..100 — the toolbar happiness icon */
  happiness: number;
  /** m_finalCrimeRate % — Crime info view meter */
  crimeRatePct: number;
  /** District.GetLandValue (m_groundData.m_finalLandvalue) — Land value info view average, money per cell */
  landValue: number;
  /** District.GetGroundPollution (m_finalPollution*100/255) — Pollution info view "ground" % */
  groundPollutionPct: number;
  /** EconomyManager tax rates % as the Economy panel's Taxes sliders read them (GetTaxRate with Level.None) */
  taxRates: { residentialLow: number; residentialHigh: number; commercialLow: number; commercialHigh: number; industrial: number; office: number };
}

/** Read fields of the given byte widths ("3344..." = u24 u24 u32 u32 ...), unsigned. */
function fields(s: Stream, layout: string): number[] {
  const out: number[] = new Array(layout.length);
  for (let i = 0; i < layout.length; i++) {
    switch (layout.charCodeAt(i) - 48) {
      case 1: out[i] = s.u8(); break;
      case 2: out[i] = s.u16(); break;
      case 3: out[i] = s.u24(); break;
      case 4: out[i] = s.u32(); break;
      default: s.skip(8); out[i] = 0;
    }
  }
  return out;
}

// Serialize layouts of District*Data structs, field by field (see each struct's Serialize).
const AGE = '33', POP = '33' + '2'.repeat(16), EDU = '33333333', TOURIST = '33333', SUBCULTURE = '3431', GROUND = '44241', SPEC = '33333333', USAGE = '33333333';
const PRIVATE = '3343331133333111114133222222334122';
const CONSUMPTION = '33334233333344443333421133';
const RESOURCE = '4'.repeat(21);
const PRODUCTION = '33334433334433443344333333333322422444433444433443333333333333333333333333333333333333333333333';
const AREA_RESOURCE = '4'.repeat(14), PARK_PRIVATE = '333333333333334';

/** Mathf.RoundToInt (round half to even) on a float32 */
const roundToInt = (x: number) => { const f = Math.floor(x), d = x - f; return d > 0.5 || (d === 0.5 && f % 2 !== 0) ? f + 1 : f; };

interface District0 {
  pop: number; happiness: number; crime: number; ages: number[]; eligible: number[];
  alive: number[]; homeOrWork: number[]; births: number; deaths: number;
  educated: number[][]; education: number[]; production: number[]; ground: number[]; tourist: number[][]; library: number;
}

function readDistricts(sd: SaveData): District0 {
  const sec = section(sd, 'DistrictManager');
  if (!sec) throw new SaveError('corrupt', 'DistrictManager section missing');
  const { s, end } = sec;
  s.ustr(); s.bool(); // airline name, airport panel opened
  const dflags = s.eaU32(DISTRICTS), pflags = s.eaU32(PARKS);
  s.eaBool(12 * 32 * DISTRICTS + 4 * 32 * PARKS); // policy bit planes
  let d0: District0 | null = null;
  for (let i = 0; i < DISTRICTS; i++) {
    if (!dflags[i]) continue;
    s.u64();
    const pop = fields(s, POP)[1];
    const happiness = s.u8(), crime = s.u8();
    const ages: number[] = [];
    for (let k = 0; k < 11; k++) ages.push(fields(s, AGE)[1]); // child..senior, health/sick, death stats
    s.i8(); // last average lifespan
    const eligible = [0, 1, 2].map(() => fields(s, AGE)[1]);
    const alive: number[] = [], homeOrWork: number[] = [];
    for (let k = 0; k < 6; k++) { const p = fields(s, PRIVATE); homeOrWork.push(p[4]); alive.push(p[29]); } // res, com, visitor, ind, office, player
    for (let k = 0; k < 9; k++) fields(s, SPEC);
    const births = fields(s, AGE)[1], deaths = fields(s, AGE)[1];
    const educated = [0, 1, 2, 3].map(() => fields(s, EDU));
    const education = [0, 1, 2].map(() => fields(s, AGE)[1]);
    for (let k = 0; k < 3; k++) fields(s, AGE); // students per level (no panel shows them)
    const production = fields(s, PRODUCTION);
    for (let k = 0; k < 5; k++) fields(s, CONSUMPTION);
    fields(s, USAGE);
    const ground = fields(s, GROUND);
    fields(s, RESOURCE); fields(s, RESOURCE); // import, export
    const tourist = [0, 1, 2].map(() => fields(s, TOURIST));
    for (let k = 0; k < 4; k++) fields(s, SUBCULTURE);
    if (i === 0) { fields(s, '3333' + '1111' + '333'); s.ustr(); fields(s, '133'); } // hotel data
    if (s.bool()) s.ustr(); // style
    const library = fields(s, AGE)[1];
    s.i8(); // airline
    if (i === 0) d0 = { pop, happiness, crime, ages, eligible, alive, homeOrWork, births, deaths, educated, education, production, ground, tourist, library };
  }
  for (let i = 0; i < PARKS; i++) if (pflags[i]) skipPark(s, i);
  s.eaU8(GRID * 8); s.eaU8(GRID * 8); // district / park grids
  for (let i = 0; i < 19; i++) s.obj();
  s.u32(); s.u32(); s.u32();
  endSection(s, end, 'DistrictManager');
  if (!d0) throw new SaveError('corrupt', 'city district missing');
  return d0;
}

function skipYearReport(s: Stream) {
  fields(s, '4411244448'); s.eaI64(5); s.eaI64(5); s.eaU8(5); s.eaU8(5); s.eaU8(5); s.eaBool(5);
  fields(s, '1888'); s.ustr(); s.i16();
}

function skipPark(s: Stream, i: number) {
  const head = fields(s, '8' + '2222' + '44444444' + '22222' + '11' + '2' + '11' + '2222' + '1' + '22' + '11111' + '8' + '22');
  const type = head[18], tempGates = head[21], finalGates = head[22];
  if (type >= 5 && type <= 9) for (let k = 0; k < 13; k++) fields(s, AREA_RESOURCE); // industry
  if ((type >= 10 && type <= 13) || i === 0) { // campus (park 0 always)
    fields(s, '222' + '4444');
    for (let k = 0; k < 13; k++) skipYearReport(s); // current, last, second last, 10-year ledger
    fields(s, '111214'); s.eaI64(25); fields(s, '12'); s.eaU8(3); fields(s, '2222'); s.eaBool(5); s.i16();
  }
  if (type === 14) fields(s, '444111' + '4444'); // airport
  if (type === 15) { // pedestrian zone
    const n = s.i32();
    if (n < 0 || n > 256) throw new SaveError('corrupt', 'bad pedestrian zone data');
    for (let r = 0; r < 2 * n; r++) { s.u8(); const c = s.i32(); if (c < 0 || c > 65536) throw new SaveError('corrupt', 'bad pedestrian zone data'); s.eaU16(c); }
    s.eaU16(finalGates); s.eaU16(tempGates);
    const rsp = s.i8();
    for (let k = 0; k < rsp; k++) { s.i64(); s.u16(); }
    for (let k = 0; k < 4; k++) fields(s, PARK_PRIVATE);
    fields(s, '1144');
    for (let r = 0; r < n; r++) fields(s, '14444');
    s.bool(); s.bool();
  }
}

function readTaxRates(sd: SaveData): Uint8Array {
  const sec = section(sd, 'EconomyManager');
  if (!sec) throw new SaveError('corrupt', 'EconomyManager section missing');
  const { s, end } = sec;
  // EconomyManager.Deserialize: before format 120002 there were 41 budgets, 697 (not 714) public-class history slots and 19-slot totals
  const old = sd.version < 120002;
  const budgets = old ? 41 : BUDGETS, hist = old ? CLASS_HIST - 17 : CLASS_HIST, h20 = old ? 19 : HIST20;
  const tax = s.eaU8(TAXES);
  s.eaU8(budgets * 2);
  s.eaI64(hist + h20); // income + total income
  s.eaI64(hist + h20 * 3); // expenses + loan, policy, total expenses
  for (let i = 0; i < LOANS; i++) fields(s, '44224');
  fields(s, '88888' + '224'); // money (not exposed: unlimited-money mods make it meaningless), tax multiplier, bailout
  s.obj(); s.obj();
  // SerializeInvestments (EconomyManager.cs:2011)
  fields(s, '242444444' + '88' + '1'); s.obj(); s.obj(); s.obj();
  const iflags = s.eaU16(INVESTMENTS - 1);
  let n = 0;
  for (const f of iflags) if (f) { n++; s.eaF32(s.i16()); }
  fields(s, '444'.repeat(n)); fields(s, '8'.repeat(n)); fields(s, '24'.repeat(n));
  s.eaU16(n); const np = s.u16(); for (let i = 0; i < np; i++) s.ustr();
  endSection(s, end, 'EconomyManager');
  return tax;
}

export function readCityStats(sd: SaveData): CityStats {
  const d = readDistricts(sd);
  const tax = readTaxRates(sd);
  // ages: child, teen, young, adult, senior (used only inside the game's own formulas below)
  const [child, teen, young, adult, senior] = d.ages;
  const ageSum = child + teen + young + adult + senior;
  const unemployed = d.educated.reduce((a, e) => a + e[4], 0);
  const working = young + adult;
  const rate = (n: number) => ageSum ? Math.min(100, Math.trunc((n * 100 + (ageSum >> 1)) / ageSum)) : 0;
  const levels = d.educated.map(e => e[3]) as [number, number, number, number];
  const total = levels[0] + levels[1] + levels[2] + levels[3];
  const share = (v: number) => { const f = Math.fround(Math.fround(v / total) * 100); return Number.isFinite(f) ? Math.min(100, Math.max(0, roundToInt(f))) : 0; };
  const shares = levels.map(share) as [number, number, number, number];
  const sum = shares[0] + shares[1] + shares[2] + shares[3];
  if (sum !== 0 && sum !== 100) shares[0] = 100 - (shares[1] + shares[2] + shares[3]);
  const P = d.production;
  const tw = d.tourist.map(t => t[2]) as [number, number, number];
  // PrivateClassIndex(service, SubService.None or sub, Level.None) = (service or 8+sub) * 5
  return {
    population: d.pop,
    workers: d.alive[1] + d.alive[3] + d.alive[4] + d.alive[5],
    workplaces: d.homeOrWork[1] + d.homeOrWork[3] + d.homeOrWork[4] + d.homeOrWork[5],
    unemployed,
    unemploymentPct: Math.min(100, Math.trunc((unemployed * 100 + (working >> 1)) / Math.max(1, working))),
    educationLevels: levels, educationShares: shares,
    elementary: { graduatedPct: rate(d.education[0]), eligible: d.eligible[0], capacity: P[23] },
    highSchool: { graduatedPct: rate(d.education[1]), eligible: d.eligible[1], capacity: P[24] },
    university: { graduatedPct: rate(d.education[2]), eligible: d.eligible[2], capacity: P[25] },
    library: { capacity: P[56], visitors: d.library },
    births: d.births, deaths: d.deaths,
    touristsByWealth: tw, tourists: tw[0] + tw[1] + tw[2],
    happiness: d.happiness, crimeRatePct: d.crime,
    landValue: d.ground[2], groundPollutionPct: Math.trunc(d.ground[4] * 100 / 255),
    taxRates: { residentialLow: tax[40], residentialHigh: tax[45], commercialLow: tax[50], commercialHigh: tax[55], industrial: tax[10], office: tax[35] },
  };
}
