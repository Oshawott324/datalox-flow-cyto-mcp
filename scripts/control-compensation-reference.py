#!/usr/bin/env python3
"""Reference analysis for PR2 control-derived compensation.

Estimates a spillover matrix from the flowCore compdata single-stain controls and
compares it against flowCore's own published result (extdata/compdata/compref), so
PR2 has an external expected value rather than only self-consistency.

Also quantifies the failure modes the plan asks PR2 to handle: insufficient events,
missing unstained background, and — the one that matters most — control-to-channel
mappings inferred from filename order.

Control-to-channel mapping is read from the `control` blocks in
testdata/fixtures/manifest.json, which transcribe flowCore's own `comp_match` file.
Nothing here infers a channel from a filename; see the mis-mapping experiment for why.

Regenerate with:

    python3 scripts/control-compensation-reference.py

Requires numpy and the fixtures (`npm run fixtures:fetch`). Output is committed, so
the test suite never needs Python at runtime.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = ROOT / "testdata" / "fixtures" / "manifest.json"
OUTPUT_PATH = ROOT / "testdata" / "fixtures" / "control-compensation-reference.json"

# See scripts/compensation-reference.py for why output is rounded.
OUTPUT_SIGNIFICANT_DIGITS = 12

FLUORESCENCE_CHANNELS = ["FL1-H", "FL2-H", "FL3-H", "FL4-H"]

# flowCore/inst/extdata/compdata/compref — the matrix flowCore's own spillover()
# estimator produces from these five controls. Transcribed verbatim.
FLOWCORE_COMPREF = [
    [1.0, 0.242022277630705, 0.0320837058201989, 0.0011278155536909],
    [0.00772204774835748, 1.0, 0.140788231940242, 0.00263268909406355],
    [0.0150806322244329, 0.175589903184424, 1.0, 0.229593859843027],
    [0.000759031864601862, 0.000962045888046345, 0.00321861379453393, 1.0],
]


def round_sig(value: float, digits: int = OUTPUT_SIGNIFICANT_DIGITS) -> float:
    if value == 0 or not np.isfinite(value):
        return float(value)
    magnitude = int(np.floor(np.log10(abs(value))))
    return float(round(value, digits - 1 - magnitude))


def round_matrix(matrix: np.ndarray) -> list[list[float]]:
    return [[round_sig(v) for v in row] for row in np.asarray(matrix).tolist()]


def read_fcs(path: Path) -> dict:
    """Minimal FCS 2.0/3.0 reader for integer-encoded list-mode data."""
    buf = path.read_bytes()
    header = buf[:58].decode("latin1")
    text_start, text_end = int(header[10:18]), int(header[18:26])
    data_start, data_end = int(header[26:34]), int(header[34:42])

    text = buf[text_start:text_end + 1].decode("latin1")
    delimiter = text[0]
    parts = text[1:].split(delimiter)
    keywords = {parts[i].strip(): parts[i + 1] for i in range(0, len(parts) - 1, 2)}

    parameters = int(keywords["$PAR"])
    events = int(keywords["$TOT"])
    if keywords["$DATATYPE"].upper() != "I":
        raise NotImplementedError(f"{path.name}: only $DATATYPE I is supported here")
    if data_start == 0:
        data_start, data_end = int(keywords["$BEGINDATA"]), int(keywords["$ENDDATA"])

    widths = {int(keywords[f"$P{i}B"]) for i in range(1, parameters + 1)}
    if len(widths) != 1:
        raise NotImplementedError(f"{path.name}: mixed parameter widths {widths}")
    width = widths.pop() // 8
    little_endian = keywords.get("$BYTEORD", "1,2,3,4").replace(" ", "").startswith("1,2")
    dtype = np.dtype(("<" if little_endian else ">") + {1: "u1", 2: "u2", 4: "u4"}[width])

    raw = np.frombuffer(buf[data_start:data_start + events * parameters * width], dtype=dtype)
    values = raw.reshape(events, parameters).astype(float)

    # $PnE log amplification. FACSCalibur fluorescence channels are stored as 4-decade
    # log values; compensation is only meaningful on the linearized scale.
    for i in range(parameters):
        decades, offset = (float(x) for x in keywords.get(f"$P{i + 1}E", "0,0").split(","))
        if decades > 0:
            channel_range = float(keywords[f"$P{i + 1}R"])
            values[:, i] = (offset or 1.0) * 10 ** (decades * values[:, i] / channel_range)

    names = [keywords[f"$P{i}N"] for i in range(1, parameters + 1)]
    return {"keywords": keywords, "names": names, "values": values}


def channel_columns(fcs: dict, channels: list[str]) -> np.ndarray:
    index = {name: i for i, name in enumerate(fcs["names"])}
    return np.column_stack([fcs["values"][:, index[c]] for c in channels])


def estimate_median(
    controls: dict[str, np.ndarray],
    mapping: dict[str, str],
    background: np.ndarray,
) -> np.ndarray:
    """flowCore's method: per-channel median, minus unstained background, row-normalized.

    Row i is the single-stain control for channel i; entry [i][j] is that stain's
    signal in detector j relative to its own detector. Matches the orientation
    documented in docs/compensation-numeric-validation-2026-08-28.md.
    """
    rows = {}
    for control_id, channel in mapping.items():
        medians = np.median(controls[control_id], axis=0) - background
        rows[channel] = medians / medians[FLUORESCENCE_CHANNELS.index(channel)]
    return np.array([rows[c] for c in FLUORESCENCE_CHANNELS])


def estimate_bright_event_ols(
    controls: dict[str, np.ndarray],
    mapping: dict[str, str],
    background: np.ndarray,
    percentile: float,
) -> np.ndarray:
    """The top-bright-event regression the plan attributes to the old Datalox code.

    Reconstructed from the plan's description (bright-event percentile, OLS), not
    ported from that source, which was not available here. Slope is fitted through
    the origin on background-subtracted values.
    """
    rows = {}
    for control_id, channel in mapping.items():
        column = FLUORESCENCE_CHANNELS.index(channel)
        events = controls[control_id] - background
        bright = events[events[:, column] >= np.percentile(events[:, column], percentile)]
        stain = bright[:, column]
        slopes = np.array([(stain @ bright[:, k]) / (stain @ stain) for k in range(len(FLUORESCENCE_CHANNELS))])
        rows[channel] = slopes / slopes[column]
    return np.array([rows[c] for c in FLUORESCENCE_CHANNELS])


def max_abs_error(estimate: np.ndarray) -> float:
    return float(np.max(np.abs(estimate - np.array(FLOWCORE_COMPREF))))


def main() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf8"))
    fixtures = {f["id"]: f for f in manifest["fixtures"] if "control" in f}

    unstained_ids = [i for i, f in fixtures.items() if f["control"]["role"] == "unstained"]
    if len(unstained_ids) != 1:
        raise SystemExit(f"expected exactly one unstained control, found {unstained_ids}")

    controls: dict[str, np.ndarray] = {}
    event_counts: dict[str, int] = {}
    for fixture_id, fixture in fixtures.items():
        path = ROOT / fixture["path"]
        if not path.exists():
            raise SystemExit(f"{path} is missing; run: npm run fixtures:fetch")
        fcs = read_fcs(path)
        controls[fixture_id] = channel_columns(fcs, FLUORESCENCE_CHANNELS)
        event_counts[fixture_id] = controls[fixture_id].shape[0]

    unstained_id = unstained_ids[0]
    background = np.median(controls[unstained_id], axis=0)
    mapping = {
        fixture_id: fixture["control"]["channel"]
        for fixture_id, fixture in fixtures.items()
        if fixture["control"]["role"] == "single_stain"
    }
    if sorted(mapping.values()) != sorted(FLUORESCENCE_CHANNELS):
        raise SystemExit(f"single-stain controls must cover each channel exactly once: {mapping}")

    median_estimate = estimate_median(controls, mapping, background)

    ols_variants = []
    for percentile in (50.0, 80.0, 90.0, 95.0, 99.0):
        estimate = estimate_bright_event_ols(controls, mapping, background, percentile)
        ols_variants.append({
            "brightestPercent": round_sig(100.0 - percentile, 6),
            "matrix": round_matrix(estimate),
            "maxAbsErrorVsCompref": round_sig(max_abs_error(estimate), 6),
        })

    # Failure mode: channel assignment guessed from filename order. flowCore's
    # comp_match maps .004 to FL4-H and .005 to FL3-H, so ordinal order is wrong.
    ordinal_mapping = dict(zip(sorted(mapping), FLUORESCENCE_CHANNELS))
    ordinal_estimate = estimate_median(controls, ordinal_mapping, background)

    # Failure mode: no unstained control, so no background subtraction.
    no_background_estimate = estimate_median(controls, mapping, np.zeros(len(FLUORESCENCE_CHANNELS)))

    # Failure mode: too few events. Subsampled with fixed seeds so this is reproducible.
    smallest_control = min(event_counts[c] for c in mapping)
    event_budget = []
    for size in (2000, 1000, 300, 100, 30, 10):
        if size > smallest_control:
            continue
        errors = []
        for seed in range(20):
            rng = np.random.default_rng(seed)
            sampled = {
                cid: values[rng.choice(len(values), size, replace=False)]
                for cid, values in controls.items()
            }
            errors.append(max_abs_error(estimate_median(sampled, mapping, np.median(sampled[unstained_id], axis=0))))
        event_budget.append({
            "eventsPerControl": size,
            "medianMaxAbsError": round_sig(float(np.median(errors)), 6),
            "worstMaxAbsError": round_sig(float(np.max(errors)), 6),
        })

    payload = {
        "version": 1,
        "generator": "scripts/control-compensation-reference.py",
        "channels": FLUORESCENCE_CHANNELS,
        "orientation": "matrix[i][j] = fraction of fluorochrome i appearing in detector j",
        "significantDigits": OUTPUT_SIGNIFICANT_DIGITS,
        "controls": {
            "unstained": unstained_id,
            "singleStain": mapping,
            "mappingSource": "flowCore compdata comp_match, transcribed into manifest control blocks",
            "eventCounts": event_counts,
        },
        "flowcoreCompref": round_matrix(np.array(FLOWCORE_COMPREF)),
        "medianEstimate": {
            "description": "Linearize per $PnE, take per-channel medians, subtract unstained medians, row-normalize by the stain's own channel.",
            "matrix": round_matrix(median_estimate),
            "maxAbsErrorVsCompref": round_sig(max_abs_error(median_estimate), 6),
        },
        "brightEventOlsVariants": ols_variants,
        "failureModes": {
            "filenameOrdinalMapping": {
                "description": "Channels assigned by sorted filename order instead of comp_match.",
                "mapping": ordinal_mapping,
                "matrix": round_matrix(ordinal_estimate),
                "maxAbsErrorVsCompref": round_sig(max_abs_error(ordinal_estimate), 6),
                "conditionNumber": round_sig(float(np.linalg.cond(ordinal_estimate)), 6),
                "correctConditionNumber": round_sig(float(np.linalg.cond(np.array(FLOWCORE_COMPREF))), 6),
            },
            "noUnstainedBackground": {
                "description": "No unstained control, so medians are not background-subtracted.",
                "matrix": round_matrix(no_background_estimate),
                "maxAbsErrorVsCompref": round_sig(max_abs_error(no_background_estimate), 6),
            },
            "insufficientEvents": {
                "description": "Median estimator on subsampled controls, 20 fixed seeds per size.",
                "trials": 20,
                "results": event_budget,
            },
        },
    }

    OUTPUT_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf8")
    print(f"wrote {OUTPUT_PATH}")
    print(f"median estimate vs flowCore compref: max abs error {max_abs_error(median_estimate):.3e}")


if __name__ == "__main__":
    main()
