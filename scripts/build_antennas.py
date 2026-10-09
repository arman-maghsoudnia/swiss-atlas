#!/usr/bin/env python3
"""Convert the OFCOM mobile antenna sites (GeoJSON, LV95) into a compact JSON for the web map.

Input  (default): AntennaLocation/standorte-mobilfunkanlagen_2056.json
Output (default): web/data/antennas.json – column arrays plus lookup tables:
  e, n     LV95 coordinates (m) of the station's first mast
  op       index into operators
  type     index into types
  power    index into powers (ordinal, 0 = very low … 3 = high)
  tech     bit mask: 1 = 2G, 2 = 3G, 4 = 4G, 8 = 5G
  adaptive 1 if partially adaptive operation
  date     site data sheet date ("" if none), exempt = 1 if not subject to NISV limits
  limit    installation limit value in V/m (null if none)
  name     station identifier as published
"""

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

OPERATORS = ["Swisscom", "Salt", "Sunrise", "SBB", "Foreign"]
OPERATOR_LABELS = ["Swisscom", "Salt", "Sunrise", "SBB (railway GSM-R)", "German networks (border)"]
TYPES = {
    "Outdoor > 6 Werp": "Outdoor > 6 W ERP",
    "Outdoor ≤ 6 Werp": "Outdoor ≤ 6 W ERP",
    "Indoor ≤ 6 Werp": "Indoor ≤ 6 W ERP",
    "Tunnel": "Tunnel",
    "Temporary station": "Temporary",
    "": "Not specified",
}
POWERS = ["very low (≤ 6 W)", "low (≤ 500 W)", "medium (≤ 5,000 W)", "high (> 5,000 W)"]
POWER_KEYS = ["very low", "low", "medium", "high"]
TECH_BITS = {"2G": 1, "3G": 2, "4G": 4, "5G": 8}


def operator(station):
    head = station.split(" ")[0]
    if head in OPERATORS[:4]:
        return OPERATORS.index(head)
    return OPERATORS.index("Foreign")  # DB-/DTM-/VOD-… 2G stations of German networks


def power(text):
    m = re.search(r":\s*(very low|low|medium|high)", text)
    if not m:
        sys.exit(f"Unknown power class: {text!r}")
    return POWER_KEYS.index(m.group(1))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", type=Path, default=ROOT / "AntennaLocation" / "standorte-mobilfunkanlagen_2056.json")
    ap.add_argument("--out", type=Path, default=ROOT / "web" / "data" / "antennas.json")
    args = ap.parse_args()

    if not args.src.exists():
        sys.exit(f"Missing {args.src}")
    data = json.loads(args.src.read_text(encoding="utf-8"))
    if data.get("crs", {}).get("properties", {}).get("name") != "EPSG:2056":
        sys.exit("Expected LV95 (EPSG:2056) coordinates")

    type_keys = list(TYPES)
    cols = {k: [] for k in ["e", "n", "op", "type", "power", "tech", "adaptive", "date", "exempt", "limit", "name"]}
    for f in data["features"]:
        p = f["properties"]
        e, n = f["geometry"]["coordinates"]
        tech = 0
        for g in re.findall(r"[2-5]G", p["techno_en"]):
            tech |= TECH_BITS[g]
        permit = p["bewilligung_en"]
        date = re.search(r"\d{4}-\d{2}-\d{2}", permit)
        limit = re.search(r"([\d.]+) V/m", p["agw_en"])
        cols["e"].append(round(e))
        cols["n"].append(round(n))
        cols["op"].append(operator(p["station"]))
        cols["type"].append(type_keys.index(p["typ_en"]))
        cols["power"].append(power(p["power_en"]))
        cols["tech"].append(tech)
        cols["adaptive"].append(1 if p["adaptiv_en"] else 0)
        cols["date"].append(date.group(0) if date else "")
        cols["exempt"].append(1 if permit.startswith("Due to") else 0)
        cols["limit"].append(float(limit.group(1)) if limit else None)
        cols["name"].append(p["station"])

    out = {
        "source": "OFCOM – ch.bakom.standorte-mobilfunkanlagen",
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "count": len(cols["e"]),
        "operators": OPERATORS,
        "operatorLabels": OPERATOR_LABELS,
        "types": list(TYPES.values()),
        "powers": POWERS,
        **cols,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    counts = {o: cols["op"].count(i) for i, o in enumerate(OPERATORS)}
    print(f"{out['count']:,} antenna sites {counts} -> {args.out} ({args.out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
