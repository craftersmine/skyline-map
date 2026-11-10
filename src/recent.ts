// Recent cities: the last few maps opened from a file, kept in this browser (IndexedDB) so they reopen in one
// click. A save loaded over a map is kept with it and reloads too. Files are stored gzip-compressed; the worker
// reads gzip either way. Nothing leaves the browser.

export interface Recent {
  name: string; // city name from the export
  file: string; // file name as opened
  generated: string; // export time, from the file
  opened: number; // ms, last opened here
  map: Blob;
  save?: { file: string; blob: Blob };
}

const DB = 'skyline-atlas-cities', STORE = 'cities', KEEP = 5;

function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'name' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function req<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => { const q = fn(d.transaction(STORE, mode).objectStore(STORE)); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}

async function gzipped(b: Blob): Promise<Blob> {
  const h = new Uint8Array(await b.slice(0, 2).arrayBuffer());
  if (h[0] === 0x1f && h[1] === 0x8b) return b;
  return new Response(b.stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

/** newest first; [] when storage is blocked */
export async function listRecent(): Promise<Recent[]> {
  try { return ((await req('readonly', (s) => s.getAll())) as Recent[]).sort((a, b) => b.opened - a.opened); }
  catch { return []; }
}

/** remember a map that just opened; keeps the stored save only if it is the same file being reopened */
export async function rememberMap(name: string, file: string, generated: string, map: Blob): Promise<void> {
  try {
    const old = (await req('readonly', (s) => s.get(name))) as Recent | undefined;
    const keepSave = old && old.generated === generated ? old.save : undefined;
    const rec: Recent = { name, file, generated, opened: Date.now(), map: old && old.generated === generated ? old.map : await gzipped(map), save: keepSave };
    await req('readwrite', (s) => s.put(rec));
    for (const r of (await listRecent()).slice(KEEP)) await forget(r.name);
  } catch { /* storage blocked or full: the city simply isn't remembered */ }
}

/** remember the save loaded over a remembered map */
export async function rememberSave(name: string, file: string, save: Blob): Promise<void> {
  try {
    const rec = (await req('readonly', (s) => s.get(name))) as Recent | undefined;
    if (!rec) return;
    rec.save = { file, blob: await gzipped(save) };
    await req('readwrite', (s) => s.put(rec));
  } catch { /* ignore */ }
}

export async function forget(name: string): Promise<void> {
  try { await req('readwrite', (s) => s.delete(name)); } catch { /* ignore */ }
}
