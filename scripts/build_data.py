#!/usr/bin/env python3
"""Convert the BFS STATPOP hectare CSVs into a compact binary for the web map.

Input  (default: ag-b-00.03-vz2024statpop/):
  STATPOP<year>.csv        one row per inhabited hectare (LV95 SW corner + 77 attributes)
  STATPOP<year>_NOLOC.csv  residents without a geocoded address, parked on the
                           commune-centre hectare (already included in the main file)

Output (web/data/):
  meta.json     column codes, English labels, byte offsets, totals
  cells.bin.gz  gzip of little-endian arrays, column-major:
                  uint16 e_idx[n]      (E_KOORD - e0) / 100
                  uint16 n_idx[n]      (N_KOORD - n0) / 100
                  uint16 col[k][n]     one array per attribute
                  uint32 noloc_idx[m]  row index of each commune-centre hectare
                  uint16 noloc[k][m]   non-geocoded residents on that hectare

Only the standard library is used, so no virtualenv is needed.
"""

import argparse
import csv
import gzip
import json
import sys
from array import array
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

AGE_BANDS = ["0–4", "5–9", "10–14", "15–19", "20–24", "25–29", "30–34", "35–39", "40–44",
             "45–49", "50–54", "55–59", "60–64", "65–69", "70–74", "75–79", "80–84",
             "85–89", "90+"]

# English labels, translated from be-b-00.03-10-STATPOP-v123-tab.xlsx
LABELS = {
    "BBTOT": "Residents, total",
    "BB11": "Swiss nationals",
    "BB12": "Foreign nationals, total",
    "BB13": "EU/EFTA nationals",
    "BB14": "Other European nationals",
    "BB15": "Non-European nationals",
    "BB16": "Nationality unknown",
    "BB21": "Born in Switzerland, total",
    "BB22": "Born in the commune of residence",
    "BB23": "Born elsewhere in the same canton",
    "BB24": "Born in another canton",
    "BB25": "Born in Switzerland, commune unknown",
    "BB26": "Born abroad, total",
    "BB27": "Born in an EU/EFTA country",
    "BB28": "Born in another European country",
    "BB29": "Born outside Europe",
    "BB30": "Born abroad, country unknown",
    "BBMTOT": "Men, total",
    "BBWTOT": "Women, total",
    "BB41": "In the commune for less than 1 year",
    "BB42": "In the commune for 1–5 years",
    "BB43": "In the commune for 6–10 years",
    "BB44": "In the commune for more than 10 years",
    "BB45": "In the commune since birth",
    "BB46": "Residence duration unknown",
    "BB51": "A year ago: same commune",
    "BB52": "A year ago: same canton",
    "BB53": "A year ago: another canton",
    "BB54": "A year ago: abroad",
    "BB55": "A year ago: not yet born",
    "BB56": "A year ago: unknown",
    "HPTOT": "Private households, total",
    "HP01": "Households of 1 person",
    "HP02": "Households of 2 persons",
    "HP03": "Households of 3 persons",
    "HP04": "Households of 4 persons",
    "HP05": "Households of 5 persons",
    "HP06": "Households of 6+ persons",
    "HPI": "Household plausibility class (1 = all plausible, 2 = at least one not)",
}
for i, band in enumerate(AGE_BANDS, 1):
    LABELS[f"BBM{i:02d}"] = f"Men aged {band}"
    LABELS[f"BBW{i:02d}"] = f"Women aged {band}"

KEY_COLS = {"ERHJAHR", "PUBJAHR", "RELI", "E_KOORD", "N_KOORD", "GMDE", "HIST_GMDE"}


def read_csv(path):
    with open(path, newline="", encoding="latin-1") as f:
        return list(csv.DictReader(f, delimiter=";"))


