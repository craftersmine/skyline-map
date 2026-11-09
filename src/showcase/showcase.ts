// Showcase page behaviour. The page is complete without it: this only adds the comparison slider,
// tabs, the section line's current stop and a lightbox for full-size screenshots.
import './showcase.css';

// Default ↔ Night comparison
for (const fig of document.querySelectorAll<HTMLElement>('[data-compare]')) {
  const range = fig.querySelector<HTMLInputElement>('input[type=range]')!;
  const set = () => fig.style.setProperty('--pos', range.value + '%');
  range.addEventListener('input', set);
  set();
}

// Tabs (roving focus, arrow keys)
for (const box of document.querySelectorAll<HTMLElement>('[data-tabs]')) {
  const tabs = [...box.querySelectorAll<HTMLButtonElement>('[role=tab]')];
  const select = (t: HTMLButtonElement, focus = false) => {
    for (const o of tabs) {
      const on = o === t;
      o.setAttribute('aria-selected', String(on));
      o.tabIndex = on ? 0 : -1;
      document.getElementById(o.getAttribute('aria-controls')!)!.hidden = !on;
    }
    if (focus) t.focus();
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t));
    t.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (e.key === 'Home') select(tabs[0], true);
      else if (e.key === 'End') select(tabs[tabs.length - 1], true);
      else if (d) select(tabs[(i + d + tabs.length) % tabs.length], true);
      else return;
      e.preventDefault();
    });
  });
}

// The section line marks the section in view
const links = new Map([...document.querySelectorAll<HTMLAnchorElement>('.line a')].map((a) => [a.hash.slice(1), a]));
const visible = new Map<string, number>();
const io = new IntersectionObserver((entries) => {
  for (const e of entries) visible.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0);
  let best = '', score = 0;
  for (const [id, r] of visible) if (r > score) { score = r; best = id; }
  if (!best) document.querySelector('.line')?.scrollTo({ left: 0 });
  for (const [id, a] of links) {
    if (id === best) { a.setAttribute('aria-current', 'true'); a.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    else a.removeAttribute('aria-current');
  }
}, { threshold: [0, 0.15, 0.3, 0.5], rootMargin: '-80px 0px -35% 0px' });
for (const id of links.keys()) { const s = document.getElementById(id); if (s) io.observe(s); }

// Lightbox: the full-size screenshot
const dlg = document.querySelector<HTMLDialogElement>('.lightbox')!;
const big = dlg.querySelector('img')!, cap = dlg.querySelector<HTMLElement>('.lb-cap')!;
document.addEventListener('click', (e) => {
  const fig = (e.target as HTMLElement).closest<HTMLElement>('.zoomable');
  if (!fig || (e.target as HTMLElement).closest('a, button, input')) return;
  const img = fig.querySelector<HTMLImageElement>('img[data-full]');
  if (!img) return;
  big.src = img.dataset.full!;
  big.alt = img.alt;
  big.classList.toggle('tall', img.naturalHeight > img.naturalWidth * 1.15);
  cap.textContent = fig.querySelector('figcaption')?.textContent ?? '';
  dlg.showModal();
});
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
dlg.addEventListener('close', () => { big.removeAttribute('src'); });
// zoomable figures are reachable by keyboard
for (const f of document.querySelectorAll<HTMLElement>('.zoomable')) {
  f.tabIndex = 0;
  f.setAttribute('role', 'button');
  f.setAttribute('aria-label', 'View full size: ' + (f.querySelector('img')?.alt ?? 'screenshot'));
  f.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); f.click(); } });
}
