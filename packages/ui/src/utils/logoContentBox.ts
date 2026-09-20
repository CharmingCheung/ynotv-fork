import { LRUCache } from './lru-cache';

/**
 * Logo content-box detection (smart trim).
 *
 * Many channel logos are shipped with a lot of transparent padding baked into
 * the image, which makes them look tiny inside a fixed-size tile when rendered
 * with `object-fit: contain` — and `object-fit: cover` (the old "remove
 * padding" workaround) crops parts of the logo off.
 *
 * This util samples the opaque pixels of a logo once and computes the bounding
 * box of the actual visible content (normalized 0..1 fractions of the image).
 * The UI can then zoom into that region so the logo fills its tile edge-to-edge
 * without ever cropping content.
 *
 * Results are cached in memory (LRU) and persisted to localStorage so we never
 * re-sample logos that have already been analyzed.
 */

export interface LogoContentBox {
  /** Normalized fractions (0..1) of the opaque content within the image. */
  l: number;
  t: number;
  r: number;
  b: number;
}

export interface LogoDims {
  w: number;
  h: number;
}

// Bumped from v1: entries written by earlier analysis passes could disagree with
// the image the app is displaying (the CDN serving different bytes at the same
// URL, or a box measured from a partially-painted copy). A stored box is a hint
// that is verified against the loaded image once per session, so a stale entry
// can only affect the first paint of a session — but bumping the key retires the
// bad entries outright instead of leaving them to be measured over.
const STORAGE_KEY = 'ynotv.logo-contentbox.v2';
const DIMS_STORAGE_KEY = 'ynotv.logo-dims.v2';
const MAX_PERSISTED = 10000;
const MAX_CONCURRENT_FETCHES = 8;
const MAX_ANALYSIS_DIM = 160;
const ALPHA_THRESHOLD = 24;
const SAFETY_MARGIN = 0.02;

const memoryCache = new LRUCache<string, LogoContentBox | null>({ maxSize: 5000 });
const dimsMemoryCache = new LRUCache<string, LogoDims>({ maxSize: 5000 });
const inFlight = new Map<string, Promise<LogoContentBox | null>>();
/** URLs whose cached box has already been re-measured this session. */
const boxesVerifiedThisSession = new Set<string>();
let pendingFetches = 0;

let persisted: Record<string, LogoContentBox | null> = {};
let persistedLoaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

let dimsPersisted: Record<string, LogoDims> = {};
let dimsPersistedLoaded = false;
let dimsPersistTimer: ReturnType<typeof setTimeout> | null = null;

function loadPersisted(): Record<string, LogoContentBox | null> {
  if (persistedLoaded) return persisted;
  persistedLoaded = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    persisted = raw ? JSON.parse(raw) : {};
  } catch {
    persisted = {};
  }
  return persisted;
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    } catch {
      // Storage full or unavailable — keep in-memory only
    }
  }, 2000);
}

function getCached(url: string): LogoContentBox | null | undefined {
  const mem = memoryCache.get(url);
  if (mem !== undefined) return mem;
  const persistedValue = loadPersisted();
  if (Object.prototype.hasOwnProperty.call(persistedValue, url)) {
    return persistedValue[url];
  }
  return undefined;
}

/**
 * Synchronously read the cached content box for a URL (memory + persisted
 * localStorage). Returns the box, `null` if it was previously analyzed as
 * empty/unusable, or `undefined` if it hasn't been seen yet. Use this to seed
 * state before first render so already-corrected logos render trimmed with no
 * post-load "snap".
 */
export function getCachedLogoContentBox(url?: string | null): LogoContentBox | null | undefined {
  if (!url) return undefined;
  return getCached(url);
}

function setCached(url: string, box: LogoContentBox | null) {
  memoryCache.set(url, box);
  const map = loadPersisted();
  if (map[url] !== box) {
    if (Object.keys(map).length >= MAX_PERSISTED) {
      // Evict ~25% of oldest keys to bound storage growth
      const keys = Object.keys(map);
      for (let i = 0; i < Math.floor(keys.length * 0.25); i++) {
        delete map[keys[i]];
      }
    }
    map[url] = box;
    schedulePersist();
  }
}

function loadDimsPersisted(): Record<string, LogoDims> {
  if (dimsPersistedLoaded) return dimsPersisted;
  dimsPersistedLoaded = true;
  try {
    const raw = localStorage.getItem(DIMS_STORAGE_KEY);
    dimsPersisted = raw ? JSON.parse(raw) : {};
  } catch {
    dimsPersisted = {};
  }
  return dimsPersisted;
}

