#!/usr/bin/env python3
"""
generate-flowjo-biex-reference.py  —  SUPPLEMENTARY CROSS-VALIDATOR
                                       (not the primary fixture generator)

Primary fixture generator: scripts/generate-flowjo-biex-reference.R

This script is a SECONDARY cross-validator. Its job is to verify that the
fixture JSON produced by the R script is consistent with a Python
implementation. It is NOT authoritative for the fixture values.

Why R is primary
----------------
  flowWorkspace::flowjo_biexp() takes FlowJo's .wsp attribute names directly
  (maxRange, pos, neg, widthBasis, length) with no parameter mapping needed.
  It is the closest publicly available reimplementation of FlowJo's biex
  transform, backed by the same cytolib logic.

Why Python is supplementary
---------------------------
  FlowKit's LogicleTransform takes Parks-2006 logicle parameters (T, W, M, A),
  not FlowJo's biex parameters. A mapping is required:
    T = maxRange
    M = pos + neg
    A = neg
    W = f(widthBasis)      <-- uncertain; _width_to_w() below is approximate

  The _width_to_w() conversion is an approximation derived from the observation
  that widthBasis=-10 ≈ 1 decade of linear region. It has NOT been cross-
  validated against flowWorkspace output. Treat this script's output as a
  consistency check, not as ground truth.

Workflow
--------
  1. Run the R script to generate the authoritative fixture:
       Rscript scripts/generate-flowjo-biex-reference.R
     This writes testdata/fixtures/biex-transform-reference.json.

  2. (Optional) Install FlowKit and run this script:
       pip install FlowKit numpy
       python scripts/generate-flowjo-biex-reference.py
     If this script's display values differ from the R fixture by more than
     1 channel unit for any parameter set, investigate _width_to_w().

  3. After the R fixture is committed and a clean-room TypeScript implementation
     is written (src/core/biex-transform.ts), run the test suite:
       npm test
     The TypeScript implementation must match testdata/fixtures/biex-transform-reference.json
     within toleranceAbsolute for every case.

MIT-licensing note:
  This script calls only the FlowKit public API and records numeric output.
  It does not incorporate any cytolib or flowWorkspace source. The output
  is measurement data, not a derived work.

Requirements:
  pip install FlowKit numpy
"""

import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import numpy as np
except ImportError:
    sys.exit("numpy is required: pip install numpy")

try:
    import FlowKit as fk
except ImportError:
    sys.exit("FlowKit is required: pip install FlowKit")

# Same parameter sets as the R script (generate-flowjo-biex-reference.R)
PARAMETER_SETS = [
    {
        "label":    "flowjo_defaults",
        "notes":    "FlowJo 10 factory defaults for a 18-bit instrument",
        "length":   256,
        "maxRange": 262144,
        "pos":      4.5,
        "neg":      0.0,
        "width":    -10.0,
    },
    {
        "label":    "flowjo_defaults_neg1",
        "notes":    "FlowJo 10 defaults with 1 negative decade (common for PI/viability)",
        "length":   256,
        "maxRange": 262144,
        "pos":      4.5,
        "neg":      1.0,
        "width":    -10.0,
    },
    {
        "label":    "fixture_wsp_biex",
        "notes":    "Parameters from testdata/fixtures/flowjo/transform-log-fasinh.wsp BIEX-A gate",
        "length":   256,
        "maxRange": 214748,
        "pos":      4.3319291278,
        "neg":      0.0,
        "width":    -10.0,
    },
    {
        "label":    "aurora_style",
        "notes":    "Typical Aurora 5-laser parameters seen in cytometry literature",
        "length":   256,
        "maxRange": 262144,
        "pos":      4.0,
        "neg":      0.0,
        "width":    -10.0,
    },
    {
        "label":    "narrow_width",
        "notes":    "Wider linear region (less negative widthBasis) — edge case for root-finder",
        "length":   256,
        "maxRange": 262144,
        "pos":      4.5,
        "neg":      0.0,
        "width":    -100.0,
    },
]

INPUTS = [
    -262144, -100000, -50000, -10000, -5000, -1000, -500, -100, -50, -10,
    -5, -1, 0, 1, 5, 10, 50, 100, 500, 1000, 5000, 10000,
    50000, 100000, 200000, 250000, 262143,
]


