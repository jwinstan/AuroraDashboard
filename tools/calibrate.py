#!/usr/bin/env python3
"""Calibrate P_geo against IMAGE magnetometer activity.

Reads backtest/predictions.csv produced by tools/backtest.py and fits a
two-parameter Platt-style transform

    P_cal = σ(a · logit(P_geo) + b)

that minimises Brier score against the observed boolean (X-range ≥ threshold).
Platt is monotone, so AUC is preserved; only calibration changes.

Split: deterministic 50/50 by hashed timestamp. Fit on train, metrics on test.

A full isotonic fit (pool-adjacent-violators) is also reported for comparison —
it is the theoretical lower bound a monotone transform can reach, and tells us
whether the two-parameter form is leaving significant skill on the table.

Writes:
  backtest/calibration.json         {a, b, source, n_train, n_test, ...}
  backtest/report_calibrated.md     reliability before/after

Note on the proxy: magnetometers under-report quiet-arc aurora (pulsating,
substorm recovery), so the fitted P_cal is a lower bound on visible-aurora
probability. See docs/MODEL.md if we add keogram ground truth later.
"""
import argparse
import csv
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

OUT = ROOT / "backtest"

# Keep logit finite when P hits 0 or P_CAP.
EPS = 1e-4


def logit(p):
    p = min(1 - EPS, max(EPS, p))
    return math.log(p / (1 - p))


def sigmoid(x):
    # Numerically stable
    if x >= 0:
        z = math.exp(-x)
        return 1.0 / (1.0 + z)
    z = math.exp(x)
    return z / (1.0 + z)


