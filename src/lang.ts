// Supported UI languages and which one to use. No translation tables here, so pages that only need the
// language (the cookie banner on the blog, privacy and 404 pages) can import it without loading them.

export type Lang = 'en' | 'ko' | 'ru';
/** `locale` is the BCP 47 tag used for numbers and dates */
export const LANGS: { id: Lang; name: string; locale: string }[] = [
  { id: 'en', name: 'English', locale: 'en-US' },
  { id: 'ko', name: '한국어', locale: 'ko-KR' },
  { id: 'ru', name: 'Русский', locale: 'ru-RU' },
];
export const LANG_KEY = 'atlas:lang';
/** fired on document when the UI language changes */
export const LANG_EVENT = 'atlas:langchange';

export const isLang = (v: unknown): v is Lang => LANGS.some((l) => l.id === v);
export const localeOf = (l: Lang) => LANGS.find((x) => x.id === l)!.locale;

/** the saved choice, else the first browser language we support (by base tag: "ru-RU" → ru), else English */
export function pickLang(saved: string | null, browser: readonly string[]): Lang {
  if (isLang(saved)) return saved;
  for (const b of browser) { const base = b.toLowerCase().split('-')[0]; if (isLang(base)) return base; }
  return 'en';
}
export function savedLang(): string | null {
  try { return localStorage.getItem(LANG_KEY); } catch { return null; }
}
export function browserLangs(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}
