// Draggable bottom sheet for phones, after Google Maps: a handle, three snap
// heights (peek / half / full), flick to snap, drag below the lowest snap to
// dismiss. Inert on wider screens, where the same element is a side card.
export type Snap = 'peek' | 'half' | 'full';

export const isPhone = () => matchMedia('(max-width: 640px)').matches;

export interface SheetOpts {
  /** the element that scrolls inside the sheet (may be the sheet itself) */
  scroll: HTMLElement | (() => HTMLElement);
  snaps: Snap[];
  /** visible height for 'peek' */
  peek: () => number;
  /** space kept free above the sheet at 'full' */
  top?: () => number;
  /** drag below the lowest snap closes the sheet */
  onDismiss?: () => void;
  /** publish the visible height as --sheet-h so floating buttons sit above it */
  publish?: boolean;
}

export function bottomSheet(el: HTMLElement, o: SheetOpts) {
  el.classList.add('sheet');
  const handle = document.createElement('div');
  handle.className = 'sheet-handle'; handle.setAttribute('aria-hidden', 'true');
  el.prepend(handle);

  let snap: Snap = o.snaps[0], y = 0, active = false;
  const sc = () => (typeof o.scroll === 'function' ? o.scroll() : o.scroll);
  const H = () => window.innerHeight - (o.top?.() ?? 0);
  /** height of the content if nothing were cut off */
  const natural = () => {
    const s = sc(), top = el.getBoundingClientRect().top;
    const bottoms = (n: Element, extra = 0) => [...n.children].map((k) => k.getBoundingClientRect().bottom + extra);
    let b = 0;
    if (s === el) b = Math.max(0, ...bottoms(el, el.scrollTop));
    else for (const c of el.children) b = Math.max(b, ...(c === s || c.contains(s) ? bottoms(s, s.scrollTop) : [c.getBoundingClientRect().bottom]));
    return b - top + 14;
  };
  const visible = (s: Snap) => {
    const h = H(), n = Math.min(h, natural());
    const v = s === 'peek' ? o.peek() : s === 'half' ? h * 0.5 : h;
    return Math.max(56, Math.min(v, n));
  };
  function place(v: number, animate: boolean) {
    const h = H();
    y = h - v;
    el.style.height = h + 'px';
    el.style.transition = animate ? '' : 'none';
    el.style.transform = `translateY(${y}px)`;
    el.classList.toggle('sheet-full', snap === 'full' && v >= h - 1);
    if (o.publish) document.documentElement.style.setProperty('--sheet-h', Math.round(Math.min(v, h * 0.6)) + 'px');
  }
  function clear() {
    for (const p of ['height', 'transform', 'transition'] as const) el.style[p] = '';
    el.classList.remove('sheet-full');
    if (o.publish) document.documentElement.style.setProperty('--sheet-h', '0px');
  }
  function show(s: Snap = o.snaps.includes('half') ? 'half' : o.snaps[0]) {
    active = true;
    if (!isPhone()) return clear();
    snap = s; requestAnimationFrame(() => place(visible(snap), true));
  }
  function hide() { active = false; clear(); }
  /** content changed: keep the snap, re-measure */
  function refresh() { if (active && isPhone() && !el.hidden) place(visible(snap), true); }
  function to(s: Snap) { if (o.snaps.includes(s)) { snap = s; refresh(); } }

  // ---------------------------------------------------------------- dragging
  let start: { y: number; x: number; t: number; sheetY: number; id: number } | null = null, dragging = false, last = { y: 0, t: 0, v: 0 };
  el.addEventListener('pointerdown', (e) => {
    if (!active || !isPhone() || e.button > 0) return;
    if ((e.target as HTMLElement).closest('input, select, textarea, label')) return;
    start = { y: e.clientY, x: e.clientX, t: e.timeStamp, sheetY: y, id: e.pointerId }; dragging = false;
    last = { y: e.clientY, t: e.timeStamp, v: 0 };
  });
  el.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dy = e.clientY - start.y;
    if (!dragging) {
      if (Math.abs(dy) < 6 || Math.abs(dy) < Math.abs(e.clientX - start.x)) return;
      const onHandle = (e.target as HTMLElement).closest('.sheet-handle, [data-sheet-drag]');
      const full = el.classList.contains('sheet-full');
      // when full, the content scrolls; the sheet moves from the handle, or when pulled down at the top
      if (full && !onHandle && !(dy > 0 && sc().scrollTop <= 0)) { start = null; return; }
      dragging = true; el.setPointerCapture(e.pointerId); el.style.transition = 'none';
    }
    const h = H(), ny = Math.max(0, Math.min(h - 40, start.sheetY + dy));
    el.style.transform = `translateY(${ny}px)`; y = ny;
    const dt = e.timeStamp - last.t;
    if (dt > 0) last = { y: e.clientY, t: e.timeStamp, v: (e.clientY - last.y) / dt };
    e.preventDefault();
  });
  const end = (e: PointerEvent) => {
    if (!start || e.pointerId !== start.id) return;
    const was = dragging; start = null; dragging = false;
    if (!was) return;
    swallowUntil = performance.now() + 80; // the click that ends a drag is not a tap
    const h = H(), v = h - y;
    const lowest = Math.min(...o.snaps.map(visible));
    if (o.onDismiss && (v < lowest - 70 || (last.v > 1.2 && snap === o.snaps[0]))) { hide(); o.onDismiss(); return; }
    // flick picks the next snap in that direction, otherwise the nearest
    const opts = o.snaps.map((s) => ({ s, v: visible(s) })).sort((a, b) => a.v - b.v);
    let pick = opts.reduce((a, b) => (Math.abs(b.v - v) < Math.abs(a.v - v) ? b : a));
    if (Math.abs(last.v) > 0.5) pick = last.v < 0 ? opts.find((x) => x.v > v + 10) ?? opts[opts.length - 1] : [...opts].reverse().find((x) => x.v < v - 10) ?? opts[0];
    snap = pick.s; place(pick.v, true);
  };
  let swallowUntil = 0;
  el.addEventListener('click', (c) => { if (performance.now() < swallowUntil) { c.stopPropagation(); c.preventDefault(); } }, { capture: true });
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  handle.addEventListener('click', () => { const i = o.snaps.indexOf(snap); to(o.snaps[(i + 1) % o.snaps.length]); });

  addEventListener('resize', () => { if (!active) return; if (isPhone()) refresh(); else clear(); });
  return { show, hide, refresh, to, get snap() { return snap; } };
}
