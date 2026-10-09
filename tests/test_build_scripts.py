"""scripts/build_antennas.py and scripts/build_data.py on tiny synthetic inputs (run as the CLI,
with --src/--out pointing at a temporary directory), plus a full rebuild check that runs only
where the raw sources have been downloaded (they are not committed, so CI skips it)."""

import gzip
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from array import array
from pathlib import Path

from _support import ROOT

SCRIPTS = ROOT / "scripts"
RAW_STATPOP = ROOT / "ag-b-00.03-vz2024statpop"
RAW_ANTENNAS = ROOT / "AntennaLocation" / "standorte-mobilfunkanlagen_2056.json"


def run(script, *args):
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    return subprocess.run([sys.executable, str(SCRIPTS / script), *map(str, args)],
                          capture_output=True, text=True, encoding="utf-8", env=env, timeout=120)


class TempDirCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="spg-build-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)


# ---------------------------------------------------------------- antennas

def feature(e, n, station, typ="Outdoor > 6 Werp", power="Power class : medium (up to 5'000 W)",
            techno="Technology 3G,4G,5G", adaptive="", permit="Site data sheet 2022-07-14",
            limit="Installation limit value 5.0 V/m"):
    # Property names as in OFCOM's standorte-mobilfunkanlagen_2056.json (English variants used).
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [e, n]},
            "properties": {"station": station, "typ_en": typ, "power_en": power, "techno_en": techno,
                           "adaptiv_en": adaptive, "bewilligung_en": permit, "agw_en": limit,
                           "typ_de": typ, "koord": f"{e},{n}"}}


FEATURES = [
    feature(2751128, 1247034, "Swisscom GAIP", adaptive="Partially adaptive operation"),
    feature(2688923.4, 1281533.6, "Sunrise SH910-1", power="Power class : low (up to 500 W)",
            techno="Technology 4G,5G", limit="Installation limit value - V/m"),
    feature(2646848, 1248650, "Salt AKSJ", typ="Indoor ≤ 6 Werp", power="Power class : very low (up to 6 W)",
            techno="Technology 3G,4G", permit="", limit=""),
    feature(2600000, 1200000, "SBB 4711", typ="Tunnel", power="Power class : high (over 5'000 W)",
            techno="Technology 2G", permit="Due to its low transmitting power, this installation is not subject"),
    feature(2700000, 1290000, "DB-ABC123", typ="", techno="Technology 2G", limit="Installation limit value 6.0 V/m"),
    feature(2500000, 1118000, "VOD-XYZ", typ="Temporary station", techno=""),
    feature(2610000, 1260000, "Swisscom SMALL", typ="Outdoor ≤ 6 Werp", techno="Technology 5G"),
]


def write_geojson(path, features=FEATURES, crs="EPSG:2056"):
    data = {"name": "ch.bakom.mobil-antennenstandorte", "type": "FeatureCollection",
            "crs": {"type": "name", "properties": {"name": crs}}, "features": features}
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


