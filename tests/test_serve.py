"""serve.py: the on-disk swisstopo cache, the caching proxy and the static file server.

The proxy runs in a real serve.Server on a free local port, with serve.fetch_upstream replaced
by a scripted fake, so nothing here talks to swisstopo.
"""

import functools
import gzip
import hashlib
import http.client
import io
import json
import os
import shutil
import tempfile
import threading
import time
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

from _support import ROOT, load_module

serve = load_module("serve", ROOT / "serve.py")

TILE = "/geo/vectortiles.geo.admin.ch/tiles/v1/7/66/45.pbf"
TILE_URL = "https://vectortiles.geo.admin.ch/tiles/v1/7/66/45.pbf"


def headers(**kw):
    """Upstream response headers, as urllib returns them (case-insensitive HTTPMessage)."""
    msg = http.client.HTTPMessage()
    for k, v in kw.items():
        msg[k.replace("_", "-")] = v
    return msg


def ok(body=b"tile", **kw):
    return 200, headers(Content_Type="application/x-protobuf", **kw), body


class FakeUpstream:
    """Stands in for serve.fetch_upstream: records calls, answers with `response`
    (a (status, headers, body) tuple, None for "unreachable", or an exception to raise)."""

    def __init__(self):
        self.calls = []
        self.response = ok()

    def __call__(self, url, accept):
        self.calls.append((url, accept))
        r = self.response
        if isinstance(r, BaseException):
            raise r
        return r


class GeoCacheTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="spg-cache-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cache = serve.GeoCache(self.tmp)

    def files(self):
        return sorted(p for p in self.tmp.rglob("*") if p.is_file())

    def test_round_trip(self):
        meta = {"status": 200, "fetched": 1234.5, "type": "image/png", "encoding": None}
        body = b"\x89PNG\r\n\x1a\n\x00binary\nwith\nnewlines\xff"
        self.cache.put(TILE_URL, meta, body)
        self.assertEqual(self.cache.get(TILE_URL), (meta, body))

    def test_single_file_format(self):
        meta = {"status": 404, "fetched": 1.0, "type": "text/plain", "encoding": "gzip"}
        self.cache.put(TILE_URL + "?a=1", meta, b"line1\nline2")
        key = hashlib.sha256((TILE_URL + "?a=1").encode()).hexdigest()
        self.assertEqual(self.files(), [self.tmp / key[:2] / f"{key}.entry"])
        raw = self.files()[0].read_bytes()
        head, _, body = raw.partition(b"\n")
        self.assertEqual(json.loads(head), meta)
        self.assertEqual(body, b"line1\nline2")

    def test_empty_body_and_overwrite(self):
        self.cache.put(TILE_URL, {"status": 200, "fetched": 1}, b"")
        self.assertEqual(self.cache.get(TILE_URL), ({"status": 200, "fetched": 1}, b""))
        self.cache.put(TILE_URL, {"status": 200, "fetched": 2}, b"new")
        self.assertEqual(self.cache.get(TILE_URL), ({"status": 200, "fetched": 2}, b"new"))
        self.assertEqual(len(self.files()), 1)

    def test_urls_do_not_collide(self):
        urls = [TILE_URL, TILE_URL + "?x", TILE_URL.replace("45", "46"), "https://wmts.geo.admin.ch/" + "a" * 2000]
        for k, url in enumerate(urls):
            self.cache.put(url, {"k": k}, str(k).encode())
        for k, url in enumerate(urls):
            self.assertEqual(self.cache.get(url), ({"k": k}, str(k).encode()))

    def test_missing_or_corrupt_entries_read_as_absent(self):
        self.assertIsNone(self.cache.get(TILE_URL))
        self.cache.put(TILE_URL, {"status": 200}, b"x")
        path = self.files()[0]
        for raw in (b"", b"not json\nbody", b"{\"status\": 2"):
            path.write_bytes(raw)
            self.assertIsNone(self.cache.get(TILE_URL), raw)

    def test_concurrent_writers_never_expose_a_mixed_entry(self):
        # Each writer stores a body together with its hash in the meta line; readers racing
        # with them must always see a matching pair (os.replace makes each write atomic).
        errors, stop = [], threading.Event()

        def writer(w):
            for k in range(60):
                body = f"writer {w} version {k} ".encode() * (50 + 37 * w)
                self.cache.put(TILE_URL, {"sha": hashlib.sha256(body).hexdigest()}, body)

        def reader():
            while not stop.is_set():
                got = self.cache.get(TILE_URL)
                if got and got[0]["sha"] != hashlib.sha256(got[1]).hexdigest():
                    errors.append("meta and body from different writes")

        readers = [threading.Thread(target=reader) for _ in range(2)]
        writers = [threading.Thread(target=writer, args=(w,)) for w in range(6)]
        for t in readers + writers:
            t.start()
        for t in writers:
            t.join()
        stop.set()
        for t in readers:
            t.join()
        self.assertEqual(errors, [])
        meta, body = self.cache.get(TILE_URL)
        self.assertEqual(meta["sha"], hashlib.sha256(body).hexdigest())
        self.assertEqual([p.suffix for p in self.files()], [".entry"], "temporary files left behind")


