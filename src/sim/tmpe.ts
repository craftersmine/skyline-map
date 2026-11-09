// TM:PE (Traffic Manager: President Edition) settings stored in the save's mod data.
// Blobs (TrafficManager.Lifecycle.SerializableDataExtension): 'TrafficManager_v1.0' = BinaryFormatter
// Configuration, 'TrafficManager_VersionInfo_v1.0' = VersionInfoConfiguration. 'TMPE_Options' is not read.
// Semantics below follow each manager's LoadData. TM:PE also drops entries whose lane/segment/node is
// invalid at load time; we can't check that here, so callers should ignore ids not in use in the save.

import { readNrbf, nrbfList, NrbfObject, NrbfError } from './nrbf';

/** SpeedValue.UNLIMITED = 20 game units; 1 game unit = 50 km/h (ApiConstants.SPEED_TO_KMPH). */
export const TMPE_UNLIMITED_KMH = 1000;

/** TrafficManager.API.Traffic.Enums.ExtVehicleType single-bit flags (saved as the legacy enum, same bits). */
export const EXT_VEHICLE_TYPES: [number, string][] = [
  [0x1, 'PassengerCar'], [0x2, 'Bus'], [0x4, 'Taxi'], [0x8, 'CargoTruck'], [0x10, 'Service'], [0x20, 'Emergency'],
  [0x40, 'PassengerTrain'], [0x80, 'CargoTrain'], [0x100, 'Tram'], [0x200, 'Bicycle'], [0x400, 'Pedestrian'],
  [0x800, 'PassengerShip'], [0x1000, 'CargoShip'], [0x2000, 'PassengerPlane'], [0x4000, 'Helicopter'],
  [0x8000, 'CableCar'], [0x10000, 'PassengerFerry'], [0x20000, 'PassengerBlimp'], [0x40000, 'CargoPlane'],
  [0x80000, 'Trolleybus'],
];

/** Configuration.SegmentNodeFlags: null = not set, TM:PE uses its default (often an option, e.g. allowUTurns). */
export interface JunctionFlags {
  uturnAllowed: boolean | null;
  turnOnRedAllowed: boolean | null;         // near-side turn on red
  farTurnOnRedAllowed: boolean | null;
  straightLaneChangingAllowed: boolean | null;
  enterWhenBlockedAllowed: boolean | null;
  pedestrianCrossingAllowed: boolean | null;
}

export interface TmpeData {
  /** Configuration.Version (3 = current; < 2 means lane connections are bidirectional) */
  version: number | null;
  /** TM:PE assembly version that wrote the save, e.g. "11.9.4.25100" */
  modVersion: string | null;
  /** per-lane override (SpeedLimitManager): km/h, integer; TMPE_UNLIMITED_KMH = no limit */
  speedLimits: { lane: number; kmh: number }[];
  /** per-prefab default override by NetInfo name. gameUnits as saved (1 = 50 km/h, 20 = unlimited);
   *  kmh = round(gameUnits*50) like SpeedValue.ToKmphPrecise. Negative entries are ignored by TM:PE and dropped. */
  customDefaultSpeedLimits: { prefab: string; gameUnits: number; kmh: number }[];
  /** ParkingRestrictionsManager: parking allowed per segment direction (Forward/Backward); only segments with a restriction are saved */
  parking: { segment: number; forward: boolean; backward: boolean }[];
  /** LaneArrowManager: custom arrows (NetLane flags Forward 0x10, Left 0x20, Right 0x40) */
  laneArrows: { lane: number; forward: boolean; left: boolean; right: boolean }[];
  /** LaneConnectionManager: source lane at its start/end node connects to target. group: 1 road, 2 track, 3 both */
  laneConnections: { source: number; target: number; sourceStartNode: boolean; group: number; bidirectional: boolean }[];
  /** VehicleRestrictionsManager: allowed vehicle types on the lane (TM:PE ANDs this with the lane's base mask) */
  vehicleRestrictions: { lane: number; mask: number; allowed: string[] }[];
  /** TrafficPriorityManager: sign on `segment` at its end touching `node`; type 0 (None) entries are skipped */
  prioritySigns: { segment: number; node: number; type: 'main' | 'stop' | 'yield' }[];
  /** JunctionRestrictionsManager: per segment end; null end = nothing set there */
  junctionRestrictions: { segment: number; start: JunctionFlags | null; end: JunctionFlags | null }[];
}

const PRIORITY = [null, 'main', 'stop', 'yield'] as const;

function obj(v: unknown, what: string): Record<string, unknown> {
  if (!(v instanceof NrbfObject)) throw new NrbfError(`${what}: expected object`);
  return v.fields;
}
function num(v: unknown, what: string): number {
  if (v instanceof NrbfObject && 'value__' in v.fields) v = v.fields.value__; // boxed enum
  if (typeof v !== 'number') throw new NrbfError(`${what}: expected number`);
  return v;
}
function bool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') throw new NrbfError(`${what}: expected bool`);
  return v;
}
const optBool = (v: unknown, what: string) => (v === null || v === undefined ? null : bool(v, what));
const list = (v: unknown) => nrbfList(v) ?? [];

export function vehicleTypeNames(mask: number): string[] {
  return EXT_VEHICLE_TYPES.filter(([bit]) => (mask & bit) !== 0).map(([, n]) => n);
}

function junction(v: unknown): JunctionFlags | null {
  if (v === null) return null;
  const f = obj(v, 'SegmentNodeFlags');
  const g = (k: keyof JunctionFlags) => optBool(f[k], k);
  return {
    uturnAllowed: g('uturnAllowed'), turnOnRedAllowed: g('turnOnRedAllowed'), farTurnOnRedAllowed: g('farTurnOnRedAllowed'),
    straightLaneChangingAllowed: g('straightLaneChangingAllowed'), enterWhenBlockedAllowed: g('enterWhenBlockedAllowed'),
    pedestrianCrossingAllowed: g('pedestrianCrossingAllowed'),
  };
}

