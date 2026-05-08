# Datalox Reuse Audit

Source repo inspected:

```text
/Users/yifanjin/datalox
```

Relevant source areas:

```text
/Users/yifanjin/datalox/packages/flowcytometrytools
/Users/yifanjin/datalox/src/components/plot
/Users/yifanjin/datalox/src/modules/flow
/Users/yifanjin/datalox/backend/domains/flow_cytometry
/Users/yifanjin/datalox/skills/flow_cytometry*
```

## Direct Copy Candidates

### `src/components/plot/polygon-drawer.tsx`

Verdict: copy almost directly.

Why:

- It is a focused React/Konva polygon drawing component.
- It stores vertices in data coordinates.
- It supports vertex dragging, polygon closing, whole-polygon dragging, undo, clear, and completion callbacks.
- It is not deeply tied to Datalox workflow state.

Required changes:

- Keep dependency on `react-konva` and `konva`, or rewrite to plain canvas later.
- Remove any style assumptions if they appear during integration.
- Make the callback emit this MCP workspace gate shape:

```json
{
  "type": "polygon",
  "x": "FSC-A",
  "y": "SSC-A",
  "vertices": [[1, 2], [3, 4], [5, 6]]
}
```

### `src/components/plot/canvas-scatter.tsx`

Verdict: copy directly if scatter rendering is used.

Why:

- It is a standalone canvas scatter renderer.
- It computes layout metrics and exposes them through `onMetricsChange`.
- It has very few app dependencies.

Required changes:

- Keep it presentation-only.
- Do not make it own gate state.

### `src/modules/flow/types.ts`

Verdict: copy the type shape, not necessarily the exact file.

Useful types:

```ts
export type FlowDataset = {
  channels: string[]
  data: number[][]
}

export type RectGate = {
  kind: "rect"
  id: string
  axes: [string, string]
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}

export type PolygonGate = {
  kind: "polygon"
  id: string
  axes: [string, string]
  vertices: Array<[number, number]>
}
```

For this MCP, rename or map to the canonical workspace format:

```ts
type WorkspaceGate =
  | {
      id: string
      name?: string
      parent: string
      sample: string
      type: "polygon"
      x: string
      y: string
      vertices: Array<[number, number]>
    }
  | {
      id: string
      name?: string
      parent: string
      sample: string
      type: "rect"
      x: string
      y: string
      xMin: number
      xMax: number
      yMin: number
      yMax: number
    }
```

### `src/components/plot/density-plot.tsx`

Verdict: copy with light adaptation.

Why:

- It has useful density binning and canvas rendering.
- It already separates transform helpers from rendering.
- It supports polygon/rect gate drawing overlays.

Required changes:

- Replace Datalox `GateStep` types with MCP `WorkspaceGate`.
- Remove or make explicit the auto axis transform inference.
- Keep rendering transforms as display settings, not biological decisions.
- Consider keeping only `linear` first, then add `arcsinh` or `biex` once transform semantics are explicit in the workspace artifact.

## Adapt, Do Not Directly Copy

### `src/components/plot/gating-plot.tsx`

Verdict: do not copy whole file.

Why:

- It is 1500+ lines.
- It depends on Datalox app state through `useFlow`.
- It depends on Datalox UI components, axis controls, workflow backend services, and review actions.
- It mixes rendering, local gate state, persistence callbacks, manual gate labeling, axis controls, and review behavior.

What to extract:

- Coordinate conversion helpers.
- Gate overlay math.
- Rect handle dragging behavior.
- Persistence callback shape.

Build a new smaller MCP component instead:

```text
GateEditor
  Canvas/DensityPlot
  PolygonDrawer
  RectDrawer
  GateOverlay
  Workspace polling/write callbacks
```

### `src/components/flow-cytometry/piece-details/flow-gating-detail/gating-workspace-plot.tsx`

Verdict: do not copy.

Why:

- It is a thin adapter around Datalox workflow state.
- Useful as a reference for sizing and passing gates into `GatingPlot`, but not as an MCP component.

### `src/modules/flow/gating.ts`

Verdict: do not copy whole file.

Why:

- It calls Datalox backend endpoints.
- It contains API fallback behavior.
- It is workflow-oriented, not artifact-oriented.

What to reuse:

- Gate chain shape as reference only.
- Local rectangle/polygon application concepts if needed for preview filtering.

For this MCP, invalid gates should produce machine-readable validation errors instead of silently falling back or returning empty datasets.

### `src/modules/flow/fcs.ts`

Verdict: adapt only if the MCP server is TypeScript.

Why:

- It is a browser-oriented FCS parser that takes a `File`.
- It has useful FCS text segment parsing and channel extraction.
- It depends on Datalox instrumentation and hashing.
- It includes pragmatic FCS handling that should be reviewed before becoming the canonical parser.

Recommended path:

- If MCP backend is Python: use `fcsparser` or the vendored `FlowCytometryTools` package.
- If MCP backend is TypeScript: extract this parser into a pure `parseFcsBuffer(buffer)` function and remove Datalox instrumentation.

### `backend/domains/flow_cytometry/helpers/helpers.py`

Verdict: extract small algorithms only.

Useful pieces:

- `_poly_inside`
- `mask_from_gate_step`

Do not copy the file.

Why:

- The file mixes FCS loading, compensation helpers, time-gating helpers, channel guessing, and gate masks.
- Several behaviors are Datalox workflow-specific.

For this MCP:

- Keep `mask_from_gate_step` behavior strict.
- Return validation errors for unknown channels, malformed gates, and unsupported gate kinds.
- Do not silently return all-false masks for invalid state.

### `backend/domains/flow_cytometry/gate_preview.py`

Verdict: do not copy.

Why:

- It is tightly coupled to Datalox workflow runs, project ids, run results, population graphs, Supabase/local artifact refs, and preview selection.

What to reuse:

- The idea of a preview payload containing:
  - before dataset
  - after dataset
  - axes
  - gate
  - candidate gates
  - population snapshot

For this MCP, make preview payloads file-backed and workspace-local.

### `backend/domains/flow_cytometry/gate_artifacts.py`

Verdict: do not copy.

Why:

- It supports Supabase and Datalox-local artifact storage.
- This MCP should use simple local filesystem artifacts first.

What to reuse:

- `build_gateset_summary` is a useful idea, but implement it locally against `flowcyto.workspace.json`.

## Copy Later

### `backend/domains/flow_cytometry/export/flowjo`

Verdict: copy later as a compatibility module if FlowJo `.wsp` export becomes a priority.

Why:

- The module is relatively isolated.
- It has explicit IR types, XML builder, validators, and fixtures.
- It writes FlowJo-compatible workspace XML.

Why not MVP:

- FlowJo export is an interchange feature.
- The first proof should be the live MCP artifact loop, not FlowJo compatibility.

If copied, copy the whole subdirectory plus tests/fixtures:

```text
backend/domains/flow_cytometry/export/flowjo
backend/domains/flow_cytometry/tests/tests_flowjo_export_*.py
```

Then adapt the input IR from this MCP's workspace JSON.

### `packages/flowcytometrytools`

Verdict: copy only if the MCP backend is Python and needs a local vendored FCS reader.

Why:

- It is a patched local mirror of `FlowCytometryTools==0.5.1`.
- The package is MIT licensed.
- It already handles FCS loading through `fcsparser` and includes gate primitives.

Why not direct core dependency:

- It is old.
- The GUI code is Matplotlib/WebAgg/Wx, not MCP Apps.
- The gate primitives are useful, but the MVP artifact contract should be our own.

Good use:

```text
FCS metadata/event loading for server-side preview generation.
```

Bad use:

```text
Canonical gate artifact model.
MCP interactive UI.
Agent-facing API shape.
```

## Do Not Copy

### `packages/flowcytometrytools/src/FlowCytometryTools/gui`

Verdict: do not copy.

Why:

- It is Matplotlib widget code.
- The WebAgg backend is a separate Tornado app.
- It sends Matplotlib events over websocket, not MCP App events.
- It is useful history, not the right UI substrate.

### Flow cytometry skills

Verdict: do not copy into runtime.

Why:

- They are Datalox workflow-agent instructions.
- They reference Datalox tool ids and workflow runtime behavior.

What to reuse:

- The boundary idea:

```text
backend returns deterministic evidence
agent performs interpretation and planning
```

This matches the MCP direction.

## Recommended Reuse Plan

Start by copying or extracting:

```text
src/components/plot/polygon-drawer.tsx
src/components/plot/canvas-scatter.tsx
selected pieces of src/components/plot/density-plot.tsx
selected type shapes from src/modules/flow/types.ts
```

Then write new MCP-specific code around them:

```text
workspace schema
workspace read/write/validate tools
FCS metadata/event preview tool
MCP App resource
GateEditor component
```

Do not start by copying:

```text
src/components/plot/gating-plot.tsx
backend/domains/flow_cytometry/gate_preview.py
backend/domains/flow_cytometry/gate_artifacts.py
src/modules/flow/gating.ts
```

The safest first implementation is:

```text
copy PolygonDrawer + Canvas/Density renderer
build a fresh small GateEditor around the JSON workspace artifact
```