class BuildAntennasTest(TempDirCase):
    def build(self, **kw):
        src, out = self.tmp / "src.json", self.tmp / "out" / "antennas.json"
        write_geojson(src, **kw)
        return run("build_antennas.py", "--src", src, "--out", out), out

    def test_output_structure(self):
        res, out = self.build()
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("7 antenna sites", res.stdout)
        j = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(j["count"], 7)
        self.assertEqual(j["operators"], ["Swisscom", "Salt", "Sunrise", "SBB", "Foreign"])
        self.assertEqual(len(j["operatorLabels"]), 5)
        self.assertEqual(j["types"], ["Outdoor > 6 W ERP", "Outdoor ≤ 6 W ERP", "Indoor ≤ 6 W ERP", "Tunnel",
                                      "Temporary", "Not specified"])
        self.assertEqual(len(j["powers"]), 4)
        for k in ("e", "n", "op", "type", "power", "tech", "adaptive", "date", "exempt", "limit", "name"):
            self.assertEqual(len(j[k]), 7, k)
        self.assertIn("generated", j)

    def test_column_values(self):
        res, out = self.build()
        self.assertEqual(res.returncode, 0, res.stderr)
        j = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(j["e"], [2751128, 2688923, 2646848, 2600000, 2700000, 2500000, 2610000])
        self.assertEqual(j["n"], [1247034, 1281534, 1248650, 1200000, 1290000, 1118000, 1260000])  # rounded
        self.assertEqual(j["op"], [0, 2, 1, 3, 4, 4, 0])
        self.assertEqual(j["type"], [0, 0, 2, 3, 5, 4, 1])
        self.assertEqual(j["power"], [2, 1, 0, 3, 2, 2, 2])
        self.assertEqual(j["tech"], [2 | 4 | 8, 4 | 8, 2 | 4, 1, 1, 0, 8])
        self.assertEqual(j["adaptive"], [1, 0, 0, 0, 0, 0, 0])
        self.assertEqual(j["date"], ["2022-07-14", "2022-07-14", "", "", "2022-07-14", "2022-07-14", "2022-07-14"])
        self.assertEqual(j["exempt"], [0, 0, 0, 1, 0, 0, 0])
        self.assertEqual(j["limit"], [5.0, None, None, 5.0, 6.0, 5.0, 5.0])
        self.assertEqual(j["name"], [f["properties"]["station"] for f in FEATURES])

    def test_no_features(self):
        res, out = self.build(features=[])
        self.assertEqual(res.returncode, 0, res.stderr)
        j = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual((j["count"], j["e"], j["name"]), (0, [], []))

    def test_missing_source(self):
        res = run("build_antennas.py", "--src", self.tmp / "nope.json", "--out", self.tmp / "a.json")
        self.assertEqual(res.returncode, 1)
        self.assertIn("Missing", res.stderr)
        self.assertFalse((self.tmp / "a.json").exists())

    def test_wrong_coordinate_system(self):
        res, out = self.build(crs="EPSG:4326")
        self.assertEqual(res.returncode, 1)
        self.assertIn("Expected LV95 (EPSG:2056) coordinates", res.stderr)
        self.assertFalse(out.exists())

    def test_unknown_power_class(self):
        res, _ = self.build(features=[feature(2600000, 1200000, "Salt X", power="Power class : huge")])
        self.assertEqual(res.returncode, 1)
        self.assertIn("Unknown power class", res.stderr)


# ---------------------------------------------------------------- STATPOP

KEYS = ["ERHJAHR", "PUBJAHR", "RELI", "E_KOORD", "N_KOORD"]
ATTRS = ["BBTOT", "BBMTOT", "BBWTOT", "HPTOT", "HPI"]
# Three hectares (an odd count, so the uint32 noloc block needs 2 bytes of padding).
ROWS = [  # RELI, E, N, BBTOT, BBMTOT, BBWTOT, HPTOT, HPI
    (48621114, 2486200, 1111400, 8, 3, 7, 3, 1),
    (67932357, 2679300, 1235700, 120, 61, 59, 55, 2),
    (75001300, 2750000, 1300000, 3, 3, 0, "", 0),  # empty field -> 0
]
NOLOC = [  # RELI, GMDE, BBTOT, BBMTOT, BBWTOT, HPTOT, HPI
    (67932357, 261, 12, 6, 6, 0, 0),
    (48621114, 6621, 3, 3, 0, 0, 0),
]


def write_csv(path, header, rows):
    # Like the FSO files: ';'-separated, quoted header, CRLF line ends, latin-1.
    lines = [";".join(f'"{h}"' for h in header)] + [";".join(map(str, r)) for r in rows]
    path.write_bytes(("\r\n".join(lines) + "\r\n").encode("latin-1"))


