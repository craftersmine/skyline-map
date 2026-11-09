// Self-check for OS detection on the start screen's "Where is my file?" helper. Run: npm run check
import assert from 'node:assert/strict';
import { detectOS, EXPORT_DIRS } from './findfile-os.ts';

const nav = (userAgent: string, platform = '', userAgentData?: { platform?: string; mobile?: boolean }) => ({ userAgent, platform, userAgentData });
assert.equal(detectOS(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15', 'MacIntel')), 'mac');
assert.equal(detectOS(nav('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', 'Win32')), 'windows');
assert.equal(detectOS(nav('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', 'Linux x86_64')), 'linux');
assert.equal(detectOS(nav('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', 'Linux x86_64')), 'linux');
assert.equal(detectOS(nav('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', '', { platform: 'Windows', mobile: false })), 'windows');
assert.equal(detectOS(nav('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', 'iPhone')), null, 'phones have no game files');
assert.equal(detectOS(nav('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36', 'Linux armv8l')), null, 'Android is not desktop Linux');
assert.equal(detectOS(nav('Mozilla/5.0 (Linux; Android 14)', '', { platform: 'Android', mobile: true })), null);
// every path ends in the CSLMapView folder inside the game's install folder
for (const p of Object.values(EXPORT_DIRS)) assert.match(p, /steamapps[\\/]common[\\/]Cities_Skylines[\\/]CSLMapView$/);
console.log('find-file checks passed');