function parse(bytes: Uint8Array): NrbfObject {
  const { root, end } = readNrbf(bytes);
  if (end !== bytes.length) throw new NrbfError(`TM:PE blob: ${bytes.length - end} trailing bytes`);
  if (!(root instanceof NrbfObject)) throw new NrbfError('TM:PE blob: root is not an object');
  return root;
}

/** null when the save has no TM:PE data; throws NrbfError on a malformed blob. */
export function readTmpe(modData: Map<string, Uint8Array>): TmpeData | null {
  const blob = modData.get('TrafficManager_v1.0');
  if (!blob || blob.length === 0) return null;

  let modVersion: string | null = null;
  const vblob = modData.get('TrafficManager_VersionInfo_v1.0');
  if (vblob && vblob.length) {
    const vi = obj(parse(vblob).fields.VersionInfo, 'VersionInfo');
    const av = vi.assemblyVersion;
    if (av instanceof NrbfObject) {
      const f = av.fields; // System.Version; unset build/revision are -1
      modVersion = [f._Major, f._Minor, f._Build, f._Revision].filter(x => typeof x === 'number' && x >= 0).join('.');
    }
  }

  const root = parse(blob);
  if (root.type !== 'TrafficManager.Configuration') throw new NrbfError(`TM:PE blob: unexpected root ${root.type}`);
  const c = root.fields;
  // a field missing from an old save keeps its C# default (Version: 0)
  const version = c.Version === undefined ? 0 : num(c.Version, 'Version');

  const speedLimits = list(c.LaneSpeedLimits).map(e => {
    const f = obj(e, 'LaneSpeedLimit');
    return { lane: num(f.laneId, 'laneId'), kmh: num(f.speedLimit, 'speedLimit') };
  });

  const customDefaultSpeedLimits: TmpeData['customDefaultSpeedLimits'] = [];
  if (c.CustomDefaultSpeedLimits instanceof NrbfObject) {
    for (const kv of list(c.CustomDefaultSpeedLimits.fields.KeyValuePairs)) {
      const f = obj(kv, 'KeyValuePair');
      const units = num(f.value, 'value');
      if (typeof f.key === 'string' && units >= 0) customDefaultSpeedLimits.push({ prefab: f.key, gameUnits: units, kmh: Math.round(units * 50) });
    }
  }

  const parking = list(c.ParkingRestrictions).map(e => {
    const f = obj(e, 'ParkingRestriction');
    return { segment: num(f.segmentId, 'segmentId'), forward: bool(f.forwardParkingAllowed, 'fwd'), backward: bool(f.backwardParkingAllowed, 'bwd') };
  });

  const laneArrows = list(c.LaneArrows).map(e => {
    const f = obj(e, 'LaneArrowData');
    const a = num(f.arrows, 'arrows') & 0x70; // Flags.lfr
    return { lane: num(f.laneId, 'laneId'), forward: (a & 0x10) !== 0, left: (a & 0x20) !== 0, right: (a & 0x40) !== 0 };
  });

  // LaneConnection is ISerializable; older saves use lower*/higher* names (see its deserializing constructor)
  const laneConnections = list(c.LaneConnections).map(e => {
    const f = obj(e, 'LaneConnection');
    return {
      source: num(f.sourceLaneId ?? f.lowerLaneId, 'sourceLaneId'),
      target: num(f.targetLaneId ?? f.higherLaneId, 'targetLaneId'),
      sourceStartNode: bool(f.sourceStartNode ?? f.lowerStartNode, 'sourceStartNode'),
      group: f.group === undefined ? 3 : num(f.group, 'group'), // default LaneEndTransitionGroup.Vehicle
      bidirectional: version < 2,
    };
  });

  const vehicleRestrictions = list(c.LaneAllowedVehicleTypes).map(e => {
    const f = obj(e, 'LaneVehicleTypes');
    const mask = num(f.vehicleTypes, 'vehicleTypes');
    return { lane: num(f.laneId, 'laneId'), mask, allowed: vehicleTypeNames(mask) };
  });

  const prioritySigns: TmpeData['prioritySigns'] = [];
  for (const e of list(c.CustomPrioritySegments)) {
    const f = obj(e, 'PrioritySegment');
    const t = PRIORITY[num(f.priorityType, 'priorityType')];
    if (t === undefined) throw new NrbfError(`unknown priority type ${f.priorityType}`);
    if (t) prioritySigns.push({ segment: num(f.segmentId, 'segmentId'), node: num(f.nodeId, 'nodeId'), type: t });
  }
  // old List<int[]> format: [nodeId, segmentId, type]
  for (const e of list(c.PrioritySegments)) {
    const a = e as ArrayLike<number> | null;
    if (!a || a.length < 3 || a[2] === 0) continue;
    const t = PRIORITY[a[2]];
    if (!t) throw new NrbfError(`unknown priority type ${a[2]}`);
    prioritySigns.push({ segment: a[1] & 0xffff, node: a[0] & 0xffff, type: t });
  }

  const junctionRestrictions = list(c.SegmentNodeConfs).map(e => {
    const f = obj(e, 'SegmentNodeConf');
    return { segment: num(f.segmentId, 'segmentId'), start: junction(f.startNodeFlags), end: junction(f.endNodeFlags) };
  });

  return { version, modVersion, speedLimits, customDefaultSpeedLimits, parking, laneArrows, laneConnections, vehicleRestrictions, prioritySigns, junctionRestrictions };
}
