// 3D terrain from swisstopo and helpers to drape the app's data over it.
//
// swisstopo serves its terrain (from swissALTI3D) as Cesium quantized-mesh tiles; MapLibre only
// reads raster-dem. maplibre-gl-3dtiles-terrain resamples each requested tile into a terrarium
// raster-dem tile through a custom protocol. deck.gl layers are not draped by MapLibre's terrain,
// so in terrain mode the population is served as raster tiles (drawn on demand from our data)
// and antennas become a MapLibre symbol layer; both follow the relief.

import { SHAPES } from './antennas.js';
import { geoUrl } from './remote.js';

const PLUGIN = './vendor/maplibre-gl-3dtiles-terrain.js';
const DECODER = './vendor/quantized-mesh-decoder.js';
const LAYER_JSON = 'https://3d.geo.admin.ch/ch.swisstopo.terrain.3d/v1/layer.json';
// Extent of swisstopo's terrain (Switzerland plus a margin into neighbouring countries).
const BOUNDS = { west: 5.6, south: 45.5, east: 11.0, north: 48.2 };

let terrainSpec = null;
export async function terrainSource() {
  if (terrainSpec) return terrainSpec;
  const [{ loadQuantizedMeshDataset, registerQuantizedMeshTerrain }, { default: decode }] =
    await Promise.all([import(PLUGIN), import(DECODER)]);
  const dataset = await loadQuantizedMeshDataset(geoUrl(LAYER_JSON), { // tile URLs follow layer.json's location
    attribution: '<a href="https://www.swisstopo.admin.ch/en/height-model-swissalti3d" target="_blank" rel="noopener">Terrain © swisstopo</a>',
    boundsOverride: BOUNDS,
    maxZoom: 14, // ~10 m grid; deeper zooms overscale
  });
  // Outside the dataset the plugin fades to a constant height; ~500 m suits the lowlands around CH.
  terrainSpec = registerQuantizedMeshTerrain(maplibregl, { dataset, decode, fallbackHeight: 500 }).sourceSpec;
  return terrainSpec;
}

/**
 * Serve 256 px raster tiles drawn by draw(z, x, y, rgba) through a custom protocol.
 * Returns the tile URL template; append a version query to force a redraw.
 */
export function registerTileProtocol(name, draw) {
  maplibregl.addProtocol(name, async ({ url }) => {
    const [, z, x, y] = url.match(/:\/\/(\d+)\/(\d+)\/(\d+)/).map(Number);
    const img = new ImageData(256, 256);
    draw(z, x, y, img.data);
    return { data: await createImageBitmap(img) };
  });
  return `${name}://{z}/{x}/{y}`;
}

/** Centre of pixel (px, py) of Web-Mercator tile z/x/y, as [lon, lat]. */
export function tilePixelLngLat(z, x, y, px, py) {
  const n = 2 ** z;
  const lon = ((x + (px + 0.5) / 256) / n) * 360 - 180;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + (py + 0.5) / 256)) / n)));
  return [lon, lat];
}

/** Antenna marker images for a symbol layer: one per (shape, colour), with a surface-coloured ring. */
export function antennaImages(palette, ring) {
  const S = 44, images = [];
  SHAPES.forEach((shape, k) => {
    palette.forEach((color, c) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = S;
      const g = canvas.getContext('2d');
      const path = (inset) => {
        const a = inset, b = S - inset, m = S / 2;
        g.beginPath();
        if (shape === 'circle') g.arc(m, m, m - inset, 0, 2 * Math.PI);
        if (shape === 'square') g.rect(a + 3, a + 3, b - a - 6, b - a - 6);
        if (shape === 'triangle') { g.moveTo(m, a); g.lineTo(b, b - 4); g.lineTo(a, b - 4); g.closePath(); }
        if (shape === 'diamond') { g.moveTo(m, a); g.lineTo(b, m); g.lineTo(m, b); g.lineTo(a, m); g.closePath(); }
      };
      path(1); g.fillStyle = ring; g.fill();
      path(5); g.fillStyle = color; g.fill();
      images.push({ id: `ant-${k}-${c}`, data: g.getImageData(0, 0, S, S) });
    });
  });
  return { images, size: S };
}