def write_statpop(src, rows=ROWS, noloc=NOLOC, attrs=ATTRS, year="2024"):
    src.mkdir(parents=True, exist_ok=True)
    write_csv(src / f"STATPOP{year}.csv", KEYS + attrs, [(year, int(year) + 1, *r) for r in rows])
    if noloc is not None:
        header = KEYS + ["GMDE", "HIST_GMDE"] + attrs
        by_reli = {r[0]: r for r in rows}
        write_csv(src / f"STATPOP{year}_NOLOC.csv", header,
                  [(year, int(year) + 1, reli, by_reli[reli][1], by_reli[reli][2], gmde, 10000 + gmde, *vals)
                   for reli, gmde, *vals in noloc])


def parse_cells(out):
    """Decode cells.bin.gz with the layout documented in build_data.py (as app.js reads it)."""
    meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))
    buf = gzip.decompress((out / "cells.bin.gz").read_bytes())
    n, m, k = meta["n"], meta["noloc"]["m"], len(meta["columns"])

    def u16(offset, count):
        a = array("H")
        a.frombytes(buf[offset:offset + 2 * count])
        if sys.byteorder != "little":
            a.byteswap()
        return a.tolist()

    cols = {c: u16((2 + j) * 2 * n, n) for j, c in enumerate(meta["columns"])}
    off = meta["noloc"]["offset"]
    noloc_idx = list(struct.unpack_from(f"<{m}I", buf, off))
    noloc = {c: u16(off + 4 * m + j * 2 * m, m) for j, c in enumerate(meta["columns"])}
    return meta, buf, u16(0, n), u16(2 * n, n), cols, noloc_idx, noloc, k


class BuildDataTest(TempDirCase):
    def build(self, *extra, **kw):
        src, out = self.tmp / "src", self.tmp / "out"
        write_statpop(src, **kw)
        return run("build_data.py", "--src", src, "--out", out, *extra), out

    def test_layout_and_values(self):
        res, out = self.build()
        self.assertEqual(res.returncode, 0, res.stderr)
        meta, buf, e_idx, n_idx, cols, noloc_idx, noloc, k = parse_cells(out)
        self.assertEqual(meta["n"], 3)
        self.assertEqual((meta["e0"], meta["n0"], meta["cellSize"]), (2400000, 1100000, 100))
        self.assertEqual(meta["columns"], ATTRS)
        self.assertEqual(list(meta["labels"]), ATTRS)
        self.assertEqual(e_idx, [(r[1] - 2400000) // 100 for r in ROWS])
        self.assertEqual(n_idx, [(r[2] - 1100000) // 100 for r in ROWS])
        for j, c in enumerate(ATTRS):
            want = [r[3 + j] or 0 for r in ROWS]
            self.assertEqual(cols[c], want, c)
            self.assertEqual(meta["totals"][c], sum(want), c)
            self.assertEqual(meta["max"][c], max(want), c)
        # uint16 columns end at 2 * 3 * 7 = 42 bytes; the uint32 block starts 4-byte aligned.
        self.assertEqual(meta["noloc"]["offset"], 44)
        self.assertEqual(buf[42:44], b"\0\0")
        self.assertEqual(meta["rawBytes"], len(buf))
        self.assertEqual(len(buf), 44 + 4 * 2 + 2 * 2 * k)

    def test_noloc_block(self):
        res, out = self.build()
        self.assertEqual(res.returncode, 0, res.stderr)
        meta, _, _, _, cols, noloc_idx, noloc, _ = parse_cells(out)
        self.assertEqual(meta["noloc"]["m"], 2)
        self.assertEqual(noloc_idx, [1, 0])  # row index of each RELI in the main file
        self.assertEqual(meta["noloc"]["gmde"], [261, 6621])
        self.assertEqual(noloc["BBTOT"], [12, 3])
        self.assertEqual(noloc["BBMTOT"], [6, 3])
        self.assertEqual(meta["noloc"]["residents"], 15)

    def test_metadata(self):
        res, out = self.build()
        self.assertEqual(res.returncode, 0, res.stderr)
        meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))
        self.assertEqual((meta["year"], meta["pubYear"], meta["referenceDate"]), (2024, 2025, "2024-12-31"))
        self.assertEqual(meta["source"], "STATPOP2024, FSO GEOSTAT")
        self.assertEqual(len(meta["ageBands"]), 19)
        self.assertIn("generated", meta)
        self.assertIn("3 hectares", res.stdout)

    def test_year_option(self):
        res, out = self.build("--year", "2023", year="2023")
        self.assertEqual(res.returncode, 0, res.stderr)
        meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))
        self.assertEqual((meta["year"], meta["source"]), (2023, "STATPOP2023, FSO GEOSTAT"))

    def test_without_noloc_file(self):
        res, out = self.build(noloc=None)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("warning", res.stderr)
        meta, buf, *_ = parse_cells(out)
        self.assertEqual((meta["noloc"]["m"], meta["noloc"]["residents"], meta["noloc"]["gmde"]), (0, 0, []))
        self.assertEqual(meta["noloc"]["offset"] % 4, 0)
        self.assertEqual(len(buf), meta["noloc"]["offset"])

    def test_even_layout_needs_no_padding(self):
        res, out = self.build(rows=ROWS[:2], noloc=NOLOC[:1])
        self.assertEqual(res.returncode, 0, res.stderr)
        meta, *_ = parse_cells(out)
        self.assertEqual(meta["noloc"]["offset"], 2 * 2 * 7)

    def test_missing_source(self):
        res = run("build_data.py", "--src", self.tmp / "nowhere", "--out", self.tmp / "out")
        self.assertEqual(res.returncode, 1)
        self.assertIn("Missing", res.stderr)
        self.assertIn("STATPOP2024.csv", res.stderr)
        self.assertIn("download and unzip the STATPOP geodata first", res.stderr)
        self.assertFalse((self.tmp / "out").exists())

    def test_unknown_column(self):
        res, out = self.build(attrs=ATTRS + ["BB99"], rows=[r + (1,) for r in ROWS], noloc=None)
        self.assertEqual(res.returncode, 1)
        self.assertIn("Unknown columns (update LABELS): ['BB99']", res.stderr)
        self.assertFalse((out / "cells.bin.gz").exists())

    def test_uint16_overflow(self):
        rows = [ROWS[0], (ROWS[1][0], ROWS[1][1], ROWS[1][2], 70000, 35000, 35000, 55, 2)]
        res, out = self.build(rows=rows, noloc=None)
        self.assertEqual(res.returncode, 1)
        self.assertIn("BBTOT exceeds uint16 (70000)", res.stderr)


