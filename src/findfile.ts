// "Where is my file?" on the start screen: the folder CSLMapView exports to on this computer's OS, a button
// to copy it, and how to jump straight there in the system's file picker.
//
// CSLMapView writes its exports into a CSLMapView folder inside the game's install folder
// (steamapps/common/Cities_Skylines/CSLMapView), as .cslmap.gz since mod version 2.3.0. The paths below are
// Steam's default library on each OS; a custom library is covered by Steam's "Browse local files".
import { t, onLang } from './i18n';

import { EXPORT_DIRS, OS_NAMES, detectOS, type OS } from './findfile-os';

const kbd = (...keys: string[]) => keys.map((k) => `<kbd>${k}</kbd>`).join('');
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Numbered steps for jumping to a folder in each OS's file picker (HTML; keys as <kbd>). */
function steps(os: OS): string[] {
  if (os === 'mac') return [
    t('Copy the folder path above.'),
    t('Click the box above. In the window that opens, press {keys}.', { keys: kbd('⌘', '⇧', 'G') }),
    t('Paste with {keys}, press {enter}, then pick the newest file.', { keys: kbd('⌘', 'V'), enter: kbd('Return') }),
  ];
  if (os === 'windows') return [
    t('Copy the folder path above.'),
    t('Click the box above. In the window that opens, press {keys} to jump to the address bar.', { keys: kbd('Alt', 'D') }),
    t('Paste with {keys}, press {enter}, then pick the newest file.', { keys: kbd('Ctrl', 'V'), enter: kbd('Enter') }),
  ];
  return [
    t('Copy the folder path above.'),
    t('Click the box above. In the window that opens, press {keys} to type a location.', { keys: kbd('Ctrl', 'L') }),
    t('Paste with {keys}, press {enter}, then pick the newest file.', { keys: kbd('Ctrl', 'V'), enter: kbd('Enter') }),
  ];
}

/** Renders the helper into `el` and keeps it in the current language. */
export function mountFindFile(el: HTMLElement) {
  const detected = detectOS();
  let os: OS = detected ?? 'windows';
  let copied = false;

  const render = () => {
    el.innerHTML = `
      <div class="ff-head">
        <b>${esc(t('Where is my file?'))}</b>
        <div class="ff-os" role="tablist" aria-label="${esc(t('Operating system'))}">${(Object.keys(OS_NAMES) as OS[]).map((o) => `<button type="button" role="tab" data-os="${o}" aria-selected="${o === os}"${o === os ? '' : ' tabindex="-1"'}>${OS_NAMES[o]}</button>`).join('')}</div>
      </div>
      ${detected ? '' : `<p class="ff-note">${esc(t('Open this page on the computer you play on, then pick your system.'))}</p>`}
      <p class="ff-lede">${esc(t('CSLMapView saves your exports here:'))}</p>
      <div class="ff-path">
        <code id="ffPath" title="${esc(EXPORT_DIRS[os])}">${esc(EXPORT_DIRS[os]).replace(/([\\/])/g, '$1<wbr>')}</code>
        <button type="button" class="ff-copy${copied ? ' done' : ''}" aria-describedby="ffPath">${esc(copied ? t('Copied') : t('Copy path'))}</button>
      </div>
      <ol class="ff-steps">${steps(os).map((s) => `<li>${s}</li>`).join('')}</ol>
      <p class="ff-alt">${esc(t('Steam library somewhere else? In Steam, right-click Cities: Skylines, choose Manage, then Browse local files, and open the CSLMapView folder.'))}</p>`;
  };

  el.addEventListener('click', async (e) => {
    const tg = e.target as HTMLElement;
    const tab = tg.closest<HTMLElement>('[data-os]');
    if (tab) { os = tab.dataset.os as OS; copied = false; render(); el.querySelector<HTMLElement>(`[data-os="${os}"]`)?.focus(); return; }
    if (tg.closest('.ff-copy')) {
      const path = EXPORT_DIRS[os];
      try { await navigator.clipboard.writeText(path); }
      catch {
        // clipboard blocked (non-secure context, permissions): select the text so the user can copy it
        const code = el.querySelector('#ffPath')!; const r = document.createRange(); r.selectNodeContents(code);
        const sel = getSelection(); sel?.removeAllRanges(); sel?.addRange(r);
        try { document.execCommand('copy'); } catch { /* the selection is there to copy by hand */ }
      }
      copied = true; render();
      setTimeout(() => { copied = false; render(); }, 2200);
    }
  });
  el.addEventListener('keydown', (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-os]');
    if (!tab || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
    const all = Object.keys(OS_NAMES) as OS[];
    os = all[(all.indexOf(tab.dataset.os as OS) + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
    copied = false; render(); el.querySelector<HTMLElement>(`[data-os="${os}"]`)?.focus(); e.preventDefault();
  });
  render();
  onLang(render);
}
