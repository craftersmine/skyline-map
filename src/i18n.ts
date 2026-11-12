// UI language. English text is the key; other languages map it to their own text.
// Placeholders: {name}. Korean particles follow the word they attach to:
// {road|ro} → 서빛로로 / 중앙로로 / 강남대교로, {x|eul} → 을/를, {x|i} → 이/가, {x|eun} → 은/는.
import { KO } from './i18n-ko';
import { RU } from './i18n-ru';
import { type Lang, LANGS, LANG_KEY, LANG_EVENT, localeOf, pickLang, savedLang, browserLangs } from './lang';

export { type Lang, LANGS };
/** every language in LANGS needs a table here (English is the key itself) */
export const DICTS: Record<Lang, Record<string, string>> = { en: {}, ko: KO, ru: RU };

let lang: Lang = 'en';
const subs = new Set<() => void>();
export const getLang = () => lang;
/** BCP 47 locale for dates and numbers */
export const locale = () => localeOf(lang);
/** a number with exactly `digits` decimals in the UI locale (2.5 / 2,5), without thousands separators like toFixed */
export const fmtFixed = (v: number, digits: number) => v.toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });

export function initLang(): Lang {
  setLang(pickLang(savedLang(), browserLangs()), false);
  return lang;
}
export function setLang(l: Lang, save = true) {
  lang = l;
  if (save) try { localStorage.setItem(LANG_KEY, l); } catch { /* ignore */ }
  if (typeof document !== 'undefined') { document.documentElement.lang = l; document.dispatchEvent(new CustomEvent(LANG_EVENT, { detail: l })); }
  subs.forEach((f) => f());
}
export const onLang = (f: () => void) => { subs.add(f); };

// ------------------------------------------------------------------ Korean particles
const PAIRS: Record<string, [string, string]> = { eul: ['을', '를'], i: ['이', '가'], eun: ['은', '는'], wa: ['과', '와'], ro: ['으로', '로'] };
/** final consonant of the last sound: true / false / null when unknown (latin letters) */
function batchim(word: string): { has: boolean; rieul: boolean } | null {
  const c = word.trim().replace(/[)\]」』"'.\s]+$/, '').slice(-1);
  const code = c.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) { const j = (code - 0xac00) % 28; return { has: j > 0, rieul: j === 8 }; }
  if (/\d/.test(c)) return { has: '013678'.includes(c), rieul: '178'.includes(c) }; // 영 일 삼 육 칠 팔 / 일 칠 팔
  return null;
}
export function josa(word: string, k: string): string {
  const p = PAIRS[k];
  if (!p) return word;
  const b = batchim(word);
  if (!b) return word + (k === 'ro' ? '(으)로' : `${p[0]}(${p[1]})`);
  if (k === 'ro') return word + (b.has && !b.rieul ? '으로' : '로');
  return word + (b.has ? p[0] : p[1]);
}

/** translate; vars fill {placeholders} */
export function t(key: string, vars?: Record<string, string | number>): string {
  const s = DICTS[lang][key] ?? key;
  if (!vars && !s.includes('{')) return s;
  return s.replace(/\{(\w+)(?:\|(\w+))?\}/g, (m, k: string, j?: string) => {
    if (!vars || !(k in vars)) return m;
    const v = typeof vars[k] === 'number' ? (vars[k] as number).toLocaleString(locale()) : String(vars[k]);
    return j && lang === 'ko' ? josa(v, j) : v;
  });
}
/** count-dependent English forms ({n} is filled in); Korean uses one form for both keys */
export const tn = (n: number, one: string, other: string, vars?: Record<string, string | number>) => t(n === 1 ? one : other, { n, ...vars });

/** fill elements marked data-i18n / data-i18n-html / data-i18n-title / -placeholder / -aria with the current language */
export function applyStatic(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((e) => { e.dataset.i18nSrc ??= e.dataset.i18n || e.textContent!.trim(); e.textContent = t(e.dataset.i18nSrc); });
  root.querySelectorAll<HTMLElement>('[data-i18n-html]').forEach((e) => { e.dataset.i18nSrc ??= e.innerHTML.trim(); e.innerHTML = t(e.dataset.i18nSrc); });
  for (const a of ['title', 'placeholder', 'aria-label'] as const) {
    const key = a === 'aria-label' ? 'i18nAria' : a === 'title' ? 'i18nTitle' : 'i18nPlaceholder';
    root.querySelectorAll<HTMLElement>(`[data-i18n-${a === 'aria-label' ? 'aria' : a}]`).forEach((e) => {
      const src = (e.dataset[key] ||= e.getAttribute(a) ?? '');
      e.setAttribute(a, t(src));
    });
  }
}

export function demo() {
  const was = lang;
  lang = 'ko';
  const r = [josa('서빛로', 'ro'), josa('중앙대로', 'ro'), josa('강남대교', 'ro'), josa('1번 국도', 'ro'), josa('서울역', 'ro'), josa('Main St', 'ro'), josa('노랑선', 'eul'), josa('지하철 2호선', 'i')];
  lang = was;
  const want = ['서빛로로', '중앙대로로', '강남대교로', '1번 국도로', '서울역으로', 'Main St(으)로', '노랑선을', '지하철 2호선이'];
  r.forEach((v, i) => { if (v !== want[i]) throw new Error(`josa ${v} ≠ ${want[i]}`); });
  return 'i18n checks passed';
}