# ---------------------------------------------------------------- full rebuild (local only)

class RebuildCommittedDataTest(TempDirCase):
    """web/data must be exactly what the build scripts make from the raw downloads."""

    @unittest.skipUnless(RAW_ANTENNAS.exists(), "raw OFCOM antenna file not downloaded (see README)")
    def test_antennas_json(self):
        out = self.tmp / "antennas.json"
        res = run("build_antennas.py", "--out", out)
        self.assertEqual(res.returncode, 0, res.stderr)
        built = json.loads(out.read_text(encoding="utf-8"))
        committed = json.loads((ROOT / "web" / "data" / "antennas.json").read_text(encoding="utf-8"))
        built.pop("generated"), committed.pop("generated")
        self.assertEqual(built, committed)

    @unittest.skipUnless((RAW_STATPOP / "STATPOP2024.csv").exists(), "raw STATPOP files not downloaded (see README)")
    @unittest.skipIf(os.environ.get("SPG_SKIP_SLOW"), "SPG_SKIP_SLOW is set")
    def test_cells_and_meta(self):  # ~10 s
        res = run("build_data.py", "--out", self.tmp)
        self.assertEqual(res.returncode, 0, res.stderr)
        committed = ROOT / "web" / "data"
        self.assertEqual(gzip.decompress((self.tmp / "cells.bin.gz").read_bytes()),
                         gzip.decompress((committed / "cells.bin.gz").read_bytes()))
        built = json.loads((self.tmp / "meta.json").read_text(encoding="utf-8"))
        meta = json.loads((committed / "meta.json").read_text(encoding="utf-8"))
        built.pop("generated"), meta.pop("generated")
        self.assertEqual(built, meta)


if __name__ == "__main__":
    unittest.main()