def to_int(s):
    return int(s) if s else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", type=Path, default=ROOT / "ag-b-00.03-vz2024statpop")
    ap.add_argument("--out", type=Path, default=ROOT / "web" / "data")
    ap.add_argument("--year", default="2024")
    args = ap.parse_args()

    main_csv = args.src / f"STATPOP{args.year}.csv"
    noloc_csv = args.src / f"STATPOP{args.year}_NOLOC.csv"
    if not main_csv.exists():
        sys.exit(f"Missing {main_csv} – download and unzip the STATPOP geodata first (see README).")

    print(f"Reading {main_csv.name} …")
    rows = read_csv(main_csv)
    cols = [c for c in rows[0].keys() if c not in KEY_COLS]
    missing = [c for c in cols if c not in LABELS]
    if missing:
        sys.exit(f"Unknown columns (update LABELS): {missing}")

    es = [int(r["E_KOORD"]) for r in rows]
    ns = [int(r["N_KOORD"]) for r in rows]
    e0 = (min(es) // 100_000) * 100_000
    n0 = (min(ns) // 100_000) * 100_000
    n = len(rows)

    arrays = [array("H", ((e - e0) // 100 for e in es)), array("H", ((v - n0) // 100 for v in ns))]
    col_max = {}
    for c in cols:
        vals = [to_int(r[c]) for r in rows]
        col_max[c] = max(vals)
        if col_max[c] > 0xFFFF:
            sys.exit(f"{c} exceeds uint16 ({col_max[c]})")
        arrays.append(array("H", vals))

    noloc_rows = read_csv(noloc_csv) if noloc_csv.exists() else []
    if not noloc_rows:
        print(f"warning: {noloc_csv} missing or empty; 'Remove non-geocoded residents' will have no effect", file=sys.stderr)
    row_of = {r["RELI"]: i for i, r in enumerate(rows)}
    noloc_idx = array("I", (row_of[r["RELI"]] for r in noloc_rows))
    noloc_cols = [array("H", (to_int(r[c]) for r in noloc_rows)) for c in cols]
    noloc_gmde = [to_int(r["GMDE"]) for r in noloc_rows]

    # Assemble the buffer and remember offsets (uint32 section padded to 4 bytes).
    buf = bytearray()
    for a in arrays:
        buf += a.tobytes()
    buf += b"\0" * (-len(buf) % 4)
    noloc_offset = len(buf)
    buf += noloc_idx.tobytes()
    for a in noloc_cols:
        buf += a.tobytes()
    if sys.byteorder != "little":
        sys.exit("Big-endian host not supported")

    args.out.mkdir(parents=True, exist_ok=True)
    with gzip.open(args.out / "cells.bin.gz", "wb", compresslevel=6) as f:
        f.write(buf)

    totals = {c: sum(a) for c, a in zip(cols, arrays[2:])}
    meta = {
        "source": "STATPOP%s, FSO GEOSTAT" % args.year,
        "year": int(rows[0]["ERHJAHR"]),
        "pubYear": int(rows[0]["PUBJAHR"]),
        "referenceDate": f"{rows[0]['ERHJAHR']}-12-31",
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "n": n,
        "e0": e0,
        "n0": n0,
        "cellSize": 100,
        "columns": cols,
        "labels": {c: LABELS[c] for c in cols},
        "ageBands": AGE_BANDS,
        "max": col_max,
        "totals": totals,
        "noloc": {"m": len(noloc_rows), "offset": noloc_offset, "gmde": noloc_gmde,
                  "residents": sum(noloc_cols[cols.index("BBTOT")])},
        "rawBytes": len(buf),
    }
    (args.out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")))

    gz = (args.out / "cells.bin.gz").stat().st_size
    print(f"{n:,} hectares · {len(cols)} attributes · {totals['BBTOT']:,} residents (sum of rounded cells)")
    print(f"{len(noloc_rows):,} commune-centre hectares with {meta['noloc']['residents']:,} non-geocoded residents")
    print(f"wrote {args.out / 'cells.bin.gz'} ({gz / 1e6:.1f} MB, {len(buf) / 1e6:.1f} MB raw) and meta.json")


if __name__ == "__main__":
    main()
