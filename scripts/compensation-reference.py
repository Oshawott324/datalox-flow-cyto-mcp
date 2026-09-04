#!/usr/bin/env python3
"""Generate the external numeric reference for conventional compensation.

This is the ground truth that `tests/core.test.ts` asserts the TypeScript
`applyCompensationColumns` (ml-matrix) implementation against. It is deliberately
an *independent* implementation path: numpy/LAPACK here, ml-matrix there.

Orientation (see docs/compensation-numeric-validation-2026-08-28.md):

    S[i][j] = fraction of fluorochrome i's signal appearing in detector j
              (row = source fluorochrome, column = destination detector)

    Xcomp = Xraw @ inv(S), computed stably as np.linalg.solve(S.T, X.T).T

Regenerate with:

    python3 scripts/compensation-reference.py

Output is written to testdata/fixtures/compensation-reference.json and is
committed, so the test suite never needs Python at runtime.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

# Expected values are rounded to this many significant decimal digits before
# being written. np.linalg.solve dispatches to LAPACK, whose last-ulp results
# can differ across BLAS builds and platforms; rounding here keeps the committed
# file stable everywhere while staying far tighter than the test's tolerance.
OUTPUT_SIGNIFICANT_DIGITS = 12

OUTPUT_PATH = Path(__file__).resolve().parent.parent / "testdata" / "fixtures" / "compensation-reference.json"


def round_sig(value: float, digits: int = OUTPUT_SIGNIFICANT_DIGITS) -> float:
    if value == 0 or not np.isfinite(value):
        return float(value)
    magnitude = int(np.floor(np.log10(abs(value))))
    return float(round(value, digits - 1 - magnitude))


def solve_compensation(spillover: np.ndarray, raw: np.ndarray) -> np.ndarray:
    """The reference equation, matching the old Datalox implementation."""
    return np.linalg.solve(spillover.T, raw.T).T


def build_case(
    case_id: str,
    description: str,
    channels: list[str],
    spillover: list[list[float]],
    raw: list[list[float]],
    notes: str,
) -> dict:
    matrix = np.array(spillover, dtype=float)
    values = np.array(raw, dtype=float)
    expected = solve_compensation(matrix, values)

    # Round-trip check: recovering the raw values from the compensated ones must
    # reproduce the input. This catches an orientation error in this script
    # itself, which the TypeScript test could not distinguish from a TS bug.
    recovered = expected @ matrix
    max_round_trip_error = float(np.max(np.abs(recovered - values)))
    assert max_round_trip_error < 1e-9, f"{case_id} failed round-trip: {max_round_trip_error}"

    return {
        "id": case_id,
        "description": description,
        "notes": notes,
        "channels": channels,
        # matrix[i][j] = fraction of fluorochrome i appearing in detector j.
        "spillover": [[round_sig(v) for v in row] for row in matrix.tolist()],
        "raw": [[round_sig(v) for v in row] for row in values.tolist()],
        "expected": [[round_sig(v) for v in row] for row in expected.tolist()],
        "conditionNumber": round_sig(float(np.linalg.cond(matrix)), 6),
    }


CASES = [
    build_case(
        case_id="identity_2x2",
        description="Identity spillover leaves values untouched.",
        channels=["FITC-A", "PE-A"],
        spillover=[[1.0, 0.0], [0.0, 1.0]],
        raw=[[100.0, 200.0], [0.0, 0.0], [-50.0, 12.5]],
        notes="Baseline no-op. Also covers negative and zero events, which are legitimate in compensated flow data.",
    ),
    build_case(
        case_id="asymmetric_2x2",
        description="Asymmetric 2x2 spillover; the orientation-discriminating case.",
        channels=["FITC-A", "PE-A"],
        spillover=[[1.0, 0.20], [0.05, 1.0]],
        raw=[[100.0, 200.0], [1000.0, 50.0], [0.0, 300.0]],
        notes=(
            "The off-diagonal terms differ (0.20 vs 0.05), so transposing S changes the answer. "
            "A symmetric fixture would pass under either orientation and prove nothing."
        ),
    ),
    build_case(
        case_id="asymmetric_3x3",
        description="Asymmetric 3x3 spillover with realistic cascade into longer wavelengths.",
        channels=["FITC-A", "PE-A", "APC-A"],
        spillover=[
            [1.0, 0.22, 0.01],
            [0.008, 1.0, 0.14],
            [0.0004, 0.003, 1.0],
        ],
        raw=[
            [1000.0, 300.0, 50.0],
            [10.0, 5000.0, 800.0],
            [0.0, 0.0, 2500.0],
        ],
        notes="Spill is much larger toward longer wavelengths than backward, matching real detector behavior.",
    ),
    build_case(
        case_id="flowcore_compref_4x4",
        description="flowCore's published FACSCalibur reference matrix (extdata/compdata/compref).",
        channels=["FL1-H", "FL2-H", "FL3-H", "FL4-H"],
        spillover=[
            [1.0, 0.242022277630705, 0.0320837058201989, 0.0011278155536909],
            [0.00772204774835748, 1.0, 0.140788231940242, 0.00263268909406355],
            [0.0150806322244329, 0.175589903184424, 1.0, 0.229593859843027],
            [0.000759031864601862, 0.000962045888046345, 0.00321861379453393, 1.0],
        ],
        raw=[
            [500.0, 200.0, 100.0, 40.0],
            [50.0, 900.0, 300.0, 60.0],
            [10.0, 20.0, 700.0, 250.0],
        ],
        notes=(
            "Externally published matrix, not one we invented. flowCore computed it from the single-stain "
            "controls in extdata/compdata/data via its own spillover() estimator, so it independently "
            "corroborates the row=fluorochrome / column=detector orientation."
        ),
    ),
    build_case(
        case_id="near_singular_2x2",
        description="Near-singular spillover; documents where the solve degrades.",
        channels=["PE-A", "PE-Cy5-A"],
        spillover=[[1.0, 0.98], [0.97, 1.0]],
        raw=[[100.0, 100.0], [500.0, 490.0]],
        notes=(
            "Condition number is high, so small input error is amplified roughly by that factor. "
            "The solve still succeeds; this is a precision caveat, not a failure case. "
            "PR1 raises singular_compensation_matrix only when the solve itself fails."
        ),
    ),
]

payload = {
    "version": 1,
    "generator": "scripts/compensation-reference.py",
    "reference": "numpy.linalg.solve(S.T, X.T).T",
    "orientation": "spillover[i][j] = fraction of fluorochrome i appearing in detector j; Xcomp = Xraw @ inv(S)",
    "significantDigits": OUTPUT_SIGNIFICANT_DIGITS,
    "cases": CASES,
}

OUTPUT_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
print(f"wrote {OUTPUT_PATH} ({len(CASES)} cases)")