def _width_to_w(width_basis: float, neg: float) -> float:
    """
    Approximate conversion: FlowJo widthBasis → logicle W.

    CAUTION: this formula is an approximation.
    widthBasis=-10  →  W=log10(10)=1   (1 decade of linear region)
    widthBasis=-100 →  W=log10(100)=2  (2 decades of linear region)

    This has NOT been verified against flowWorkspace::flowjo_biexp(). If the
    Python output disagrees with the R fixture by more than ~1 channel unit,
    the formula is wrong. Investigate cytolib's biexp_impl.cpp (AGPL, read-only
    for reference) or the Bagwell 2005 supplemental for the exact relationship.
    """
    if width_basis >= 0:
        raise ValueError(f"widthBasis must be negative, got {width_basis}")
    return math.log10(-width_basis)


def build_case(params: dict) -> dict:
    """Apply FlowKit logicle forward and inverse for one parameter set."""
    w = _width_to_w(params["width"], params["neg"])
    xform = fk.transforms.LogicleTransform(
        "biex",
        param_t=float(params["maxRange"]),
        param_m=float(params["pos"]) + float(params["neg"]),
        param_w=w,
        param_a=float(params["neg"]),
    )

    inputs = np.array(INPUTS, dtype=float)
    display_unit = xform.apply(inputs / float(params["maxRange"]))
    display_scaled = display_unit * float(params["length"])
    round_trip_unit = xform.inverse(display_unit)
    round_trip = round_trip_unit * float(params["maxRange"])

    max_err = float(np.max(np.abs(round_trip - inputs)))
    tolerance = max(1e-6, max_err * 10)

    return {
        "label":   params["label"],
        "notes":   params["notes"],
        "parameters": {
            "length":   params["length"],
            "maxRange": params["maxRange"],
            "pos":      params["pos"],
            "neg":      params["neg"],
            "width":    params["width"],
        },
        "logicleWUsed": w,
        "inputs":             INPUTS,
        "display":            display_scaled.tolist(),
        "roundTrip":          round_trip.tolist(),
        "roundTripMaxError":  max_err,
        "toleranceAbsolute":  tolerance,
    }


def compare_with_r_fixture(cases: list) -> None:
    """If the R fixture exists, print per-case max difference."""
    repo_root = Path(__file__).resolve().parent.parent
    r_fixture_path = repo_root / "testdata" / "fixtures" / "biex-transform-reference.json"
    if not r_fixture_path.exists():
        print(
            "\nR fixture not found — run generate-flowjo-biex-reference.R first "
            "to enable cross-validation."
        )
        return

    with open(r_fixture_path, encoding="utf-8") as f:
        r_data = json.load(f)

    r_by_label = {c["label"]: c for c in r_data["cases"]}
    print("\nCross-validation against R fixture:")
    all_ok = True
    for case in cases:
        label = case["label"]
        if label not in r_by_label:
            print(f"  {label:<30}  (not in R fixture — skipped)")
            continue
        r_display = np.array(r_by_label[label]["display"])
        py_display = np.array(case["display"])
        max_diff = float(np.max(np.abs(py_display - r_display)))
        flag = "  OK" if max_diff < 1.0 else "  ** MISMATCH — check _width_to_w **"
        print(f"  {label:<30}  max|Py-R| = {max_diff:.4f} channel units{flag}")
        if max_diff >= 1.0:
            all_ok = False

    if all_ok:
        print("  All cases agree within 1 channel unit.")
    else:
        print(
            "\n  Mismatch > 1 channel unit means _width_to_w() is incorrect "
            "for those parameter sets. Do not use this script's output as the "
            "fixture — use the R fixture instead."
        )


def main() -> None:
    repo_root = Path(__file__).resolve().parent.parent
    output_path = repo_root / "testdata" / "fixtures" / "biex-transform-reference-python.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    fk_version = getattr(fk, "__version__", "unknown")

    cases = []
    for params in PARAMETER_SETS:
        try:
            case = build_case(params)
            cases.append(case)
            print(f"  {case['label']:<30}  round-trip max err = {case['roundTripMaxError']:.2e}")
        except Exception as exc:
            print(f"  {params['label']:<30}  ERROR: {exc}", file=sys.stderr)
            raise

    result = {
        "generator":        "FlowKit.transforms.LogicleTransform (SUPPLEMENTARY — see R script)",
        "flowKitVersion":   fk_version,
        "generatedAt":      datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "warning": (
            "This file is a supplementary cross-validator. "
            "The authoritative fixture is biex-transform-reference.json "
            "generated by generate-flowjo-biex-reference.R. "
            "The _width_to_w() conversion (widthBasis→W) is an approximation "
            "that has not been independently verified. "
            "If any case disagrees with the R fixture by >1 channel unit, "
            "correct _width_to_w() before trusting this output."
        ),
        "cases": cases,
    }

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, allow_nan=False)
        f.write("\n")

    print(f"\nWrote {output_path}")

    compare_with_r_fixture(cases)


if __name__ == "__main__":
    main()