class ServerTestCase(unittest.TestCase):
    """A real serve.Server with a temporary web root and cache, and a fake upstream."""

    fake_upstream = True  # replace serve.fetch_upstream with a FakeUpstream

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="spg-serve-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.web = self.tmp / "web"
        (self.web / "data").mkdir(parents=True)
        (self.web / "index.html").write_text("<!doctype html><title>test</title>")
        (self.web / "app.js").write_text("export const x = 1;\n")
        (self.web / "data" / "cells.bin.gz").write_bytes(gzip.compress(b"\x00\x01" * 100))
        (self.web / "data" / "meta.json").write_text('{"n": 1}')

        self.cache = serve.GeoCache(self.tmp / "cache")
        # A subclass, so the cache and the back-off table are this test's own.
        self.handler = type("TestHandler", (serve.Handler,), {"geo_cache": self.cache, "retry_at": {}})
        self.upstream = FakeUpstream()
        if self.fake_upstream:
            patcher = mock.patch.object(serve, "fetch_upstream", self.upstream)
            patcher.start()
            self.addCleanup(patcher.stop)
        stderr = mock.patch("sys.stderr", new_callable=io.StringIO)  # the server logs errors there
        self.log = stderr.start()
        self.addCleanup(stderr.stop)
        self.start_server()

    def start_server(self):
        factory = functools.partial(self.handler, directory=str(self.web))
        server = serve.Server(("127.0.0.1", 0), factory)  # an ephemeral port (always >= 32768)
        if server.server_address[1] < 8900:
            server.server_close()
            server = next(s for s in self._ports_from(8900, factory) if s)
        self.server, self.port = server, server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        thread.start()

        def stop():
            server.shutdown()
            server.server_close()
            thread.join(5)

        self.addCleanup(stop)

    @staticmethod
    def _ports_from(first, factory):
        for port in range(first, first + 100):
            try:
                yield serve.Server(("127.0.0.1", port), factory)
            except OSError:
                yield None

    def get(self, path, **hdrs):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request("GET", path, headers={k.replace("_", "-"): v for k, v in hdrs.items()})
            res = conn.getresponse()
            return res.status, res.headers, res.read()
        finally:
            conn.close()

    def seed(self, url=TILE_URL, status=200, age=30 * 86400, body=b"cached tile", type_="application/x-protobuf"):
        """Put an entry fetched `age` seconds ago into the cache."""
        self.cache.put(url, {"status": status, "fetched": time.time() - age, "type": type_, "encoding": None}, body)


class ProxyRoutingTest(ServerTestCase):
    def test_health(self):
        status, h, body = self.get("/geo/health")
        self.assertEqual((status, body), (204, b""))
        self.assertEqual(self.get("/geo/health", Sec_Fetch_Site="cross-site")[0], 204)
        self.assertEqual(self.upstream.calls, [])

    def test_cross_site_requests_are_refused(self):
        self.assertEqual(self.get(TILE, Sec_Fetch_Site="cross-site")[0], 403)
        self.assertEqual(self.upstream.calls, [])
        for site in ("same-origin", "same-site", "none"):
            self.assertEqual(self.get(TILE, Sec_Fetch_Site=site)[0], 200, site)

    def test_unknown_hosts_are_not_proxied(self):
        for path in ("/geo/example.com/x", "/geo/vectortiles3.geo.admin.ch/x",  # shards are mapped by remote.js
                     "/geo/vectortiles.geo.admin.ch.evil.example/x", "/geo/data.geo.admin.ch/x",
                     "/geo/user@vectortiles.geo.admin.ch/x", "/geo/", "/geo/vectortiles.geo.admin.ch:8443/x"):
            self.assertEqual(self.get(path)[0], 404, path)
        self.assertEqual(self.upstream.calls, [])

    def test_every_proxied_host(self):
        for host in sorted(serve.GEO_HOSTS):
            self.assertEqual(self.get(f"/geo/{host}/some/path?q=1")[0], 200)
        self.assertEqual([c[0] for c in self.upstream.calls],
                         [f"https://{h}/some/path?q=1" for h in sorted(serve.GEO_HOSTS)])


