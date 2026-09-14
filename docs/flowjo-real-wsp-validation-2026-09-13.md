# FlowJo Real WSP Live Validation - Tet Dataset

Date: 2026-09-13

Dataset: local-only `2_20211001_Tet`

Workspace:

```text
C:\Users\fangxf\Research Tools\Flow data\2_20211001_Tet\20211130 BDC Tet.wsp
```

No `.wsp` or `.fcs` files were committed.

## Scope

Validate `import_flowjo_workspace` against a real FlowJo 10.10 workspace before claiming FlowJo import/export compatibility beyond synthetic fixtures.

The run checked:

- FlowJo sample count, gate types, hierarchy depth, and transform metadata.
- Import coverage: XML gate count versus Flowcyto imported gate count.
- BIEX transform parameter coverage.
- Compensation matrix metadata in the `.wsp`.
- Whether the tetramer single-stain controls are usable for `estimate_compensation_from_controls`.

## Metadata Probe

The workspace contains 12 samples:

- `B5 44 2-1.fcs`
- `A1 eFluor 450 Fixable Viability.fcs`
- `A2 FITC.fcs`
- `B8 44 3-1.fcs`
- `A3 PE (R-phycoerythrin).fcs`
- `A4 APC (Allophycocyanin).fcs`
- `A5 Negative Control.fcs`
- `A12 FMO Tet.fcs`
- `B1 44 1-1.fcs`
- `C1 45 1-1.fcs`
- `C5 45 2-1.fcs`
- `C8 45 3-1.fcs`

XML gate count: 58

Gate types in XML:

| FlowJo gate type | Count |
|---|---:|
| `PolygonGate` | 12 |
| `RectangleGate` | 46 |

Maximum hierarchy depth: 6

Example B1 hierarchy:

```text
root
└─ Lymphocytes
   └─ Single Cells
      └─ Single Cells
         └─ Live CD3+
            └─ CD4+
               └─ Tet+
```

Transform metadata:

| Transform | Count |
|---|---:|
| `linear` | 18 |
| `biex` | 14 |

Unique FlowJo BIEX parameter set:

```json
{
  "length": "256",
  "maxRange": "214748",
  "neg": "0",
  "width": "-10",
  "pos": "4.3319291278"
}
```

This matches the BIEX parameter set already covered by the synthetic transform fixture.

The `.wsp` contains two spillover matrices:

| Matrix name | FlowJo version | Channels |
|---|---|---|
| `Acquisition-defined` | `FlowJo-10.10.0` | `FL03-A`, `FL13-A`, `FL19-A`, `FL26-A` |
| `Compensation` | `FlowJo-10.10.0` | `FL03-A`, `FL13-A`, `FL19-A`, `FL26-A` |

## Import Result

Initial result before this validation fix:

- XML gates: 58
- Imported gates: 47
- Missing gates: 11 one-dimensional `RectangleGate` intervals from control samples.

Root cause:

FlowJo uses one-dimensional `RectangleGate` elements for positive/negative interval gates in single-stain controls. Flowcyto only imported two-dimensional `RectangleGate` elements as rect gates, and only `RangeGate`/`IntervalGate` as range gates.

Fix:

One-dimensional `RectangleGate` now imports as a Flowcyto `range` gate.

Post-fix real import:

```json
{
  "samplesImported": 12,
  "gatesImported": 58,
  "warnings": []
}
```

Imported Flowcyto gate types:

| Flowcyto gate type | Count |
|---|---:|
| `polygon` | 12 |
| `rect` | 35 |
| `range` | 11 |

B1 import result:

- Sample ID: `B1_44_1-1`
- Imported gates: 6
- Root gate: `Lymphocytes`
- Root axes: `FSC 488/10-A` vs `SSC 488/10-A`
- Child gates: `Single Cells`, `Single Cells`, `Live CD3+`, `CD4+`, `Tet+`

## Compensation Control Check

The `.wsp` compensation channels use detector names:

```text
FL03-A, FL13-A, FL19-A, FL26-A
```

The FCS parameter names are marker-style names with detector aliases:

| Parameter name | Detector |
|---|---|
| `FITC-A` | `FL03-A` |
| `PE (R-phycoerythrin)-A` | `FL13-A` |
| `eFluor 450 Fixable Viability-A` | `FL19-A` |
| `APC (Allophycocyanin)-A` | `FL26-A` |

Important finding:

`estimate_compensation_from_controls` currently reads control columns by exact parameter name. Passing detector names such as `FL03-A` returns `unknown_parameter`. Agents should pass the FCS parameter names for now. A future improvement should reuse the detector/marker alias resolver used by FlowJo import and embedded compensation alignment.

Control-estimation result using parameter names:

| Estimator | Result |
|---|---|
| All-event median | Failed: `insufficient_control_signal` for `FITC-A` |
| Bright-event 90th percentile | Succeeded |

Bright-event 90th percentile versus FlowJo `Compensation` matrix:

```text
Max off-diagonal absolute difference: 0.0990
```

Acquisition-defined matrix versus FlowJo `Compensation` matrix:

```text
Max off-diagonal absolute difference: 0.00211
```

Interpretation:

This tetramer dataset is a strong FlowJo import validation fixture, but it is not a clean numeric validation fixture for control-derived compensation. The FlowJo `Compensation` matrix is much closer to the acquisition-defined matrix than to the current median estimator output from the visible single-stain controls.

## Follow-Ups

1. Keep this dataset as a local-only real FlowJo import validation target.
2. Add detector/marker alias resolution to `estimate_compensation_from_controls`, so agents can use matrix-style detector names where the FCS has marker-style parameter names.
3. Do not use this tetramer control set as the primary numeric acceptance fixture for control-derived compensation.
4. If redistribution is cleared, add a derived expected-gates JSON fixture rather than committing the real `.wsp` or `.fcs`.
