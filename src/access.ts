// Who may use a segment, decided from the lanes the game gives its network type.
//
// Lanes are the source of truth: walking needs a Pedestrian lane, driving a
// general car lane, cycling a bicycle lane or an ordinary road. Lane presence
// alone is not always permission, so these exceptions apply (all checked
// against the real exports, see the per-type table in `npm run check:access`):
//  - station platforms: Train/Metro/Monorail/CableCar track types carry
//    Pedestrian lanes for boarding; they are inside stations, not public paths;
//  - airport aprons and ship docks carry Pedestrian lanes for passengers and
//    crew walking to aircraft/ships;
//  - highways (incl. outside connections and the R69 racetrack, which are
//    flagged highway) may carry service/walk lanes but are not for pedestrians;
//  - bus-only roads: their car-type lanes are all `TransportVehicle` (public
//    transport only, e.g. Small Busway, Bus Station Way);
//  - pedestrian zones (Plazas & Promenades and similar) carry car lanes for
//    service vehicles only;
//  - racetracks are private.
import type { CSeg, CSegType } from './parse';

export interface Access {
  walk: boolean;
  drive: boolean;
  /** may ride a bike here */
  bike: boolean;
  /** cyclists may only push the bike (pedestrian-only paths), at walking pace */
  bikeWalk: boolean;
  /** why a lane-implied permission was withdrawn, for the check tool */
  reason?: string;
}

const PLATFORM_VEHICLES = /Train|Metro|Monorail|CableCar/;
const PED_ZONE = /Zonable|Promenade|Pedestrian|Boardwalk|PedRoad|Plaza/i;
const RACE = /Racetrack|Race ?Track|Raceway/i;

/** vType lists vehicles comma-separated ("Car, Tram"); match whole names so "CableCar" is not a car */
export const hasVehicle = (vType: string, name: string) => vType.split(',').some((v) => v.trim() === name);

export function laneAccess(seg: Pick<CSeg, 'name' | 'icls'>, st: CSegType | undefined): Access {
  const lanes = st?.lanes ?? [];
  const has = (t: RegExp, v?: RegExp) => lanes.some((l) => t.test(l.type) && (!v || v.test(l.vType)));
  const ped = has(/Pedestrian/);
  const bikeLane = lanes.some((l) => hasVehicle(l.vType, 'Bicycle'));
  const carGeneral = lanes.some((l) => l.type === 'Vehicle' && hasVehicle(l.vType, 'Car'));
  const carTransit = lanes.some((l) => l.type === 'TransportVehicle' && hasVehicle(l.vType, 'Car'));
  // a platform is track with boarding lanes; a street that also carries a monorail/tram is still a street
  const platform = !carGeneral && !carTransit && lanes.some((l) => l.type === 'Vehicle' && PLATFORM_VEHICLES.test(l.vType));
  const apron = lanes.some((l) => /Plane|Ship/.test(l.vType) || /^\d+$/.test(l.vType)); // taxiway lanes export a numeric vehicle mask
  const both = `${seg.name} ${seg.icls}`;
  const reasons: string[] = [];

  let walk = ped;
  if (walk && st?.highway) { walk = false; reasons.push('highway'); }
  if (walk && platform) { walk = false; reasons.push('station platform'); }
  if (walk && apron) { walk = false; reasons.push('airport/ship apron'); }
  if (walk && RACE.test(both)) { walk = false; reasons.push('racetrack'); }

  let drive = carGeneral;
  if (!carGeneral && carTransit) reasons.push('public transport only');
  if (drive && PED_ZONE.test(both)) { drive = false; reasons.push('pedestrian zone (service vehicles only)'); }
  if (drive && RACE.test(both)) { drive = false; reasons.push('racetrack'); }

  // bikes: bike lanes anywhere, or ordinary roads (not highways); push the bike on footpaths
  const bike = (bikeLane && !platform && !apron) || (drive && !st?.highway);
  const bikeWalk = !bike && walk;
  return { walk, drive, bike, bikeWalk, reason: reasons.length ? reasons.join(', ') : undefined };
}