class ProxyCacheTest(ServerTestCase):
    def test_miss_then_hit(self):
        self.upstream.response = ok(b"\x1f\x8bgzipped tile", Content_Encoding="gzip")
        status, h, body = self.get(TILE + "?v=2", Accept="application/x-protobuf")
        self.assertEqual((status, h["X-Cache"], body), (200, "MISS", b"\x1f\x8bgzipped tile"))
        self.assertEqual(self.upstream.calls, [(TILE_URL + "?v=2", "application/x-protobuf")])
        self.assertEqual(h["Content-Type"], "application/x-protobuf")
        self.assertEqual(h["Content-Encoding"], "gzip")
        self.assertEqual(h["Content-Length"], str(len(body)))
        status, h, body = self.get(TILE + "?v=2")
        self.assertEqual((status, h["X-Cache"], body), (200, "HIT", b"\x1f\x8bgzipped tile"))
        self.assertEqual(h["Content-Encoding"], "gzip")
        self.assertEqual(len(self.upstream.calls), 1)
        self.assertEqual(self.cache.get(TILE_URL + "?v=2")[1], b"\x1f\x8bgzipped tile")

    def test_cache_control_per_status(self):
        cases = [  # upstream status -> (status served, X-Cache, Cache-Control)
            (200, "MISS", "public, max-age=86400"),
            (403, "MISS", "public, max-age=3600"),
            (404, "MISS", "public, max-age=3600"),
            (429, "BYPASS", "no-store"),
            (500, "BYPASS", "no-store"),
            (503, "BYPASS", "no-store"),
        ]
        for k, (code, state, cc) in enumerate(cases):
            with self.subTest(code=code):
                self.upstream.response = (code, headers(Content_Type="text/plain"), b"answer %d" % code)
                status, h, body = self.get(f"{TILE}?case={k}")
                self.assertEqual((status, h["X-Cache"], h["Cache-Control"], body), (code, state, cc, b"answer %d" % code))
                self.assertEqual(h.get_all("Cache-Control"), [cc], "the static no-cache header must not be added")

    def test_missing_tiles_are_cached_for_a_day(self):
        self.upstream.response = (404, headers(Content_Type="text/plain"), b"no tile")
        self.assertEqual(self.get(TILE)[1]["X-Cache"], "MISS")
        status, h, _ = self.get(TILE)
        self.assertEqual((status, h["X-Cache"]), (404, "HIT"))
        self.assertEqual(len(self.upstream.calls), 1)
        self.seed(status=404, age=serve.FRESH_MISSING + 60)  # a day later the tile may exist
        self.upstream.response = ok(b"new tile")
        status, h, body = self.get(TILE)
        self.assertEqual((status, h["X-Cache"], body), (200, "MISS", b"new tile"))

    def test_good_copies_are_fresh_for_a_week(self):
        self.seed(age=serve.FRESH_OK - 3600)
        self.assertEqual(self.get(TILE)[1]["X-Cache"], "HIT")
        self.assertEqual(self.upstream.calls, [])
        self.seed(age=serve.FRESH_OK + 3600)
        self.upstream.response = ok(b"refreshed")
        status, h, body = self.get(TILE)
        self.assertEqual((h["X-Cache"], body), ("MISS", b"refreshed"))
        self.assertEqual(self.cache.get(TILE_URL)[1], b"refreshed")
        self.assertAlmostEqual(self.cache.get(TILE_URL)[0]["fetched"], time.time(), delta=60)

    def test_unreachable_and_nothing_cached_is_502(self):
        self.upstream.response = None
        status, h, _ = self.get(TILE)
        self.assertEqual(status, 502)
        self.assertIsNone(self.cache.get(TILE_URL))

    def test_stale_copy_served_when_upstream_fails(self):
        failures = {
            "unreachable": None,
            "throttled": (429, headers(Content_Type="text/plain"), b"slow down"),
            "server error": (500, headers(Content_Type="text/plain"), b"oops"),
            "unavailable": (503, headers(Content_Type="text/plain"), b"down"),
            "forbidden after a good copy": (403, headers(Content_Type="text/plain"), b"blocked"),
            "not found after a good copy": (404, headers(Content_Type="text/plain"), b"gone"),
        }
        for label, response in failures.items():
            with self.subTest(label):
                self.handler.retry_at.clear()
                self.seed(age=10 * 365 * 86400, body=b"old but good")
                self.upstream.response = response
                calls = len(self.upstream.calls)
                status, h, body = self.get(TILE)
                self.assertEqual(len(self.upstream.calls), calls + 1, "upstream must be asked once")
                self.assertEqual((status, h["X-Cache"], body), (200, "STALE", b"old but good"))
                self.assertEqual(h["Cache-Control"], "public, max-age=86400")
                self.assertEqual(self.cache.get(TILE_URL)[1], b"old but good", "the good copy must be kept")

    def test_retry_after_backoff(self):
        self.seed(age=30 * 86400)
        self.seed(url=TILE_URL + "?other", age=30 * 86400)
        self.upstream.response = (503, headers(Content_Type="text/plain"), b"down")
        self.assertEqual(self.get(TILE)[1]["X-Cache"], "STALE")
        self.assertEqual(len(self.upstream.calls), 1)
        backoff = self.handler.retry_at["vectortiles.geo.admin.ch"]
        self.assertAlmostEqual(backoff, time.time() + serve.RETRY_AFTER, delta=5)

        # Within the window, cached copies on that host are served without asking upstream …
        for path in (TILE, TILE + "?other"):
            status, h, body = self.get(path)
            self.assertEqual((status, h["X-Cache"], body), (200, "STALE", b"cached tile"))
        self.assertEqual(len(self.upstream.calls), 1)
        # … but something never cached is still tried, and other hosts are unaffected.
        self.get("/geo/vectortiles.geo.admin.ch/never/cached")
        self.get("/geo/wmts.geo.admin.ch/tile.jpeg")
        self.assertEqual(len(self.upstream.calls), 3)

        # After the window the next request asks again, and a 200 replaces the stale copy.
        self.handler.retry_at["vectortiles.geo.admin.ch"] = time.time() - 1
        self.upstream.response = ok(b"fresh")
        status, h, body = self.get(TILE)
        self.assertEqual((h["X-Cache"], body), ("MISS", b"fresh"))
        self.assertEqual(len(self.upstream.calls), 4)

    def test_backoff_is_set_only_by_failures(self):
        for code, sets in ((200, False), (403, False), (404, False), (429, True), (500, True), (502, True), (None, True)):
            with self.subTest(code=code):
                self.handler.retry_at.clear()
                self.upstream.response = None if code is None else (code, headers(Content_Type="text/plain"), b"")
                self.get(f"{TILE}?code={code}")
                self.assertEqual("vectortiles.geo.admin.ch" in self.handler.retry_at, sets)

    def test_server_survives_an_exception_in_the_upstream_fetch(self):
        self.seed(age=30 * 86400)
        self.upstream.response = RuntimeError("boom")
        try:
            self.get(TILE)
        except (http.client.HTTPException, OSError):
            pass  # the request itself may be dropped
        self.upstream.response = ok(b"after the crash")
        self.handler.retry_at.clear()
        self.assertEqual(self.get(TILE)[2], b"after the crash")
        self.assertEqual(self.get("/index.html")[0], 200)


