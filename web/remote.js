// swisstopo services are reached through our own server's caching proxy (geo/<host>/<path>) when
// it is available: the server keeps a copy of everything it fetched and serves that copy while
// swisstopo is unreachable or throttles us, refreshing it once swisstopo answers again.
// Without the proxy (e.g. a plain static file server) requests go straight to swisstopo.

// Numbered shards (vectortiles0–4, wmts0–9 …) serve identical content, so they share one cache entry.
const HOSTS = /^https:\/\/(vectortiles|wmts|3d|api3)\d*\.geo\.admin\.ch\/(.*)$/;
const BASE = new URL('geo/', location.href).href;
let enabled = false;

export async function detectProxy() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2000);
  try {
    const res = await fetch(`${BASE}health`, { cache: 'no-store', signal: ctl.signal });
    enabled = res.status === 204;
  } catch {
    enabled = false;
  } finally {
    clearTimeout(timer);
  }
  return enabled;
}

/** The URL to use for a swisstopo resource (proxied when possible); other URLs pass through. */
export function geoUrl(url) {
  if (!enabled) return url;
  const m = HOSTS.exec(url);
  return m ? `${BASE}${m[1]}.geo.admin.ch/${m[2]}` : url;
}

/** MapLibre transformRequest: style, tiles.json, tiles, sprites and glyphs all go through geoUrl. */
export function transformRequest(url) {
  const proxied = geoUrl(url);
  return proxied === url ? undefined : { url: proxied };
}