function scheduleDimsPersist() {
  if (dimsPersistTimer) return;
  dimsPersistTimer = setTimeout(() => {
    dimsPersistTimer = null;
    try {
      localStorage.setItem(DIMS_STORAGE_KEY, JSON.stringify(dimsPersisted));
    } catch {
      // Storage full or unavailable — keep in-memory only
    }
  }, 2000);
}

/**
 * Synchronously read the cached natural image dimensions for a URL (memory +
 * persisted localStorage). Returns `undefined` if not known yet. Lets the
 * smart-trim layout apply the cached correction before the image has decoded.
 */
export function getCachedLogoDims(url?: string | null): LogoDims | undefined {
  if (!url) return undefined;
  const mem = dimsMemoryCache.get(url);
  if (mem) return mem;
  return loadDimsPersisted()[url];
}

function setCachedDims(url: string, dims: LogoDims) {
  dimsMemoryCache.set(url, dims);
  const map = loadDimsPersisted();
  const prev = map[url];
  if (!prev || prev.w !== dims.w || prev.h !== dims.h) {
    if (Object.keys(map).length >= MAX_PERSISTED) {
      const keys = Object.keys(map);
      for (let i = 0; i < Math.floor(keys.length * 0.25); i++) {
        delete map[keys[i]];
      }
    }
    map[url] = dims;
    scheduleDimsPersist();
  }
}

/**
 * Whether two boxes disagree enough to be worth replacing the cached one.
 * Anti-aliasing and down-sampling move a box by a pixel or two, which is not a
 * disagreement; anything larger means one of the two measured a different image
 * (or a partially decoded one).
 */
function boxesMeaningfullyDiffer(a: LogoContentBox, b: LogoContentBox): boolean {
  const DELTA = 0.02;
  return (
    Math.abs(a.l - b.l) > DELTA ||
    Math.abs(a.t - b.t) > DELTA ||
    Math.abs(a.r - b.r) > DELTA ||
    Math.abs(a.b - b.b) > DELTA
  );
}

/**
 * Whether a cached box should be re-measured on this mount.
 *
 * Every box is re-measured once per session against the image actually being
 * displayed, then trusted for the rest of the session. The cache is keyed by URL
 * and outlives the bytes that produced it, and a wrong box is not cosmetic:
 * Smart Trim zooms the logo to whatever the box claims is content and offsets it
 * by where the box says that content starts, so a box covering only part of the
 * artwork draws the logo oversized, cropped, and off-centre — with the tile's
 * padding setting invisible under the zoom. Measuring an already-loaded image
 * costs one small canvas scan, so the box a logo renders with always reflects
 * the image on screen, not a measurement from an older copy of it.
 */
export function shouldRecheckCachedBox(alreadyVerified: boolean): boolean {
  return !alreadyVerified;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image load failed'));
    img.src = src;
  });
}

/**
 * Compute the bounding box of opaque pixels. Throws on cross-origin tainted
 * canvases (caller falls back to the fetch proxy in that case).
 */
/**
 * Measure an image once it is fully decoded, so the scan can never run against
 * a partially painted copy (which reads as transparent and yields a box that
 * covers only the decoded part of the logo).
 */
async function measureImage(img: HTMLImageElement): Promise<LogoContentBox | null> {
  if (img.naturalWidth > 0 && typeof img.decode === 'function') {
    try {
      await img.decode();
    } catch {
      // decode() rejects on broken/aborted images; fall through and try anyway.
    }
  }
  try {
    return computeContentBox(img);
  } catch {
    return null; // cross-origin tainted canvas — caller falls back to the proxy
  }
}

function computeContentBox(img: HTMLImageElement): LogoContentBox | null {
  const nW = img.naturalWidth;
  const nH = img.naturalHeight;
  if (!nW || !nH) return null;

  const scale = Math.min(1, MAX_ANALYSIS_DIM / Math.max(nW, nH));
  const cw = Math.max(1, Math.round(nW * scale));
  const ch = Math.max(1, Math.round(nH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, cw, ch);
  const { data } = ctx.getImageData(0, 0, cw, ch);

  let minX = -1;
  let minY = -1;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (data[(y * cw + x) * 4 + 3] < ALPHA_THRESHOLD) continue;
      if (minX === -1 || x < minX) minX = x;
      if (maxX === -1 || x > maxX) maxX = x;
      if (minY === -1 || y < minY) minY = y;
      if (maxY === -1 || y > maxY) maxY = y;
    }
  }

  if (minX === -1) return null;

  // Safety margin so faint drop-shadows / anti-aliasing are not cut flush.
  const margin = SAFETY_MARGIN;
  const l = Math.max(0, minX / (cw - 1) - margin);
  const t = Math.max(0, minY / (ch - 1) - margin);
  const r = Math.min(1, maxX / (cw - 1) + margin);
  const b = Math.min(1, maxY / (ch - 1) + margin);

  return { l, t, r, b };
}