class RealFetchUpstreamTest(unittest.TestCase):
    """serve.fetch_upstream itself, with urllib.request.urlopen patched."""

    def test_success(self):
        res = mock.MagicMock()
        res.__enter__.return_value = res
        res.status, res.headers = 200, headers(Content_Type="image/png")
        res.read.return_value = b"png"
        with mock.patch.object(serve.urllib.request, "urlopen", return_value=res) as urlopen:
            self.assertEqual(serve.fetch_upstream(TILE_URL, "image/png"), (200, res.headers, b"png"))
        req = urlopen.call_args.args[0]
        self.assertEqual(req.full_url, TILE_URL)
        self.assertEqual(req.get_header("Accept"), "image/png")
        self.assertEqual(req.get_header("Accept-encoding"), "gzip")
        self.assertIn("swiss-population-grid", req.get_header("User-agent"))
        self.assertEqual(urlopen.call_args.kwargs["timeout"], serve.UPSTREAM_TIMEOUT)

    def test_default_accept(self):
        with mock.patch.object(serve.urllib.request, "urlopen", side_effect=OSError) as urlopen:
            serve.fetch_upstream(TILE_URL, None)
        self.assertEqual(urlopen.call_args.args[0].get_header("Accept"), "*/*")

    def test_http_errors_are_responses(self):
        err = urllib.error.HTTPError(TILE_URL, 404, "Not Found", headers(Content_Type="text/plain"), io.BytesIO(b"nope"))
        with mock.patch.object(serve.urllib.request, "urlopen", side_effect=err):
            status, hdrs, body = serve.fetch_upstream(TILE_URL, None)
        self.assertEqual((status, hdrs["Content-Type"], body), (404, "text/plain", b"nope"))

    def test_network_failures_are_none(self):
        for exc in (urllib.error.URLError("dns"), TimeoutError(), ConnectionResetError(), OSError("ssl"),
                    http.client.IncompleteRead(b"par"), http.client.RemoteDisconnected("bye"),
                    ValueError("URL can't contain control characters"), UnicodeEncodeError("ascii", "é", 0, 1, "x")):
            with self.subTest(exc=type(exc).__name__):
                with mock.patch.object(serve.urllib.request, "urlopen", side_effect=exc):
                    self.assertIsNone(serve.fetch_upstream(TILE_URL, None))

    def test_body_read_failure_after_headers_is_none(self):
        res = mock.MagicMock()
        res.__enter__.return_value = res
        res.status, res.headers = 200, headers()
        res.read.side_effect = http.client.IncompleteRead(b"half")
        with mock.patch.object(serve.urllib.request, "urlopen", return_value=res):
            self.assertIsNone(serve.fetch_upstream(TILE_URL, None))


