# Real Dataset Live Test - 2026-05-12

Dataset:

```text
/Users/yifanjin/Downloads/2_20211001_Tet
```

Scope:

```text
Validate Flowcyto MCP against a real local FlowJo-style dataset, not only the
small packaged fixture.

The test path is the agent path:
  open_fcs -> render_plot/get_plot_context -> upsert_gate

The UI path is the compact MCP app preview:
  start local gate editor server -> render compact app -> external gate write ->
  already-open app refreshes by workspace revision polling
```

Follow-up auto-open live test:

```text
docs/compact-viewer-auto-open-live-test-2026-05-12.md
```

## Files Tested

The dataset contains one FlowJo workspace and 12 FCS files:

```text
20211130 BDC Tet.wsp
A1 eFluor 450 Fixable Viability.fcs
A12 FMO Tet.fcs
A2 FITC.fcs
A3 PE (R-phycoerythrin).fcs
A4 APC (Allophycocyanin).fcs
A5 Negative Control.fcs
B1 44 1-1.fcs
B5 44 2-1.fcs
B8 44 3-1.fcs
C1 45 1-1.fcs
C5 45 2-1.fcs
C8 45 3-1.fcs
```

The `.wsp` file was not imported. Current Flowcyto alpha treats
`flowcyto.workspace.json` as the canonical artifact and uses `.fcs` files as
sample inputs.

## Issue 1: Vendor `$ENDDATA` One Past EOF

Observed failure:

```text
Invalid DataView length 1979277
```

This affected every tested FCS file in this dataset.

Root cause:

```text
The FCS header/TEXT metadata declared $ENDDATA as the file byte length instead
of the last zero-based byte offset.

Example:
  file size:      1,981,582
  $BEGINDATA:    2,306
  $ENDDATA:      1,981,582
  declared bytes: 1,979,277
  $TOT * rowSize: 1,979,276
  available bytes from begin to EOF: 1,979,276
```

Solution:

```text
For list-mode event reads, Flowcyto now uses the exact required byte count:

  expectedDataLength = $TOT * rowSize

The parser still validates that the declared segment and file contents are at
least that long. It does not silently accept truncated event data.
```

Files changed:

```text
src/core/fcs.ts
tests/core.test.ts
```

Regression test:

```text
reads FCS data when vendor $ENDDATA is one past EOF but $TOT and row width match
```

## Issue 2: Real Dataset FSC/SSC Area Channel Selection

Observed behavior:

```text
The metadata names are not simple FSC-A / SSC-A. They use names such as:

  FSC 488/10-H
  FSC 488/10-A
  SSC 488/10-H
  SSC 488/10-A

The earlier recommender could pick the first FSC/SSC channel, which may be a
height channel.
```

Solution:

```text
When choosing the main population view, Flowcyto now prefers area channels:

  exact FSC-A / SSC-A
  then FSC...-A / SSC...-A
  then the first FSC / SSC channel
  then the first two parameters
```

This is not a gate algorithm. It only selects a sensible default plot view for
agents and the compact UI.

Files changed:

```text
src/core/workspace.ts
```

## Dataset Scan Result

Command shape:

```text
For each .fcs:
  openFcsArtifact(path, workspaceDir)
  getEventPreview(format="bins", binWidth=64, binHeight=64)
  validateWorkspace(workspacePath)
```

Result:

```text
12 / 12 FCS files passed metadata parse, binned preview generation, and
workspace validation.
```

All files resolved to the default main population view:

```text
FSC 488/10-A / SSC 488/10-A
```

Event counts ranged from 4,751 to 88,570 events. Binned previews sampled up to
10,000 events per file.

## Compact UI Live Refresh Result

Representative sample:

```text
A12 FMO Tet.fcs
sampleId: A12_FMO_Tet
view: FSC 488/10-A / SSC 488/10-A
```

Checks:

```text
compact MCP app preview loaded
canvas rendered nonblank pseudocolor plot
external upsert_gate wrote Agent Main Population Gate
already-open app refreshed from Ready revision 0 to Workspace revision 1
gate list showed Agent Main Population Gate
```

Canvas check:

```text
canvas: 300 x 300
non-background pixels: 41,448
```

## Pass Criteria

```text
npm run build passes
npm test passes
real dataset scan passes 12 / 12 FCS files
compact UI live-refresh smoke passes on A12 FMO Tet.fcs
```

## Remaining Non-Goals

```text
FlowJo .wsp import is still not implemented.
Compensation and transforms from the FlowJo workspace are not imported.
The agent still owns gate geometry; Flowcyto renders previews and writes gates.
```