/**
 * Fetch logo bytes via the Tauri fetch proxy (bypasses CORS) and analyze them
 * from a same-origin blob URL. Falls back gracefully.
 */
async function analyzeFromUrl(url: string): Promise<{ box: LogoContentBox | null; w: number; h: number } | null> {
  if (pendingFetches >= MAX_CONCURRENT_FETCHES) return null;
  if (typeof window === 'undefined' || !window.fetchProxy?.fetchBinary) return null;

  pendingFetches++;
  try {
    const res = await window.fetchProxy.fetchBinary(url, { timeout: 10000 });
    if (!res?.success || !res.data) return null;
    const bytes = res.data.buffer.slice(
      res.data.byteOffset,
      res.data.byteOffset + res.data.byteLength
    ) as ArrayBuffer;
    const blob = new Blob([bytes]);
    const objectUrl = URL.createObjectURL(blob);
    try {
      const img = await loadImage(objectUrl);
      // Measure through the same decoded-image path as the in-page case: a scan
      // started before the image is fully decoded reads the undecoded part as
      // transparent and stores a box that covers only what had painted.
      return { box: await measureImage(img), w: img.naturalWidth, h: img.naturalHeight };
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } catch {
    return null;
  } finally {
    pendingFetches--;
  }
}

/**
 * Get the opaque content box for a logo URL, or `null` when it can't be
 * determined (fully transparent image, cross-origin without proxy, etc.).
 * `loadedImg` (optional) lets us reuse the already-fetched <img> element for
 * same-origin / CORS-enabled logos; otherwise we fall back to the Tauri fetch
 * proxy. Cached results return immediately.
 */
export async function getLogoContentBox(
  url: string,
  loadedImg?: HTMLImageElement
): Promise<LogoContentBox | null> {
  const cached = getCached(url);
  if (cached !== undefined) {
    // Ensure dimensions are cached alongside an existing content box so the
    // layout can apply trim before the image decodes on future mounts.
    if (loadedImg && loadedImg.complete && loadedImg.naturalWidth > 0) {
      const existingDims = getCachedLogoDims(url);
      if (!existingDims || existingDims.w !== loadedImg.naturalWidth || existingDims.h !== loadedImg.naturalHeight) {
        setCachedDims(url, { w: loadedImg.naturalWidth, h: loadedImg.naturalHeight });
      }

      // A cached box is a hint, not the truth — see shouldRecheckCachedBox.
      // Re-measure it once per session against the image we are displaying, so a
      // box recorded from a partial or older copy of the image can't keep
      // zooming, cropping and offsetting the logo.
      const alreadyVerified = boxesVerifiedThisSession.has(url);
      boxesVerifiedThisSession.add(url);
      if (shouldRecheckCachedBox(alreadyVerified)) {
        const fresh = await measureImage(loadedImg);
        if (fresh && (!cached || boxesMeaningfullyDiffer(fresh, cached))) {
          setCached(url, fresh);
          return fresh;
        }
      }
    }
    return cached;
  }

  const existing = inFlight.get(url);
  if (existing) return existing;

  const promise = (async () => {
    let box: LogoContentBox | null = null;
    let w = 0;
    let h = 0;

    if (loadedImg && loadedImg.complete && loadedImg.naturalWidth > 0) {
      box = await measureImage(loadedImg);
      if (box !== null) {
        w = loadedImg.naturalWidth;
        h = loadedImg.naturalHeight;
      }
    }

    if (box === null) {
      const res = await analyzeFromUrl(url);
      if (res) {
        box = res.box;
        w = res.w;
        h = res.h;
      }
    }

    if (box !== null && w > 0 && h > 0) {
      setCachedDims(url, { w, h });
    }
    setCached(url, box);
    inFlight.delete(url);
    return box;
  })();

  inFlight.set(url, promise);
  return promise;
}