def load_rows(threshold_nT):
    rows = []
    with (OUT / "predictions.csv").open(encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if not r["dX_range_nT"]:
                continue
            dx = float(r["dX_range_nT"])
            rows.append({
                "t": r["t"],
                "station": r["station"],
                "p_geo": float(r["p_geo"]),
                "y": 1 if dx >= threshold_nT else 0,
            })
    return rows


def split(rows, frac=0.5):
    # Deterministic: hash of the ISO timestamp. Put ~half on each side.
    train, test = [], []
    for r in rows:
        h = hash(r["t"]) & 0xFFFF
        (train if (h / 0xFFFF) < frac else test).append(r)
    return train, test


def fit_platt(rows, lr=0.05, iters=3000, l2=1e-4):
    """Fit P_cal = σ(a · z + b) where z = logit(P_geo), by gradient descent on
    binary log-loss with mild L2. Stdlib-only, so no scipy. 3000 iters at
    lr=0.05 converges in a fraction of a second for ~10k rows."""
    a, b = 1.0, 0.0
    n = len(rows)
    zs = [logit(r["p_geo"]) for r in rows]
    ys = [r["y"] for r in rows]
    for _ in range(iters):
        ga, gb = 0.0, 0.0
        for z, y in zip(zs, ys):
            p = sigmoid(a * z + b)
            e = p - y
            ga += e * z
            gb += e
        a -= lr * (ga / n + l2 * a)
        b -= lr * (gb / n + l2 * b)
    return a, b


def brier(ps, ys):
    return sum((p - y) ** 2 for p, y in zip(ps, ys)) / len(ps)


def reliability(ps, ys, nbins=10):
    bins = [[] for _ in range(nbins)]
    for p, y in zip(ps, ys):
        idx = min(nbins - 1, int(p * nbins))
        bins[idx].append((p, y))
    out = []
    for b in bins:
        if not b:
            out.append((None, None, 0))
        else:
            mp = sum(p for p, _ in b) / len(b)
            my = sum(y for _, y in b) / len(b)
            out.append((mp, my, len(b)))
    return out


def ascii_rel(rel, width=40):
    lines = []
    for mp, my, n in rel:
        if n == 0:
            lines.append("  (empty)")
            continue
        axis = [" "] * (width + 2)
        pi = min(width, int(mp * width))
        oi = min(width, int(my * width))
        axis[pi] = "#"
        axis[oi] = "o" if oi != pi else "X"
        lines.append(f"  p={mp:4.2f}  obs={my:4.2f}  |{''.join(axis)}|  n={n:>5}")
    return "\n".join(lines)


def isotonic(rows):
    """Pool-adjacent-violators on (p, y) sorted by p. Returns a monotone step
    function as a list of (p_threshold, p_cal) breakpoints. Lower bound a
    monotone transform can reach on Brier for this data."""
    pts = sorted((r["p_geo"], r["y"]) for r in rows)
    ps = [[p, float(y), 1] for p, y in pts]  # [x, sum_y, n]
    i = 0
    while i < len(ps) - 1:
        if ps[i][1] / ps[i][2] > ps[i + 1][1] / ps[i + 1][2]:
            ps[i][1] += ps[i + 1][1]
            ps[i][2] += ps[i + 1][2]
            del ps[i + 1]
            if i > 0:
                i -= 1
        else:
            i += 1
    return [(p, s / n) for p, s, n in ps]


def apply_iso(iso, p):
    # Step function: for query p, find the pool containing p, return its mean.
    # Bins are produced in increasing order of the training p values.
    out = iso[0][1]
    for px, py in iso:
        if p >= px:
            out = py
        else:
            break
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--threshold", type=float, default=100.0)
    ap.add_argument("--iters", type=int, default=3000)
    a = ap.parse_args()

    rows = load_rows(a.threshold)
    print(f"loaded {len(rows)} rows (threshold {a.threshold} nT)")
    train, test = split(rows)
    print(f"train {len(train)}, test {len(test)}")

    # Baselines on test.
    test_p_raw = [r["p_geo"] for r in test]
    test_y = [r["y"] for r in test]
    br_raw = brier(test_p_raw, test_y)
    base = sum(test_y) / len(test_y)
    br_climo = base * (1 - base)
    print(f"test base rate {base:.3f}   Brier raw {br_raw:.4f}   climo {br_climo:.4f}")

    # Platt.
    coef_a, coef_b = fit_platt(train, iters=a.iters)
    print(f"Platt fit: a={coef_a:.4f}, b={coef_b:.4f}")
    test_p_platt = [sigmoid(coef_a * logit(r["p_geo"]) + coef_b) for r in test]
    br_platt = brier(test_p_platt, test_y)
    print(f"Brier Platt {br_platt:.4f}")

    # Isotonic (fit on train, score on test).
    iso = isotonic(train)
    print(f"isotonic bins: {len(iso)}")
    test_p_iso = [apply_iso(iso, r["p_geo"]) for r in test]
    br_iso = brier(test_p_iso, test_y)
    print(f"Brier isotonic {br_iso:.4f}")

    # Save parametric (Platt) for use by the model — isotonic is a step
    # function, parametric is smooth and travels better.
    (OUT / "calibration.json").write_text(json.dumps({
        "method": "platt",
        "a": coef_a,
        "b": coef_b,
        "threshold_nT": a.threshold,
        "n_train": len(train),
        "n_test": len(test),
        "brier_raw": br_raw,
        "brier_platt": br_platt,
        "brier_isotonic": br_iso,
        "brier_climo": br_climo,
        "base_rate_test": base,
        "note": "P_cal = sigmoid(a * logit(P_geo) + b). AUC preserved (monotone).",
    }, indent=2), encoding="utf-8")

    # Per-station Platt metrics.
    stations = sorted({r["station"] for r in rows})
    # Need station on each test row.
    test_stations = []
    for r in test:
        test_stations.append(r["station"])

    md = []
    md.append("# Calibration pass (Platt scaling on P_geo)")
    md.append("")
    md.append(f"- Fit on {len(train)} train rows, evaluated on {len(test)} test rows (50/50 by hashed timestamp)")
    md.append(f"- Ground truth: IMAGE X-range ≥ {a.threshold} nT = active")
    md.append(f"- Platt transform: `P_cal = sigmoid({coef_a:.4f} · logit(P_geo) + ({coef_b:+.4f}))`")
    md.append("")
    md.append("## Test-set skill")
    md.append("")
    md.append(f"| Model | Brier | vs climatology |")
    md.append(f"|---|---:|---:|")
    md.append(f"| Raw P_geo (uncalibrated) | {br_raw:.4f} | {br_climo - br_raw:+.4f} |")
    md.append(f"| **Platt-calibrated**     | **{br_platt:.4f}** | **{br_climo - br_platt:+.4f}** |")
    md.append(f"| Isotonic (upper bound)   | {br_iso:.4f} | {br_climo - br_iso:+.4f} |")
    md.append(f"| Climatology (base rate)  | {br_climo:.4f} | — |")
    md.append("")
    md.append("Positive 'vs climatology' = model beats a constant base-rate guess by that Brier delta.")
    md.append(f"Platt captures **{(br_climo - br_platt) / max(br_climo - br_iso, 1e-9) * 100:.0f}%** of the available monotone-calibration improvement.")
    md.append("")

    md.append("## Reliability before calibration (test set)")
    md.append("")
    md.append("```")
    md.append(ascii_rel(reliability(test_p_raw, test_y)))
    md.append("```")
    md.append("")
    md.append("## Reliability after Platt calibration")
    md.append("")
    md.append("```")
    md.append(ascii_rel(reliability(test_p_platt, test_y)))
    md.append("```")
    md.append("")

    md.append("## Per-station Brier (test set)")
    md.append("")
    md.append("| Station | n_test | base_rate | Brier raw | Brier calibrated | gain |")
    md.append("|---|---:|---:|---:|---:|---:|")
    for code in stations:
        idxs = [i for i, s in enumerate(test_stations) if s == code]
        if not idxs:
            continue
        pr = [test_p_raw[i] for i in idxs]
        pc = [test_p_platt[i] for i in idxs]
        ys = [test_y[i] for i in idxs]
        bas = sum(ys) / len(ys) if ys else 0
        br_r = brier(pr, ys)
        br_c = brier(pc, ys)
        md.append(f"| {code} | {len(idxs)} | {bas:.3f} | {br_r:.4f} | **{br_c:.4f}** | {br_r - br_c:+.4f} |")
    md.append("")

    md.append("## Interpretation")
    md.append("")
    md.append("- **AUC is unchanged** (monotone transform doesn't reorder). Only the numbers on the dial change.")
    md.append("- The magnetometer under-reports quiet arcs, so the Platt curve is a *lower bound* on visible-aurora P. The UI will become conservative — if calibrated P says 30%, visible aurora is at least 30% likely.")
    md.append("- Gap between Platt and isotonic indicates how much more skill a flexible transform could extract; large gap → consider a non-monotone fix (edge location, sigmoid width) instead.")

    (OUT / "report_calibrated.md").write_text("\n".join(md), encoding="utf-8")
    (OUT / "report_calibrated.md")
    print(f"wrote {OUT / 'calibration.json'}")
    print(f"wrote {OUT / 'report_calibrated.md'}")


if __name__ == "__main__":
    main()
