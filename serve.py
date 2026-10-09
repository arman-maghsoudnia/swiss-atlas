#!/usr/bin/env python3
"""Serve the population map on http://localhost:8000.

Builds web/data first if it is missing or older than its sources
(STATPOP CSV -> cells.bin.gz, OFCOM antenna GeoJSON -> antennas.json).

swisstopo services (basemap styles and tiles, terrain, search, commune lookup) are proxied under
/geo/<host>/<path> with an on-disk cache in .cache/geo: copies are refreshed when they expire, and
served stale while swisstopo is unreachable, rate-limits or blocks us.

Usage: python3 serve.py [--port 8000] [--no-browser] [--rebuild]
"""

import argparse
import functools
import hashlib
import http.client
import http.server
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
CACHE = ROOT / ".cache" / "geo"
BUILDS = [  # (output, source, build script)
    (WEB / "data" / "cells.bin.gz", ROOT / "ag-b-00.03-vz2024statpop" / "STATPOP2024.csv", "build_data.py"),
    (WEB / "data" / "antennas.json", ROOT / "AntennaLocation" / "standorte-mobilfunkanlagen_2056.json", "build_antennas.py"),
]

GEO_HOSTS = {"vectortiles.geo.admin.ch", "wmts.geo.admin.ch", "3d.geo.admin.ch", "api3.geo.admin.ch"}
FRESH_OK = 7 * 86400      # a cached 200 is used without asking swisstopo for a week
FRESH_MISSING = 86400     # "no such tile" (403/404; swisstopo's terrain answers 403) for a day
UPSTREAM_TIMEOUT = 10
RETRY_AFTER = 60          # after swisstopo failed or throttled us, serve cached copies for a minute without asking


class GeoCache:
    """URL -> (meta, body) on disk, one file per URL (a JSON line, then the body). Writes are atomic,
    so concurrent requests never see half a file or a body with another response's headers."""

    def __init__(self, root):
        self.root = root

    def _path(self, url):
        key = hashlib.sha256(url.encode()).hexdigest()
        return self.root / key[:2] / f"{key}.entry"

    def get(self, url):
        try:
            head, _, body = self._path(url).read_bytes().partition(b"\n")
            return json.loads(head), body
        except (OSError, ValueError):
            return None

    def put(self, url, meta, body):
        path = self._path(url)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        tmp.write_bytes(json.dumps(meta).encode() + b"\n" + body)
        os.replace(tmp, path)


def fetch_upstream(url, accept):
    """(status, headers, body) from swisstopo, or None if it could not be reached at all."""
    req = urllib.request.Request(url, headers={
        "User-Agent": "swiss-population-grid (local cache)",
        "Accept": accept or "*/*",
        "Accept-Encoding": "gzip",  # stored and passed on as-is, with its Content-Encoding
    })
    try:
        try:
            with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT) as res:
                return res.status, res.headers, res.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()
    # OSError covers URLError and timeouts; HTTPException a connection dropped mid-body;
    # ValueError a path that is not a valid URL (control or non-ASCII characters).
    except (OSError, http.client.HTTPException, ValueError):
        return None


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".gz": "application/octet-stream",  # decoded in the browser, never as Content-Encoding
        ".js": "text/javascript",
    }
    geo_cache = GeoCache(CACHE)
    retry_at = {}  # host -> time before which swisstopo is not asked again when a cached copy exists

    def end_headers(self):
        if not self.path.startswith("/geo/"):
            self.send_header("Cache-Control", "no-cache")  # always revalidate, so rebuilt data shows up
        super().end_headers()

    def log_message(self, fmt, *args):
        # Successful requests are not logged. args[1] is the status code for request lines only;
        # log_error ("Request timed out: %r", e) passes a single argument.
        if len(args) < 2 or not str(args[1]).startswith(("2", "3")):
            super().log_message(fmt, *args)

    def do_GET(self):
        if self.path.startswith("/geo/"):
            return self.proxy_geo()
        return super().do_GET()

    def proxy_geo(self):
        rest = self.path[len("/geo/"):]
        if rest == "health":
            self.send_response(204)
            self.end_headers()
            return
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            self.send_error(403, "Only for this app's own pages")  # other websites must not fill the cache
            return
        host, _, tail = rest.partition("/")
        if host not in GEO_HOSTS:
            self.send_error(404, "Unknown upstream")
            return
        url = f"https://{host}/{tail}"
        cached = self.geo_cache.get(url)
        if cached:
            meta = cached[0]
            ttl = FRESH_OK if meta["status"] == 200 else FRESH_MISSING
            if time.time() - meta["fetched"] < ttl:
                return self.send_geo(meta, cached[1], "HIT")
            if time.time() < self.retry_at.get(host, 0):
                return self.send_geo(meta, cached[1], "STALE")

        got = fetch_upstream(url, self.headers.get("Accept"))
        status = got[0] if got else None
        if status is None or status == 429 or status >= 500:
            self.retry_at[host] = time.time() + RETRY_AFTER
        has_good_copy = cached is not None and cached[0]["status"] == 200
        if status == 200 or (status in (403, 404) and not has_good_copy):
            headers, body = got[1], got[2]
            meta = {"status": status, "fetched": time.time(),
                    "type": headers.get("Content-Type", "application/octet-stream"),
                    "encoding": headers.get("Content-Encoding")}
            self.geo_cache.put(url, meta, body)
            return self.send_geo(meta, body, "MISS")
        if cached:  # unreachable, throttled (429), blocked (403 after a good copy) or 5xx
            return self.send_geo(cached[0], cached[1], "STALE")
        if got:
            return self.send_geo({"status": status, "type": got[1].get("Content-Type", "text/plain"),
                                  "encoding": got[1].get("Content-Encoding")}, got[2], "BYPASS")
        self.send_error(502, "swisstopo unreachable and nothing cached")

    def send_geo(self, meta, body, cache_state):
        self.send_response(meta["status"])
        self.send_header("Content-Type", meta["type"])
        if meta.get("encoding"):
            self.send_header("Content-Encoding", meta["encoding"])
        self.send_header("Content-Length", str(len(body)))
        # Errors must not stick in the browser cache: the next request may well succeed.
        self.send_header("Cache-Control", {200: "public, max-age=86400", 403: "public, max-age=3600",
                                           404: "public, max-age=3600"}.get(meta["status"], "no-store"))
        self.send_header("X-Cache", cache_state)
        try:
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the map cancelled the request (panned or zoomed away); the copy is cached anyway


class Server(http.server.ThreadingHTTPServer):
    request_queue_size = 128  # the map requests dozens of tiles at once; with the default 5, macOS resets connections


def needs_build(out, src, force):
    if not src.exists():
        return False  # nothing to build from; the page reports what is missing
    return force or not out.exists() or src.stat().st_mtime > out.stat().st_mtime


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--rebuild", action="store_true", help="rebuild web/data even if it is up to date")
    args = ap.parse_args()

    for out, src, script in BUILDS:
        if needs_build(out, src, args.rebuild):
            subprocess.run([sys.executable, str(ROOT / "scripts" / script)], check=True)

    handler = functools.partial(Handler, directory=str(WEB))
    server = Server(("127.0.0.1", args.port), handler)
    url = f"http://localhost:{args.port}/"
    print(f"Serving {WEB} at {url}  (Ctrl+C to stop); swisstopo cache in {CACHE}")
    if not args.no_browser:
        threading.Timer(0.5, webbrowser.open, [url]).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
