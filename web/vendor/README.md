# Vendored libraries

Served from here so the app does not depend on a CDN at runtime. Pinned versions, unmodified
(except that the `sourceMappingURL` comment was removed from `maplibre-gl.js`, since the map file is not shipped).

| File | Package | Version | License |
|---|---|---|---|
| `maplibre-gl.js`, `maplibre-gl.css` | [maplibre-gl](https://www.npmjs.com/package/maplibre-gl) (`dist/`) | 5.24.0 | BSD-3-Clause (`LICENSE-maplibre-gl.txt`) |
| `deck.gl.min.js` | [deck.gl](https://www.npmjs.com/package/deck.gl) (`dist.min.js`) | 9.4.0 | MIT (`LICENSE-deck.gl.txt`) |
| `maplibre-gl-3dtiles-terrain.js` | [maplibre-gl-3dtiles-terrain](https://www.npmjs.com/package/maplibre-gl-3dtiles-terrain) (`src/index.js`) | 0.1.0 | BSD-3-Clause (`LICENSE-maplibre-gl-3dtiles-terrain.txt`) |
| `quantized-mesh-decoder.js` | [@here/quantized-mesh-decoder](https://www.npmjs.com/package/@here/quantized-mesh-decoder) (`src/index.js`) | 1.2.8 | MIT (`LICENSE-quantized-mesh-decoder.txt`) |

`deck.gl.min.js` also bundles [long.js](https://github.com/dcodeIO/long.js) (Apache-2.0, `LICENSE-Apache-2.0.txt`)
and [ieee754](https://github.com/feross/ieee754) (BSD-3-Clause); their notices are kept at the end of the file.

To update, download the same paths for the new version from `https://unpkg.com/<package>@<version>/…`.
