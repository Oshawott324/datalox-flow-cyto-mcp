# FlowJo .wsp Test Fixtures

## Hand-crafted fixtures (in this directory)

These fixtures test the structure of the import parser. They are hand-crafted based on the
Gating-ML 2.0 namespace spec and FlowJo 10 XML conventions, but have NOT been opened in FlowJo
to verify round-trip correctness.

| File | Contents | Purpose |
|---|---|---|
| `minimal-linear-polygon.wsp` | One polygon gate on FSC-A vs SSC-A (linear axes) | Import parser: polygon gate, no transform inversion needed |
| `minimal-linear-rect.wsp` | One rect gate on FSC-A vs SSC-A | Import parser: rectangle gate |
| `nested-hierarchy.wsp` | Three-level gate hierarchy | Import parser: gate hierarchy, parent_id chaining |

## Real FlowJo fixtures (NOT YET ADDED — required before PR B ships)

Before the export tool is declared merge-ready, add a real FlowJo 10 .wsp:

1. Open FlowJo with the tetramer dataset (`B1 44 1-1.fcs`).
2. File → Export → Workspace → Save as `reference-flowjo10-export.wsp`.
3. Copy here and add to this README.

This real fixture:
- Validates that the import parser correctly reads FlowJo 10 output.
- Serves as the round-trip target: import → workspace.json → export → re-open in FlowJo.
- Confirms coordinate space handling (biexp transform for fluorescence channels).

Do not commit `.fcs` files, real lab `.wsp` files, or any cohort/patient data. Only synthetic `.wsp`
fixtures and derived JSON.

Real FlowJo reference file for live validation (local only — do not commit):

```
C:\Users\fangxf\University of Michigan Dropbox\Fang Xie\shared yifan yifanlaojin and fang\AI for wet lab scientists\Flow data\2_20211001_Tet\20211130 BDC Tet.wsp
```

This is a real FlowJo 10 workspace for the tetramer dataset. Use it to validate the import
parser against real FlowJo output and as the round-trip target for the export tool.

## Coordinate space notes

FlowJo stores gate vertices in display space (post-transform). See the plan doc for details:
`docs/flowjo-import-export-plan-2026-09-02.md`

The hand-crafted fixtures use linear axes only (FSC/SSC), so display space equals data space
and no transform inversion is needed. Tests for fluorescence channels (log/biexp) require a
real FlowJo fixture.
