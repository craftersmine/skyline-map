// Where CSLMapView exports live on each desktop OS, and which OS this page runs on (no app dependencies, so
// the self-check can run it directly). CSLMapView writes into a CSLMapView folder inside the game's install
// folder (steamapps/common/Cities_Skylines/CSLMapView); these are Steam's default libraries.
export type OS = 'mac' | 'windows' | 'linux';

export const EXPORT_DIRS: Record<OS, string> = {
  mac: '~/Library/Application Support/Steam/steamapps/common/Cities_Skylines/CSLMapView',
  windows: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Cities_Skylines\\CSLMapView',
  linux: '~/.local/share/Steam/steamapps/common/Cities_Skylines/CSLMapView',
};
export const OS_NAMES: Record<OS, string> = { mac: 'macOS', windows: 'Windows', linux: 'Linux' };

/** The desktop OS this page runs on, or null on phones and tablets (the game is not there). */
export function detectOS(nav: Pick<Navigator, 'userAgent' | 'platform'> & { userAgentData?: { platform?: string; mobile?: boolean } } = navigator): OS | null {
  const ua = nav.userAgent ?? '', plat = (nav.userAgentData?.platform || nav.platform || '').toLowerCase();
  if (nav.userAgentData?.mobile || /Android|iPhone|iPad|iPod/i.test(ua)) return null;
  // iPadOS reports itself as a Mac but has touch
  if ((plat.includes('mac') || /Macintosh/.test(ua)) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1) return null;
  if (plat.includes('mac') || /Macintosh|Mac OS X/.test(ua)) return 'mac';
  if (plat.includes('win') || /Windows/.test(ua)) return 'windows';
  if (plat.includes('linux') || /Linux|X11|CrOS/.test(ua)) return 'linux';
  return null;
}

