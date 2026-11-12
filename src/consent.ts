// Cookie consent + Google Analytics. GA loads only after the visitor accepts, so nothing is set before that
// (and never on localhost). Any element with [data-consent] reopens the banner to change the choice.
import { type Lang, LANG_EVENT, isLang, pickLang, savedLang, browserLangs } from './lang';
const GA_ID = 'G-123XJYCYYP';
const KEY = 'atlas:consent';
const LIVE = location.hostname === 'skyline.codz.me';

type Choice = 'granted' | 'denied';
const read = (): Choice | null => { try { const v = localStorage.getItem(KEY); return v === 'granted' || v === 'denied' ? v : null; } catch { return null; } };
const save = (c: Choice) => { try { localStorage.setItem(KEY, c); } catch { /* storage blocked: ask again next visit */ } };

// Banner text lives here rather than in the i18n tables so the blog, privacy and 404 pages don't load them.
// Record<Lang, …> makes a new language in src/lang.ts fail to compile until it has banner text.
const TEXT: Record<Lang, { msg: string; more: string; yes: string; no: string }> = {
  en: { msg: 'Mind if we count visits and get some useful info? Analytics cookies help us see what to improve.', more: 'Details', yes: 'Sure', no: 'No thanks' },
  ko: { msg: '방문 수를 세고 유용한 정보를 수집해도 될까요? 분석 쿠키로 무엇을 개선할지 알 수 있어요.', more: '자세히', yes: '좋아요', no: '아니요' },
  ru: { msg: 'Можно мы будем считать посещения и собирать немного полезной информации? Аналитические файлы cookie помогают понять, что улучшить.', more: 'Подробнее', yes: 'Хорошо', no: 'Нет, спасибо' },
};
let lang: Lang = pickLang(savedLang(), browserLangs());

declare global { interface Window { dataLayer?: unknown[]; gtag?: (...a: unknown[]) => void } }

let loaded = false;
function loadGA() {
  if (!LIVE) return;
  if (loaded) { window.gtag!('consent', 'update', { analytics_storage: 'granted' }); return; }
  loaded = true;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer!.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', GA_ID, { cookie_domain: location.hostname });
  const s = document.createElement('script');
  s.async = true; s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(s);
}

/** Withdrawn after accepting: stop GA and delete its cookies. */
function stopGA() {
  if (loaded) window.gtag!('consent', 'update', { analytics_storage: 'denied' });
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0].trim();
    if (!name.startsWith('_ga')) continue;
    for (const d of [location.hostname, '.' + location.hostname.split('.').slice(-2).join('.'), '']) {
      document.cookie = `${name}=; Max-Age=0; path=/${d ? '; domain=' + d : ''}`;
    }
  }
}

const STYLE = `
.cc{position:fixed;left:16px;bottom:16px;z-index:2147483000;max-width:min(380px,calc(100vw - 32px));display:flex;flex-wrap:wrap;align-items:center;gap:10px 12px;padding:12px 14px;background:#fff;color:#202124;border:1px solid #dadce0;border-radius:12px;box-shadow:0 4px 16px rgb(0 0 0/.16);font:400 13px/1.45 -apple-system,'Segoe UI',Roboto,'Apple SD Gothic Neo',sans-serif}
.cc p{margin:0;flex:1 1 220px}
.cc div{display:flex;gap:8px;margin-left:auto}
.cc a{color:#1a73e8;font-weight:600;text-decoration:none;white-space:nowrap}
.cc a:hover{text-decoration:underline}
.cc a:focus-visible{outline:2px solid #1a73e8;outline-offset:2px;border-radius:2px}
.cc button{font-family:inherit;font-weight:600;font-size:13px;line-height:1;padding:8px 14px;border-radius:8px;border:1px solid #dadce0;background:#fff;color:#1a73e8;cursor:pointer}
.cc button:hover{background:#f1f3f4}
.cc button.y{background:#1a73e8;border-color:#1a73e8;color:#fff}
.cc button.y:hover{background:#1765cc}
.cc button:focus-visible{outline:2px solid #1a73e8;outline-offset:2px}`;

let el: HTMLElement | null = null;
function fill() {
  if (!el) return;
  const s = TEXT[lang];
  el.lang = lang;
  el.innerHTML = `<p>${s.msg} <a href="/privacy" target="_blank" rel="noopener">${s.more}</a></p><div><button type="button" class="n">${s.no}</button><button type="button" class="y">${s.yes}</button></div>`;
}
function show() {
  if (el) return;
  if (!document.getElementById('cc-css')) { const st = document.createElement('style'); st.id = 'cc-css'; st.textContent = STYLE; document.head.appendChild(st); }
  el = document.createElement('div');
  el.className = 'cc'; el.setAttribute('role', 'region'); el.setAttribute('aria-label', 'Cookies');
  fill();
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    const c: Choice = b.classList.contains('y') ? 'granted' : 'denied';
    save(c);
    if (c === 'granted') loadGA(); else stopGA();
    el!.remove(); el = null;
  });
  document.body.appendChild(el);
}

const choice = read();
if (choice === 'granted') loadGA();
else if (!choice) show();
// the app's language switch: re-word an open banner
document.addEventListener(LANG_EVENT, (e) => { const l = (e as CustomEvent).detail; if (isLang(l)) { lang = l; fill(); } });
document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('[data-consent]')) return;
  e.preventDefault(); show();
});

export {};
