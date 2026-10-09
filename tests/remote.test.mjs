// web/remote.js: swisstopo URLs are routed through the caching proxy, and the hosts it can produce
// are exactly the ones serve.py and the nginx deployment proxy.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, describe, test } from 'node:test';
import { ROOT } from './_lib.mjs';

let remote;
let healthStatus = 204;
before(async () => {
  // remote.js resolves geo/ against location.href at import time and probes geo/health with fetch.
  globalThis.location = { href: 'http://localhost:8000/app/index.html' };
  globalThis.fetch = async (url) => {
    assert.equal(url, 'http://localhost:8000/app/geo/health');
    if (healthStatus === 'throw') throw new TypeError('network error');
    return { status: healthStatus };
  };
  remote = await import('../web/remote.js');
});

const SAMPLES = [
  ['https://vectortiles.geo.admin.ch/styles/ch.swisstopo.basemap.vt/style.json', 'vectortiles.geo.admin.ch/styles/ch.swisstopo.basemap.vt/style.json'],
  ['https://vectortiles3.geo.admin.ch/tiles/v1/7/66/45.pbf', 'vectortiles.geo.admin.ch/tiles/v1/7/66/45.pbf'],
  ['https://wmts9.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/12/2138/1446.jpeg', 'wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/12/2138/1446.jpeg'],
  ['https://3d.geo.admin.ch/ch.swisstopo.terrain.3d/v1/layer.json', '3d.geo.admin.ch/ch.swisstopo.terrain.3d/v1/layer.json'],
  ['https://api3.geo.admin.ch/rest/services/ech/SearchServer?searchText=Bern&type=locations', 'api3.geo.admin.ch/rest/services/ech/SearchServer?searchText=Bern&type=locations'],
];
const PASSTHROUGH = [
  'https://example.com/tile.png',
  'http://vectortiles.geo.admin.ch/insecure', // only https URLs are rewritten
  'https://data.geo.admin.ch/ch.bakom.standorte-mobilfunkanlagen/x.json', // not a proxied service
  'https://vectortiles.geo.admin.ch.evil.example/x',
  'data/meta.json',
];

describe('remote.js', () => {
  test('without the proxy every URL passes through', async () => {
    healthStatus = 'throw';
    assert.equal(await remote.detectProxy(), false);
    for (const [url] of SAMPLES) assert.equal(remote.geoUrl(url), url);
    healthStatus = 404;
    assert.equal(await remote.detectProxy(), false);
  });

  test('with the proxy, swisstopo URLs (and their numbered shards) map to geo/<main host>/<path>', async () => {
    healthStatus = 204;
    assert.equal(await remote.detectProxy(), true);
    for (const [url, rest] of SAMPLES) {
      assert.equal(remote.geoUrl(url), `http://localhost:8000/app/geo/${rest}`);
      assert.deepEqual(remote.transformRequest(url), { url: `http://localhost:8000/app/geo/${rest}` });
    }
    for (const url of PASSTHROUGH) {
      assert.equal(remote.geoUrl(url), url);
      assert.equal(remote.transformRequest(url), undefined);
    }
  });

  test('every host remote.js can produce is proxied by serve.py and by the nginx deployment', () => {
    const src = readFileSync(`${ROOT}web/remote.js`, 'utf8');
    const prefixes = src.match(/\^https:\\\/\\\/\(([a-z0-9|]+)\)/)[1].split('|');
    const servePy = readFileSync(`${ROOT}serve.py`, 'utf8');
    const geoHosts = new Set([...servePy.match(/GEO_HOSTS = \{([^}]*)\}/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
    const nginx = readFileSync(`${ROOT}deploy/nginx-locations.conf`, 'utf8');
    const nginxPrefixes = nginx.match(/geo\/\(([a-z0-9|]+)\)\\\.geo\\\.admin\\\.ch/)[1].split('|');
    assert.deepEqual(new Set(prefixes.map((p) => `${p}.geo.admin.ch`)), geoHosts);
    assert.deepEqual(new Set(nginxPrefixes), new Set(prefixes));
  });
});