class ProxyWithRealFetchTest(ServerTestCase):
    """The handler with the real fetch_upstream; only urlopen is faked."""

    fake_upstream = False

    def test_network_exception_serves_the_stale_copy(self):
        self.seed(age=30 * 86400)
        with mock.patch.object(serve.urllib.request, "urlopen", side_effect=urllib.error.URLError("offline")):
            status, h, body = self.get(TILE)
            self.assertEqual((status, h["X-Cache"], body), (200, "STALE", b"cached tile"))
            self.assertEqual(self.get("/geo/wmts.geo.admin.ch/never/cached")[0], 502)


class StaticFilesTest(ServerTestCase):
    def test_static_files_are_always_revalidated(self):
        for path in ("/", "/index.html", "/app.js", "/data/meta.json", "/data/cells.bin.gz"):
            status, h, _ = self.get(path)
            self.assertEqual(status, 200, path)
            self.assertEqual(h.get_all("Cache-Control"), ["no-cache"], path)
        self.assertEqual(self.get("/missing.js")[1]["Cache-Control"], "no-cache")
        self.assertEqual(self.upstream.calls, [])

    def test_content_types(self):
        self.assertEqual(self.get("/app.js")[1]["Content-Type"], "text/javascript")
        status, h, body = self.get("/data/cells.bin.gz")
        self.assertEqual(h["Content-Type"], "application/octet-stream")
        self.assertIsNone(h["Content-Encoding"], "the browser must not decode cells.bin.gz itself")
        self.assertEqual(gzip.decompress(body), b"\x00\x01" * 100)

    def test_only_errors_are_logged(self):
        self.get("/index.html")
        self.get("/geo/health")
        self.assertEqual(self.log.getvalue(), "")
        self.get("/missing.js")
        self.assertIn("404", self.log.getvalue())


class LoggingTest(unittest.TestCase):
    def test_single_argument_log_messages(self):
        # http.server logs a TimeoutError as log_error('Request timed out: %r', e): one argument only.
        h = serve.Handler.__new__(serve.Handler)
        h.client_address = ("127.0.0.1", 50000)
        h.requestline = "GET / HTTP/1.1"
        with mock.patch("sys.stderr", new_callable=io.StringIO) as err:
            h.log_error("Request timed out: %r", TimeoutError("timed out"))
        self.assertIn("Request timed out", err.getvalue())


class NeedsBuildTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="spg-build-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.src, self.out = self.tmp / "src.csv", self.tmp / "out.bin"

    def test_rules(self):
        self.assertFalse(serve.needs_build(self.out, self.src, force=True), "nothing to build from")
        self.src.write_text("x")
        self.assertTrue(serve.needs_build(self.out, self.src, force=False), "output missing")
        self.out.write_text("y")
        os.utime(self.src, (1000, 1000))
        os.utime(self.out, (2000, 2000))
        self.assertFalse(serve.needs_build(self.out, self.src, force=False), "up to date")
        self.assertTrue(serve.needs_build(self.out, self.src, force=True), "--rebuild")
        os.utime(self.src, (3000, 3000))
        self.assertTrue(serve.needs_build(self.out, self.src, force=False), "source newer")

    def test_builds_point_at_existing_scripts(self):
        for out, src, script in serve.BUILDS:
            self.assertTrue((ROOT / "scripts" / script).is_file(), script)
            self.assertEqual(out.parent, serve.WEB / "data")

    def test_import_does_not_start_a_server(self):
        self.assertEqual(serve.__name__, "serve")
        self.assertTrue(callable(serve.main))


if __name__ == "__main__":
    unittest.main()
