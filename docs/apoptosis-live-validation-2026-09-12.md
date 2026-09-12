# Apoptosis Gating Live Validation

Date: 2026-09-12

Local validation dataset, not committed:

```text
C:\Users\fangxf\Research Tools\Flow data\7_Apoptosis_cwq
```

Disposable workspace:

```text
C:\tmp\flowcyto-apoptosis-live-bH06iu\flowcyto.workspace.json
```

## Files Used

| Role | File | Sample ID |
|---|---|---|
| Analysis sample | `Apoptosis-DC2.4_Group_1.fcs` | `group_1` |
| Negative control | `Apoptosis-DC2.4_Group_unstain.fcs` | `unstain` |

## Channels

```text
annexin_channel = Annexin X-FITC-A
death_channel = PI-PerCP-Cy5.5-A
```

The embedded `$SPILLOVER` matrix uses detector codes:

```text
BL1-A, BL3-A, BL1-H, BL3-H, BL1-W, BL3-W
```

Live validation confirmed compensation alignment maps detector-coded matrix
channels to user-facing parameter names:

```text
BL1-A -> Annexin X-FITC-A
BL3-A -> PI-PerCP-Cy5.5-A
BL1-H -> Annexin X-FITC-H
BL3-H -> PI-PerCP-Cy5.5-H
BL1-W -> Annexin X-FITC-W
BL3-W -> PI-PerCP-Cy5.5-W
```

## Tool Call

Core API exercised:

```ts
suggestApoptosisQuadrants({
  workspacePath,
  sampleId: "group_1",
  annexinChannel: "Annexin X-FITC-A",
  deathChannel: "PI-PerCP-Cy5.5-A",
  negativeControl: { sampleId: "unstain" },
  negativePercentile: 99.5,
  compensationId: "fcs_spillover_group_1"
})
```

## Result

Thresholds:

```text
annexin = 533.2261941800543
death   = 4980.894487154523
method  = negative_control_percentile
source  = negative_control
```

Finite quadrant bounds:

```text
xMin = -5758.125810209713
xMax = 1048313.505516209
yMin = -2192.924164061507
yMax = 991058.6739376283
```

Compensation:

```text
applied = true
id      = fcs_spillover_group_1
source  = fcs_keyword
channels after alignment:
  Annexin X-FITC-A
  PI-PerCP-Cy5.5-A
  Annexin X-FITC-H
  PI-PerCP-Cy5.5-H
  Annexin X-FITC-W
  PI-PerCP-Cy5.5-W
```

Population summary:

| Population | Count | Percent of parent |
|---|---:|---:|
| Viable | 12,110 | 71.47916420729547 |
| Early apoptotic | 4,201 | 24.796364065635697 |
| Late apoptotic/dead | 621 | 3.6654468185574314 |
| Necrotic/membrane damaged | 10 | 0.059024908511391805 |

Parent events:

```text
16,942
```

Diagnostics:

```text
confidence = control_anchored
warnings   = []
gateCount  = 4
nextAction = upsert_gates
```

## Interpretation

This validates the implementation contract against real local data:

- The tool stays read-only and returns four proposed gates.
- Thresholds are anchored to the unstained control.
- Compensation is explicit via `compensationId`.
- Detector-code spillover channels align to user-facing parameter names.
- Quadrant gates use finite bounds compatible with workspace validation.

No FCS files from this dataset are committed.
