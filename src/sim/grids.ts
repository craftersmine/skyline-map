// Map grids: ImmaterialResourceManager (acs/ImmaterialResourceManager.cs:132) and NaturalResourceManager
// (acs/NaturalResourceManager.cs:92) Data.Serialize, format 121034.
import { SaveData, SaveError, section, endSection } from './reader';

/**
 * Immaterial grid: RESOURCEGRID_RESOLUTION 256, CELL_SIZE 38.4 m, centred on 0,0, so it spans only
 * ±4915.2 m (the central 5x5 tiles). Cell of a world position (CheckResource):
 *   x = clamp(trunc(pos.x / 38.4 + 128), 0, 255), z = same with pos.z, index = z * 256 + x.
 * Outside the span the game clamps to the edge cells; treat that as "no data".
 */
export const IMM_RES = 256, IMM_CELL = 38.4;
/** ImmaterialResourceManager.Resource count (35 values per cell) */
const IMM_COUNT = 35;
const LAND_VALUE = 14, NOISE = 8, CRIME = 9;
/**
 * Natural grid: RESOURCEGRID_RESOLUTION 512, CELL_SIZE 33.75 m, covers the whole 17280 m map (CheckPollution):
 *   x = clamp(trunc(pos.x / 33.75 + 256), 0, 511), index = z * 512 + x.
 */
export const NAT_RES = 512, NAT_CELL = 33.75;
/** NaturalResourceManager.m_areaResources = new AreaCell[81] (one per tile) */
const AREA_CELLS = 81;

export interface SaveGrids {
  /**
   * m_localFinalResources (what CheckResource reads), by cell. Land value and noise info views tint the
   * terrain with intensity = clamp01(sqrt(w / 100)), w = 3x3 average weighted 5/7/14 (UpdateTexture), i.e. full
   * colour at 100 and above; the colours themselves are prefab properties, not in the save.
   */
  landValue: Uint16Array;
  /** noise; a resident's health target drops by local*100/255 (ResidentAI.UpdateHealth, read at the home building) */
  noise: Uint16Array;
  /** crime; a resident's health target drops by 2 above 3, 5 above 30, 15 above 70 (ResidentAI.UpdateHealth). No info view draws this grid. */
  crime: Uint16Array;
  /**
   * ResourceCell.m_pollution 0..255 (CheckPollution, the ground pollution the simulation reads). The terrain shader
   * gets the 3x3 weighted average / 255 (NaturalResourceManager.UpdateTextureB, shader global _NaturalDestruction red); the city stat shows it as v*100/255 %.
   */
  groundPollution: Uint8Array;
}

export function readGrids(sd: SaveData): SaveGrids {
  const imm = section(sd, 'ImmaterialResourceManager');
  if (!imm) throw new SaveError('corrupt', 'ImmaterialResourceManager section missing');
  const N = IMM_RES * IMM_RES;
  const all = imm.s.eaU16(N * IMM_COUNT); // final values
  const landValue = new Uint16Array(N), noise = new Uint16Array(N), crime = new Uint16Array(N);
  for (let i = 0, o = 0; i < N; i++, o += IMM_COUNT) { landValue[i] = all[o + LAND_VALUE]; noise[i] = all[o + NOISE]; crime[i] = all[o + CRIME]; }
  imm.s.eaU16(N * IMM_COUNT, all); // temp values, reusing the buffer
  for (let k = 0; k < IMM_COUNT; k++) { imm.s.skip(8); imm.s.skip(8); imm.s.skip(8); } // total/temp/mul/global per resource (i32 i32 i64 i32 i32)
  endSection(imm.s, imm.end, 'ImmaterialResourceManager');

  const nat = section(sd, 'NaturalResourceManager');
  if (!nat) throw new SaveError('corrupt', 'NaturalResourceManager section missing');
  const s = nat.s, M = NAT_RES * NAT_RES;
  const buf = new Uint8Array(M);
  s.eaU8(M, buf); s.eaU8(M, buf); s.eaU8(M, buf); // ore, oil, sand
  s.eaU8(M, buf); // forest
  let forest = 0;
  for (let i = 0; i < M; i++) if (buf[i]) forest++;
  s.eaU8(forest); s.eaU8(M - forest); // tree (forest cells only), fertility (the others)
  s.eaU8(M, buf); s.eaU8(M, buf); // water, shore
  const groundPollution = s.eaU8(M);
  s.eaU8(M, buf); s.eaU8(M, buf); // burned, destroyed
  s.eaU32(AREA_CELLS * 10);
  s.skip(8 * 4 + 2); // used resources, pollution dispose rates
  endSection(s, nat.end, 'NaturalResourceManager');
  return { landValue, noise, crime, groundPollution };
}
