# Swiss atlas

An interactive map of Switzerland at hectare resolution (100 × 100 m). It shows where people live, from the Federal Statistical Office's STATPOP 2024 data (31 Dec 2024), and where the mobile antenna sites are, from OFCOM, on swisstopo basemaps.

**Live map:** https://arman-maghsoudnia.github.io/swiss-atlas/

# Data sources and terms of use

The repo includes only the data derived for the map (`web/data/`). To rebuild it, download the raw files as shown below. The derived files stay under their sources' terms, and the source must be cited wherever the data or the map is shown (the map does this in its credits).

- **Population**: STATPOP 2024 geodata, Federal Statistical Office (FSO), [catalogue page](https://www.bfs.admin.ch/bfs/en/home/statistics/catalogues-databases.assetdetail.36171301.html). Terms: open use, source must be cited — "STATPOP2024, FSO GEOSTAT".
  ```sh
  curl -L -o ag-b-00.03-vz2024statpop.zip https://dam-api.bfs.admin.ch/hub/api/dam/assets/36171301/master
  unzip ag-b-00.03-vz2024statpop.zip -d ag-b-00.03-vz2024statpop   # -> ag-b-00.03-vz2024statpop/STATPOP2024.csv
  ```
- **Antenna sites**: OFCOM layer `ch.bakom.standorte-mobilfunkanlagen` (see [AntennaLocation/README.md](AntennaLocation/README.md)). Terms: open use, source must be cited — "Federal Office of Communications OFCOM". The snapshot in `web/data/` has 22,238 sites: Swisscom, Salt, Sunrise, SBB (railway GSM-R) and 20 German-network 2G sites near the border. Each site is placed at its first mast. The operators supply the data and OFCOM does not guarantee its accuracy. OFCOM updates the file regularly, so a new download gives slightly different numbers.
  ```sh
  curl -L -o AntennaLocation/standorte-mobilfunkanlagen_2056.json https://data.geo.admin.ch/ch.bakom.standorte-mobilfunkanlagen/standorte-mobilfunkanlagen/standorte-mobilfunkanlagen_2056.json
  ```
- **Basemaps, terrain, search and commune names**: swisstopo / geo.admin.ch services, fetched at runtime and never stored in the repo. Terms: free use with the source cited ("© swisstopo"), subject to the geo.admin.ch [terms of use](https://www.geo.admin.ch/en/general-terms-of-use-fsdi) and fair-use limits.
- **Libraries** in `web/vendor/` keep their own licenses (MIT, BSD-3-Clause, Apache-2.0); see [web/vendor/README.md](web/vendor/README.md).

After downloading, run `python3 serve.py --rebuild`. Without `--rebuild`, `serve.py` only rebuilds when a source is newer than `web/data`, and `unzip` keeps the archive's 2025 file dates.

# Run it

```sh
python3 serve.py            # builds web/data when missing or older than its sources, serves http://localhost:8000, opens the browser
python3 serve.py --port 9000 --no-browser
python3 serve.py --rebuild  # force a rebuild of web/data
```

Only Python 3 is needed (standard library). The map libraries are bundled in `web/vendor/`. `serve.py` proxies swisstopo's basemaps, terrain, search and commune lookups and caches them in `.cache/geo/` (see *Offline resilience*), so you only need an internet connection for areas you haven't viewed before.

# Hosting on GitHub Pages

`.github/workflows/pages.yml` publishes `web/` to GitHub Pages on every push to `main`. It is skipped while the repository is private, because a Pages site is always public. Enable it once under *Settings → Pages → Source: GitHub Actions*. The Pages site has no password and no caching proxy, so browsers load swisstopo's maps directly, as swisstopo's terms allow.

# Deployment (nginx)

`deploy/` publishes the app through an existing nginx at `http://<server>/swiss-population-grid/`. It asks for a shared password on the first visit, and the sign-in is then remembered in that browser for a year.

- Requirements: nginx with the `auth_request` module, a port-80 default server in `/etc/nginx/conf.d/default.conf` (as in the nginx.org packages) and the `www-data` user.
- Clone the repo to `/var/www/swiss-population-grid`. nginx serves `web/` as static files, so there is no app process to keep running.
- To update, run `git -C /var/www/swiss-population-grid pull` on the server. Changes show up on the next page load. Re-run `sudo deploy/install.sh` when a commit changes anything in `deploy/`, and press Enter at the prompt to keep the current password.
- nginx also runs the swisstopo caching proxy (`/swiss-population-grid/geo/…`, see *Offline resilience*); `deploy/install.sh` sets it up together with the login.
- Login: `deploy/login.html` sets a cookie with SHA-256(`"spg-v1:" + password`), and nginx compares it with the hash in `/etc/nginx/conf.d/swiss-population-grid.conf`. Neither the password nor its hash is stored in the repo. Requests without a valid cookie are limited to 20 per minute per IP.
- To install or change the password, run `sudo deploy/install.sh` on the server from the clone. It is idempotent, and changing the password signs everyone out. Use a long random passphrase: the cookie is a fast, unsalted hash, so whoever captures it can try passwords offline. It installs the login page to `/var/www/swiss-population-grid-login/` and the locations to `/etc/nginx/snippets/swiss-population-grid.conf`. It also adds one `include` line to `/etc/nginx/conf.d/default.conf`, after making a timestamped backup.
- This is plain HTTP, so the password and cookie cross the network unencrypted. Treat it as a gate against casual access, not as strong security.

# What's in the map

- **Colour by**: residents or households per hectare, nationality, place of birth, age (average age, 0–19, 20–64, 65+, 80+), share of women, mobility (newcomers, long-standing residents, moved from abroad/another canton), household size, single-person households, or **any of the 77 published attributes** (as a count or as a share of residents or households).
- **Zoom-dependent resolution**: 100 m hectares when zoomed in. When zoomed out, the map shows 200 m – 2 km blocks, because a hectare is smaller than a pixel there. Shares and averages are computed over each block; counts show the average per inhabited hectare, so colours stay comparable across zoom levels.
- **Legend**: fixed classes for residents, households and women, rounded quantile classes otherwise, each with its number of hectares. Click a class to show only that class.
- **View**: *Flat*, *Columns* (extruded, height = residents) or *Terrain*. Terrain drapes everything over swisstopo's 3D relief (swissALTI3D, via the `maplibre-gl-3dtiles-terrain` plugin), with a relief-exaggeration slider. In terrain mode, the population is drawn as map tiles on demand from the same data and classes, choosing the grid size from each tile's zoom, so distant areas use coarser blocks. The smooth heatmap is draped too. Antennas, the selected hectare and the radius circle sit on the terrain. Right-drag or Ctrl + drag to tilt and turn.
- **Click a hectare**: commune name (from geo.admin.ch), age–sex pyramid, nationality, place of birth, time in the commune, residence a year ago, and household sizes. You can also summarise everything **within a radius** (500 m – 20 km) or **in the current map view**.
- **Search**: places, postcodes and addresses (geo.admin.ch search API). Picking an address selects its hectare.
- **Smooth heatmap** (View → *Smooth heatmap*): turns the grid into a continuous surface with a Gaussian kernel (σ from 100 m to 5 km). Rates are kernel-weighted, i.e. smoothed numerator ÷ smoothed denominator, so small cells don't weigh like big ones. Counts are the average per inhabited hectare. The surface fades out where few hectares are inhabited, and it is computed on a 100 m raster (200/500 m for large σ) in about 1 s.
- **Antenna sites**: toggle the layer, filter by operator, technology (offers 5G/4G/3G/2G) and type (outdoor > 6 W, small cells, tunnel). Colour by operator, technology or type (shapes repeat the category), and size markers by power class. Hover or click a site for its type, technology, power, permit and limit value, the residents within 500 m / 1 km, and a radius summary around it.
- **Distance to the nearest antenna site** (Colour by → Antennas): straight-line distance from each hectare to the nearest site that passes the filters, e.g. distance to the nearest Salt 5G site.
- **Antennas vs population** panel: residents per site; the population-weighted distance to the nearest site (median, 90th percentile, share within 500 m / 1 km, and a cumulative curve); the share of sites on uninhabited hectares; the Spearman/Pearson correlation between residents and sites per cell at 500 m – 10 km; and a scatter plot of residents vs sites per cell. Hovering a point outlines its cell on the map, and clicking flies there. Everything follows the antenna filters and the *Exclude unlocated residents* toggle.
- **Basemaps** (swisstopo, free, no key): aerial imagery (SWISSIMAGE) with or without labels, the national map in colour or grey, a light map and a standard map. A *Dim basemap* slider makes the data stand out on imagery.

# Offline resilience (local copies of swisstopo data)

The app never calls swisstopo or a CDN directly when served by `serve.py` or the nginx deployment:

- **Libraries** (MapLibre, deck.gl, terrain plugin, quantized-mesh decoder) are in `web/vendor/`, pinned. Versions and licenses are in `web/vendor/README.md`.
- **swisstopo requests** go through a caching proxy at `geo/<host>/<path>`, set up in `web/remote.js`. This covers basemap styles and tiles, sprites and fonts, terrain, search and commune lookups. Numbered shard hosts such as `vectortiles3` share the main host's cache entries.
  - A copy is reused for 7 days, then refreshed. If swisstopo is unreachable, throttles (429) or refuses (403, 5xx), the last good copy is served until swisstopo answers again.
  - Only something never fetched before can fail.
  - Locally the cache is `.cache/geo/` (gitignored). With the nginx deployment it is `proxy_cache` in `/var/cache/nginx/swiss-population-grid`, capped at 20 GB, with unused entries kept for a year.
  - The proxy only talks to `vectortiles`, `wmts`, `3d` and `api3.geo.admin.ch`, and in the nginx deployment it sits behind the login.
- Opened from a plain static server without the proxy, the app falls back to requesting swisstopo directly.

# Caveats (from the FSO data description)

- **Data protection**: every value from 1 to 3 is published as **3**. Summing hectares therefore overstates totals: the grid sums to 9,123,704 residents, while the commune file sums to 9,051,029. Rates on small cells are noisy, so the map greys out cells below a minimum population (default 10, adjustable).
- **Unlocated residents**: 53,619 people whose building has no coordinates are placed on the hectare at their commune's centre (listed in `STATPOP2024_NOLOC.csv`). This creates false peaks, which you can remove with *Exclude unlocated residents*.
- **Correlation depends on the grid size.** With the default filters, Spearman ρ between residents and sites per cell is about 0.17 at 500 m, 0.33 at 1 km, 0.53 at 2 km, 0.81 at 5 km and 0.91 at 10 km. Cells with neither residents nor sites are excluded. About half of all sites stand on hectares without residents (hills, roads, commercial buildings), and distance to a site is not signal coverage.
- Coordinates are the LV95 south-west corner of each hectare. They are converted to WGS84 with swisstopo's approximate formulas, accurate to about 1 m.

# Layout

```
scripts/build_data.py      STATPOP CSV -> web/data/cells.bin.gz (gzipped uint16 columns) + meta.json
scripts/build_antennas.py  OFCOM GeoJSON -> web/data/antennas.json (column arrays)
serve.py                   builds if needed, serves web/ on localhost
web/index.html             page shell
web/app.js                 main module: state, metrics, classification, map layers, panels, search
web/antennas.js            antenna loading, filters, spatial index, nearest-site search, marker shapes
web/smooth.js              kernel smoothing (rasterise, Gaussian blur, georeferenced tiles)
web/analysis.js            correlation statistics, distance curve and scatter chart
web/terrain.js             swisstopo terrain, on-demand population tiles for draping, antenna marker images
web/remote.js              routes swisstopo URLs through the caching proxy when it is available
web/geo.js                 LV95 <-> WGS84
web/vendor/                pinned third-party libraries (see its README)
web/style.css              styles (light/dark follow the OS setting)
deploy/                    nginx + password login for a server deployment (install.sh, login.html, nginx-locations.conf)
```

# License

Copyright (C) 2026 Arman Maghsoudnia.

The code in this repository is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only). You may use, modify and share it, but if you distribute a modified version or run one as a website or other network service, you must make its complete source code available to its users under the same license.

Not covered by this license:
- `web/vendor/`: third-party libraries under their own licenses (MIT, BSD-3-Clause, Apache-2.0), see [web/vendor/README.md](web/vendor/README.md).
- `web/data/`: derived from FSO and OFCOM data, which remain under their terms of use (see *Data sources and terms of use* above).

For use without the AGPL obligations, for example in a closed-source or commercial product, commercial licenses are available on request from [Arman Maghsoudnia](https://github.com/arman-maghsoudnia).
