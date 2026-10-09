// Blurs the smooth heatmap's layers off the main thread (about 0.5 s on a laptop, several seconds on a
// phone), so the map stays responsive; app.js colours the result. See computeSmooth() in app.js.

import { blurSurface } from './smooth.js';

let centres = null; // hectare centres {E, N} (LV95), sent once

self.onmessage = ({ data }) => {
  if (data.centres) { centres = data.centres; return; }
  const { id, layers, bbox, sigma } = data;
  const { E, N } = centres;
  const surface = blurSurface({ n: E.length, E: (i) => E[i], N: (i) => N[i] }, layers, bbox, sigma);
  self.postMessage({ id, surface }, Object.keys(layers).map((name) => surface[name].buffer));
};
