# Implementation Details

## MVP Shape

A small window containing one interactive cytometry plot is enough for the first version.

It should not be only a chart. It should be a file-backed gate editor:

```text
FCS file -> MCP tools -> interactive plot -> workspace JSON -> agent reads/updates JSON -> plot refreshes
```

The UI can be small, but the artifact boundary must be complete.

## Performance Goal

The product goal is speedy parsing and a smooth manual gating experience.

Optimize the MVP for:

```text
fast metadata read
fast first preview
stable 60fps gate drawing/editing where possible
no UI stalls during FCS parsing or preview generation
small structured writes to the workspace artifact
```

Do not optimize first for full analysis throughput. The agent can run heavier computation outside the interactive path.

Interactive path:

```text
open workspace -> metadata -> preview points/bins -> draw/edit gate -> write JSON
```

Non-interactive path:

```text
full data read -> statistics -> batch gate application -> reports
```

Keep those paths separate. The gate editor should never need to load the full dataset into the browser just to draw a gate.

Live artifact behavior is a core goal, not polish.

Required loop:

```text
human edits gate in UI -> workspace revision increments -> agent sees updated JSON
agent edits workspace JSON -> revision increments -> UI refreshes without reopening
```

The UI is only successful if agent-side changes become visible while the gate editor is open.

## Recommended Tech Stack

Use TypeScript end-to-end for the MVP.

Recommended stack:

```text
runtime: Node.js 20+
server: TypeScript MCP server
parse workers: Node worker_threads
MCP UI: MCP Apps resource
frontend: React + Vite
plot raster: Canvas 2D
gate overlay: React Konva or SVG
validation: TypeBox + Ajv
CLI: Commander or a small custom argv parser
tests: Vitest + Playwright
```

Why TypeScript first:

- MCP server and MCP App fit naturally in the same language.
- Datalox already has reusable React plot/gate components.
- The UI can share gate/workspace types with the server.
- Packaging is simpler than a Node + Python hybrid.
- The agent can inspect and patch one codebase.

Do not use a general charting library as the core plot engine.

Avoid for the MVP:

```text
ECharts as the gate editor core
Matplotlib/WebAgg
Python GUI frameworks
desktop-only UI frameworks
server roundtrips during drag
full event tables in browser state
```

Use:

```text
Canvas 2D for density/scatter pixels
Konva or SVG for gate vectors and handles
MCP tools for file/preview/workspace access
local React state for in-progress gate edits
```

## Hot Path Choices

The performance hot path is:

```text
FCS file -> selected columns -> preview points/bins -> canvas pixels
```

Keep this path narrow.

### FCS Parsing

Start with a TypeScript FCS reader adapted from Datalox:

```text
/Users/yifanjin/datalox/src/modules/flow/fcs.ts
```

Required shape:

```ts
type FcsReader = {
  readMetadata(path: string): Promise<SampleMetadata>
  readPreviewColumns(input: {
    path: string
    x: string
    y: string
    maxEvents?: number
  }): Promise<PreviewColumns>
}
```

Internal preview data should use typed arrays:

```ts
type PreviewColumns = {
  x: Float32Array | Float64Array
  y: Float32Array | Float64Array
  totalEvents: number
}
```

If TypeScript FCS parsing is not fast or robust enough after fixture testing, replace only the `FcsReader` implementation. Do not change the MCP tools, UI, workspace schema, or CLI command contract.

Possible later replacements:

```text
Rust parser through napi-rs
Rust parser compiled to WASM
explicit Python sidecar using fcsparser
```

Do not add hidden parser fallback. Pick one configured parser and surface direct errors.

Run FCS parsing and preview generation in a worker thread:

```text
MCP tool request -> preview worker -> typed arrays/bins -> capped MCP response
```

The MCP server event loop should stay responsive while a large file is being parsed. The UI still waits for the preview result, but other tools and cancellation/status handling should not be blocked by CPU-heavy parsing.

### Preview Rendering

Use two preview formats:

```text
points: small sampled previews
bins: large previews and smooth density rendering
```

For large files, bins are the default. Sending huge point arrays through MCP JSON is the wrong bottleneck.

Cache binary preview data under `.datalox/cache/previews/`:

```text
.datalox/cache/previews/<cache-key>.json
.datalox/cache/previews/<cache-key>.bin
```

The JSON sidecar stores axes, scale, bounds, dimensions, and source file fingerprint. The binary file stores `Float32Array` points or `Uint32Array` bin counts.

The MCP response can still be JSON, but it should be capped:

```text
small points response: ok
large bins response: ok
large raw points response: reject or require explicit override
```

### UI Rendering

Use one raster layer and one vector layer:

```text
Canvas 2D: preview points/bins
Konva/SVG: gates, vertices, handles, in-progress drawing
```

Do not put cytometry events into React state as individual components.

Do not put cytometry events into Konva nodes.

React state should hold:

```text
workspace JSON
current view
selected gate id
in-progress gate draft
preview response reference
validation/write status
```

Canvas owns the pixels. React owns intent/state. MCP tools own files.

## UI Posture

Do not make this feel like a standalone web app.

MCP Apps use web technology and render as sandboxed iframe views inside host clients, but the product surface should be an embedded tool panel for the agent session.

The right posture is:

```text
small instrument panel, not website
artifact editor, not dashboard
agent-side tool view, not user-facing SaaS
```

Avoid:

- landing pages
- navigation shells
- marketing layout
- account/project chrome
- explanatory onboarding panels
- broad dashboard composition

Use:

- one plot-first surface
- compact controls around the plot
- dense but clear toolbars
- machine-readable validation messages
- direct save/write behavior into the workspace artifact

The host conversation is the application shell. The MCP UI is only the visual/manual interaction surface that text and code cannot replace well.

### Local Preview Containers

There are three separate surfaces, and they should not be confused:

```text
MCP host surface       real target; host embeds ui://flowcyto/gate-editor-v1.html
native preview window  local developer/user preview; macOS WKWebView loads /mcp-app-preview
browser debug page     development fallback; normal HTTP/SSE page at /
```

For shipped MCP usage, the preferred path is the MCP host surface. The user should see a compact embedded tool panel inside the agent client, not a standalone website.

For local CLI usage on macOS, prefer:

```bash
flowcyto open-gate-editor-window /path/to/run/flowcyto.workspace.json
```

That command starts the local gate editor server and opens `/mcp-app-preview` in a small native `WKWebView` window. It exercises the same `window.openai.callTool(...)` branch and revision polling used by the embedded MCP app preview, without showing browser chrome.

Keep the browser URL available only for inspection and automated Playwright coverage:

```bash
flowcyto open-gate-editor /path/to/run/flowcyto.workspace.json
```

## Minimal User Experience

The first screen should contain:

- One 2D plot.
- X/Y parameter selectors.
- Parent population selector.
- Gate drawing mode selector.
- Gate list for the current parent population.
- Save/apply state indicator.

The plot must support:

- Pan and zoom.
- Density or scatter rendering.
- Polygon gate drawing.
- Rectangle/range gate drawing.
- Vertex dragging.
- Gate move/delete/rename.
- Overlay of existing gates from the workspace artifact.
- Live refresh when the artifact changes.

This is enough for a human to make the subjective gating decision while the agent handles everything around it.

## Non-UI State

Use any user/project directory. The folder name is not part of the contract.

```text
my-cytometry-run/
  flowcyto.workspace.json
  data/
    sample_001.fcs
    sample_002.fcs
  reports/
  .datalox/
    cache/
      previews/
    ui-state.json
```

The UI should not own hidden scientific state. The JSON workspace file is the source of truth.

Use visible files for durable scientific state:

```text
flowcyto.workspace.json
data/
reports/
```

Use `.datalox/` for tool-owned runtime state:

```text
.datalox/cache/
.datalox/ui-state.json
.datalox/locks/
```

Do not require the top-level folder to be named `experiment`. Real users will already have project, cohort, assay, or date-based folder names. The MCP should accept a `workspace_path` pointing to the canonical JSON file.

## MCP vs CLI

This should not be MCP-only.

Use a shared core with two entrypoints:

```text
core library -> CLI
             -> MCP server + MCP App UI
```

The CLI is the deterministic execution surface. The MCP is the interactive agent surface.

Use MCP for:

- opening the embedded gate editor
- giving the agent structured tools
- letting the UI call tools without direct filesystem access
- keeping the interaction inside the conversation
- returning machine-readable validation errors to the agent

Use CLI for:

- local tests
- headless validation
- scripting
- CI
- debugging outside an MCP host
- agent fallback when the host cannot render MCP Apps
- reproducible examples in docs

Do not make the CLI a separate implementation. The CLI should call the same functions used by the MCP tools.

Recommended command shape:

```bash
flowcyto init /path/to/run --sample data/sample_001.fcs
flowcyto validate /path/to/run/flowcyto.workspace.json
flowcyto metadata /path/to/run/flowcyto.workspace.json --sample sample_001
flowcyto preview /path/to/run/flowcyto.workspace.json --sample sample_001 --x FSC-A --y SSC-A --max-events 10000
flowcyto set-workspace /path/to/run/flowcyto.workspace.json --json workspace.next.json
flowcyto open-gate-editor /path/to/run/flowcyto.workspace.json --sample sample_001
```

MCP tools map directly onto these core operations:

```text
CLI command                         MCP tool
flowcyto validate                   validate_workspace
flowcyto metadata                   get_sample_metadata
flowcyto preview                    get_event_preview
flowcyto set-workspace              write_workspace
flowcyto open-gate-editor           open_gate_editor
```

The agent should be able to solve most non-interactive tasks with the CLI alone. The MCP UI exists for the one thing text/code cannot do well: human gate drawing and visual review.

## Process Architecture

Use one local MCP server process.

Recommended shape:

```text
flowcyto-mcp-server
  tools/
    workspace
    fcs
    preview
    gate-editor
  resources/
    ui://flow-cyto/gate-editor
  core/
    workspace schema
    validation
    FCS reading
    preview generation
  app/
    bundled gate editor UI
```

Keep the server responsible for filesystem and FCS access. Keep the UI sandboxed and tool-driven.

Do not let the browser view read arbitrary local files. The UI receives only the workspace path and calls MCP tools for:

```text
read_workspace
write_workspace
get_sample_metadata
get_event_preview
```

This keeps the filesystem boundary clean and keeps the agent, CLI, and UI using the same contract.

## Suggested Repo Layout

The repo can start with this structure:

```text
src/
  core/
    workspace.ts
    validate.ts
    fcs.ts
    preview.ts
    gates.ts
  cli/
    main.ts
  mcp/
    server.ts
    tools.ts
    resources.ts
  app/
    gate-editor/
      GateEditor.tsx
      PlotSurface.tsx
      PolygonDrawer.tsx
      RectDrawer.tsx
      GateOverlay.tsx
      api.ts
      main.tsx
schemas/
  flowcyto.workspace.schema.json
testdata/
  fixtures/
docs/
```

Ownership:

```text
core/   no MCP imports, no React imports
cli/    thin wrapper around core
mcp/    thin wrapper around core and app resource registration
app/    UI only, calls MCP tools
```

This boundary matters. If core stays clean, an agent can test and repair almost everything without opening a UI.

## Workspace Artifact

Use a minimal JSON artifact:

```json
{
  "version": 1,
  "revision": 0,
  "samples": [
    {
      "id": "sample_001",
      "path": "data/sample_001.fcs"
    }
  ],
  "views": [
    {
      "id": "fsc_ssc",
      "sample": "sample_001",
      "parent": "root",
      "x": "FSC-A",
      "y": "SSC-A",
      "scale": {
        "x": "linear",
        "y": "linear"
      }
    }
  ],
  "gates": [
    {
      "id": "lymphocytes",
      "name": "Lymphocytes",
      "sample": "sample_001",
      "parent": "root",
      "type": "polygon",
      "x": "FSC-A",
      "y": "SSC-A",
      "vertices": [
        [12000, 3000],
        [50000, 4000],
        [60000, 25000],
        [18000, 22000]
      ]
    }
  ]
}
```

Keep it intentionally small. Add fields only when the UI or agent needs them.

## Workspace Write Semantics

Use atomic writes.

Write flow:

```text
read current file
parse JSON
validate current file
apply full replacement or explicit patch
validate next workspace
write temp file in same directory
fsync temp file
rename temp file over workspace file
return validation result and new revision
```

Add a revision field early:

```json
{
  "version": 1,
  "revision": 12
}
```

`write_workspace` should reject stale writes when the caller provides an old revision:

```json
{
  "ok": false,
  "errors": [
    {
      "path": "/revision",
      "code": "stale_revision",
      "message": "Workspace revision is 12 but write was based on revision 11."
    }
  ]
}
```

This avoids UI and agent overwriting each other.

For MVP, support full workspace replacement first. Add JSON Patch later only if necessary.

## FCS Reader Strategy

Choose one FCS reader per backend. Do not maintain multiple implicit fallback readers.

Recommended first choice if the MCP server is TypeScript:

```text
adapt Datalox src/modules/flow/fcs.ts into src/core/fcs.ts
```

Required adaptation:

- accept `Buffer` or `ArrayBuffer`, not browser `File`
- remove instrumentation and hashing dependencies
- expose metadata-only read
- expose selected-column preview read
- test against real `.fcs` fixtures

Recommended first choice if the MCP server is Python:

```text
use fcsparser or vendored FlowCytometryTools
```

For this repo, prefer TypeScript first if the MCP App/server is TypeScript. Only switch to Python if fixture testing shows the TypeScript parser is not reliable enough.

Parser errors should be direct:

```json
{
  "ok": false,
  "errors": [
    {
      "path": "/samples/0/path",
      "code": "unsupported_fcs_datatype",
      "message": "Unsupported $DATATYPE A in sample sample_001."
    }
  ]
}
```

Do not hide parser failures behind empty previews.

Performance requirements:

- Metadata read should not read the data segment.
- Preview read should load only requested columns when practical.
- Preview read should stream or stride through events instead of materializing unnecessary columns.
- Parser output for preview should be numeric typed arrays internally, not large nested objects.
- Convert to JSON only at the MCP boundary.
- Cache metadata by sample path, file size, and mtime.
- Cache previews separately from metadata.

For TypeScript, prefer internal arrays shaped like:

```ts
type PreviewColumns = {
  x: Float32Array | Float64Array
  y: Float32Array | Float64Array
  totalEvents: number
}
```

Only convert to:

```ts
Array<[number, number]>
```

when returning a small point preview to the MCP caller.

## Preview Generation

`get_event_preview` should return either points or bins.

Start with points:

```json
{
  "sampleId": "sample_001",
  "x": "FSC-A",
  "y": "SSC-A",
  "parent": "root",
  "points": [[1200, 300], [1250, 320]]
}
```

Then add bins when performance requires it:

```json
{
  "bins": {
    "xMin": 0,
    "xMax": 250000,
    "yMin": 0,
    "yMax": 250000,
    "width": 256,
    "height": 256,
    "counts": [0, 1, 4]
  }
}
```

Preview rules:

- Use deterministic sampling.
- Include the actual axes and scale in the response.
- Cap preview size by explicit `max_events` or bin resolution.
- Cache previews under `.datalox/cache/previews/`.
- Cache keys must include sample path, file mtime/size, axes, parent gate, scale, and preview parameters.
- Treat cache as disposable. The workspace JSON remains the truth.

Parent filtering is allowed for preview rendering, but it is not the final analysis engine.

Performance target:

```text
metadata: under 200 ms for typical files
first preview: under 1 s for typical files
gate drag/edit: no server roundtrip until commit
workspace write: under 100 ms excluding disk contention
```

These are targets, not correctness rules. If a real file exceeds them, expose timing in debug output so the agent can inspect the bottleneck.

Preview modes:

```text
points: best for small or sampled data, easiest MVP
bins: best for large data and smooth rendering
```

Start with points, but design the UI so `points` and `bins` are interchangeable render inputs.

For large files, prefer bins. Sending 100k+ points through MCP JSON will make the UI feel slow.

## Gate Model

Use these MVP gate types:

```text
polygon
rect
range
```

Delay:

```text
quadrant
ellipse
boolean/composite gates
population merge gates
```

Canonical gate fields:

```ts
type GateBase = {
  id: string
  name?: string
  sample: string
  parent: string
  x?: string
  y?: string
  enabled?: boolean
}

type PolygonGate = GateBase & {
  type: "polygon"
  x: string
  y: string
  vertices: Array<[number, number]>
}

type RectGate = GateBase & {
  type: "rect"
  x: string
  y: string
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}

type RangeGate = GateBase & {
  type: "range"
  x: string
  min: number
  max: number
}
```

`parent` is a gate id or `root`.

Do not encode biological meaning in the gate shape. Biological labels can be metadata written by the agent later.

## MCP Tools

Expose a small set of tools:

```text
open_workspace(path) -> workspace summary
read_workspace(path) -> workspace JSON
write_workspace(path, workspace) -> validation result
list_samples(workspace_path) -> sample ids and FCS paths
get_sample_metadata(workspace_path, sample_id) -> parameters and keywords
get_event_preview(workspace_path, sample_id, x, y, parent_gate_id?, max_events?) -> renderable points or bins
validate_workspace(workspace_path) -> errors for agent repair
```

The UI can call these tools through MCP Apps. The agent can call the same tools directly.

Do not create many narrow tools for analysis. Let the agent write code for computation.

Concrete tool contracts:

```ts
type ValidationError = {
  path: string
  code: string
  message: string
  details?: Record<string, unknown>
}

type ValidationResult = {
  ok: boolean
  errors: ValidationError[]
}

type WorkspaceSummary = {
  workspacePath: string
  rootDir: string
  sampleCount: number
  gateCount: number
  viewCount: number
  samples: Array<{ id: string; path: string }>
}

type SampleMetadata = {
  sampleId: string
  path: string
  eventCount: number | null
  parameters: Array<{
    name: string
    index: number
    detector?: string
    marker?: string
    range?: number
  }>
  keywords: Record<string, string>
}

type EventPreview = {
  sampleId: string
  x: string
  y: string
  parent: string
  scale: { x: "linear" | "arcsinh" | "biex"; y: "linear" | "arcsinh" | "biex" }
  points?: Array<[number, number]>
  bins?: {
    xMin: number
    xMax: number
    yMin: number
    yMax: number
    width: number
    height: number
    counts: number[]
  }
}
```

Tool behavior rules:

- `read_workspace` returns the parsed JSON exactly enough for the agent to edit it.
- `write_workspace` validates before writing and returns structured errors.
- `get_event_preview` is for display only. It must not be treated as full analysis data.
- `get_sample_metadata` should expose enough FCS keywords for the agent to reason and write code.
- No tool should silently repair invalid artifacts.
- No tool should make biological choices.

## UI Resource

Provide one MCP App resource:

```text
ui://flow-cyto/gate-editor
```

The tool that opens it:

```text
open_gate_editor(workspace_path, sample_id?, view_id?) -> MCP App UI
```

The UI should call server tools for data and workspace updates. It should not directly read arbitrary local files.

The app input should be small:

```json
{
  "workspacePath": "/absolute/path/to/flowcyto.workspace.json",
  "sampleId": "sample_001",
  "viewId": "fsc_ssc"
}
```

The app should then call:

```text
read_workspace
get_sample_metadata
get_event_preview
write_workspace
```

Do not send full FCS event tables as MCP tool input. The server owns file access and preview generation.

## Gate Editor Components

Build the UI as a compact component tree:

```text
GateEditor
  Toolbar
    SampleSelect
    AxisSelect
    ParentPopulationSelect
    DrawModeControl
  PlotSurface
    DensityCanvas or ScatterCanvas
    GateOverlay
    PolygonDrawer
    RectDrawer
  GateList
  StatusBar
```

Component responsibilities:

```text
GateEditor          owns loaded workspace state and save calls
Toolbar             edits view settings only
PlotSurface         owns pixel/data coordinate conversion
DensityCanvas       renders points or bins
GateOverlay         draws persisted gates
PolygonDrawer       creates/edits polygon vertices
RectDrawer          creates/edits rectangle bounds
GateList            rename/delete/select gates
StatusBar           shows validation/write status
```

Do not build a general dashboard. The UI should fit comfortably in a small host-provided panel.

Initial controls:

```text
sample selector
x axis selector
y axis selector
parent gate selector
pointer / polygon / rectangle mode
undo current polygon
delete selected gate
```

Initial interactions:

```text
click plot to add polygon vertex
click first vertex to close polygon
drag vertex to edit
drag polygon to move
drag rectangle handles to resize
select gate from overlay or gate list
write artifact on commit
poll artifact and refresh when changed externally
```

## Smooth Gating Rules

The UI must keep all drag/draw operations local until commit.

Rules:

- Do not call the server on every mouse move.
- Do not rewrite the workspace on every vertex drag frame.
- Do not recompute parent masks during pointer movement.
- Do not reload preview data when only a local in-progress vertex changes.
- Draw provisional gates entirely in the browser.
- Write the workspace only on completed gate creation, drag end, rename, delete, or explicit save.

Rendering approach:

```text
canvas layer: density/scatter preview
svg/konva layer: gates and handles
local state: in-progress gate edits
workspace state: committed gates only
```

Use stable dimensions for the plot surface. Toolbar text, status messages, or validation errors must not resize the plot while the user is drawing.

Use requestAnimationFrame for pointer-driven redraws if the implementation uses canvas directly.

If using Konva:

- keep point/density rendering on canvas
- use Konva only for gate vectors and handles
- avoid putting individual events into Konva nodes

The target feel is immediate gate manipulation even when the source FCS file is large.

## Rendering Boundary

The server may compute only what is necessary for rendering:

- Parse FCS metadata.
- Read selected event columns.
- Apply explicit display transforms stored in the workspace.
- Downsample or bin for preview.
- Filter preview by parent gate when requested.

The server should not decide gates biologically.

The UI may compute:

- Coordinate transforms between screen and data space.
- Vertex hit-testing.
- Drag operations.
- Local visual previews before saving.

The agent should compute:

- Gate statistics.
- Batch gate application.
- Compensation decisions.
- QC decisions.
- Report tables.
- Cross-sample comparisons.

## Live Update Model

Use file-backed state.

Required behavior:

```text
UI edit -> write_workspace -> file changes -> agent can read
agent edit -> write_workspace or file patch -> UI receives refresh
```

This is part of the MVP. Do not ship a gate editor that requires manual reload to see agent changes.

Implementation options:

- Server-side file watcher pushes updated workspace to the UI.
- UI polls `read_workspace` at a short interval.
- MCP App receives updated tool results from the host when the agent calls a write tool.

Start with polling if it keeps the system simple. Replace with a watcher only when needed.

Concrete MVP:

```text
UI polls read_workspace every 1000 ms while visible.
UI compares revision.
If revision changed and no local edit is in progress, refresh.
If revision changed during local edit, show stale revision and require save retry.
```

This is simpler than websocket push and good enough for the first version.

Later:

```text
server file watcher -> host/app notification -> UI refresh
```

Do not build conflict merging first. Use revision rejection and let the agent repair or retry.

Agent update contract:

```text
agent should use write_workspace when available
write_workspace increments revision
UI polls and detects revision
UI updates gate overlays and current view
UI requests a new preview only if sample, axes, scale, or parent changed
```

If the agent edits the file directly instead of calling `write_workspace`, the UI should still detect the changed file on the next poll. Direct file edits must still pass validation before the UI adopts them.

Refresh rules:

```text
gate-only change -> redraw overlay, keep existing preview
view axes change -> fetch new preview
sample path change -> fetch metadata and preview
invalid workspace change -> keep last valid view, show validation status
stale local edit -> do not overwrite agent change silently
```

The live behavior should be robust enough for this flow:

```text
1. User opens gate editor.
2. Agent adds a polygon gate to flowcyto.workspace.json.
3. Within about 1 second, the gate appears on the plot.
4. User drags a vertex and saves.
5. Agent reads the new vertices from the workspace JSON.
```

## Validation

Every write must validate:

- Referenced sample exists.
- Referenced parent gate exists or is `root`.
- Gate ids are unique.
- Gate dimensions exist in the sample.
- Polygon gates have at least three vertices.
- Rectangle/range gates have valid bounds.
- Gate tree has no cycles.

Validation errors should be explicit and machine-readable. The primary consumer is the agent.

Example:

```json
{
  "ok": false,
  "errors": [
    {
      "path": "/gates/0/x",
      "code": "unknown_parameter",
      "message": "Parameter CD45-A is not present in sample sample_001."
    }
  ]
}
```

Validation should be reusable:

```text
core validate function
CLI validate command
MCP validate_workspace tool
write_workspace preflight
test fixtures
```

Validation should return errors only. It should not mutate the workspace.

## Recommended Build Order

1. Define `flowcyto.workspace.json` schema.
2. Implement workspace read/write/validate tools.
3. Implement FCS metadata reading.
4. Implement event preview for two selected channels.
5. Implement one MCP App gate editor.
6. Save polygon gates from UI to JSON.
7. Refresh UI after agent edits JSON.
8. Add rectangle/range gates.
9. Add parent gate filtering.
10. Add export to Gating-ML.

More concrete first milestone:

```text
Milestone 1: Headless Core
  schema exists
  init command creates workspace
  validate command passes/fails fixtures
  metadata command reads one real FCS fixture
  preview command returns points for FSC-A/SSC-A

Milestone 2: MCP Tools
  MCP server exposes read/write/validate
  MCP server exposes metadata/preview
  tool outputs match CLI outputs

Milestone 3: Embedded Gate Editor
  app opens from open_gate_editor
  app renders preview points
  app draws polygon
  app writes gate to workspace JSON
  app refreshes after external JSON edit
  agent-added gate appears without reopening editor

Milestone 4: Usability
  rectangle gate
  gate selection/delete/rename
  parent gate preview
  density bins
```

## Next Shipping Milestone

Current state is internal alpha/demo quality, not ship-ready.

The next milestone should be:

```text
Milestone 6: Ship-Ready Alpha
  prove the real MCP embedded surface
  make large-file preview responsive
  broaden FCS compatibility beyond one fixture
  provide a clean install/run path
  define the exact public-beta boundary
```

Goal:

```text
A user can install the tool, open a real cytometry workspace from an agent,
draw/edit gates in a compact embedded surface, and trust that agent edits and
manual edits stay synchronized through revision-safe JSON.
```

This milestone does not mean "replace FlowJo." It means the file-backed agentic
gate editor is reliable enough for real user testing.

Required work:

```text
1. Real MCP host embed
   run the gate editor as ui://flowcyto/gate-editor-v1.html inside an actual MCP-capable host
   verify window.openai.callTool is provided by the host, not the local shim
   verify render_gate_editor opens the compact surface without browser chrome
   verify upsert_gate/delete_gate are callable from the embedded app
   verify agent-side writes appear in the open app without manual reload

2. Large-file preview path
   move expensive FCS preview work off the MCP server event loop
   add cached preview artifacts under .datalox/cache/previews/
   return capped point previews for small requests
   return or render binned density previews for large requests
   reject oversized raw point responses with a typed agent-readable error

3. FCS fixture coverage
   add several real fixtures from different instruments/export styles
   validate metadata parsing, parameter names, event counts, and preview reads
   test compensated/channel-like names with punctuation and spaces
   surface unsupported FCS forms as explicit typed errors

4. Packaging and launch
   make npm install/build/bin flowcyto and flowcyto-mcp work from a clean checkout
   expose flowcyto doctor for local install readiness
   expose npm run verify:alpha as the one-command alpha release gate
   document MCP server registration for the target host
   keep flowcyto open-gate-editor-window as the local macOS preview command
   keep browser / as debug-only

5. Release gate
   one command runs typecheck and tests
   one manual script proves the live artifact loop
   one real MCP-host capture proves embedded rendering
   docs say alpha clearly and do not claim FlowJo replacement
```

Acceptance criteria:

```text
npm run check passes
npm test passes
flowcyto doctor passes
npm run verify:alpha passes
flowcyto validate passes fixture workspaces
flowcyto open-gate-editor-window opens the compact native preview
flowcyto-mcp render_gate_editor opens in the real MCP host
human-drawn gate increments workspace revision
agent-written gate appears in the already-open surface within about 1 second
large fixture preview does not freeze the MCP server process
large raw point preview rejects with point_preview_too_large and recommends bins
malformed/stale writes return structured errors for the agent
```

Public beta should wait until this milestone passes against at least one real
MCP host and several realistic FCS files.

Implemented alpha release command:

```bash
npm run verify:alpha
```

Local readiness command:

```bash
flowcyto doctor
```

Fixture install command:

```bash
npm run fixtures:fetch
```

Real MCP transport command:

```bash
flowcyto-mcp --http --host 127.0.0.1 --port 8787
```

Register this endpoint in the MCP-capable host:

```text
http://127.0.0.1:8787/mcp
```

Use a public HTTPS URL or local tunnel only if the named host cannot reach
localhost. The server endpoint is Streamable HTTP. Stdio remains available for
local agent clients that launch `flowcyto-mcp` as a subprocess.

## Real MCP Host Validation

There are now three validation levels:

```text
1. Local unit/integration proof
   npm test
   covers stdio MCP, Streamable HTTP MCP, MCP App resource, window.openai.callTool
   injection, revision polling, UI writes, and agent-side writes.

2. Local human preview
   flowcyto open-gate-editor-window /path/to/flowcyto.workspace.json
   opens the compact macOS WKWebView preview without browser chrome.

3. Named MCP host proof
   register http://127.0.0.1:8787/mcp or an HTTPS tunnel in the real host
   call render_gate_editor from the agent
   verify the host embeds ui://flowcyto/gate-editor-v1.html
```

The named MCP host proof must check:

```text
tools/list includes render_gate_editor, get_gate_editor_state, upsert_gate,
delete_gate, and get_workspace_revision

resources/read returns ui://flowcyto/gate-editor-v1.html with
text/html;profile=mcp-app

render_gate_editor opens the compact plot panel inside the host, not a browser
tab

the embedded app receives window.openai.callTool from the host

human draw/edit writes a gate and increments workspace.revision

agent calls upsert_gate or write_workspace while the app is open

the open app shows the new revision and gate without manual reload
```

The local `/mcp-app-preview` route is not the named host proof. It is only a
developer preview that injects a compatible `window.openai.callTool` shim.

## Real FCS Fixture Coverage

Fixture sources are declared in:

```text
testdata/fixtures/manifest.json
```

The fetch script installs external fixtures into:

```text
testdata/fixtures/downloaded/
```

Current external fixture source:

```text
Bioconductor flowCore 2.22.1 extdata
license: Artistic-2.0
files:
  flowCore/inst/extdata/0877408774.B08
  flowCore/inst/extdata/0877408774.E07
  flowCore/inst/extdata/compdata/data/060909.001
```

The test suite validates every installed fixture in the manifest through:

```text
workspace init
workspace validate
metadata read
required FCS keyword checks
small point preview
binned density preview
```

Add new real-world FCS files by appending manifest entries instead of hardcoding
new tests. The manifest is the contract; the tests iterate it.

## Test Plan

Use fixture-driven tests before live UI polish.

Core tests:

```text
valid workspace passes
duplicate gate id fails
unknown sample fails
unknown axis fails
polygon with two vertices fails
gate cycle fails
stale revision fails
atomic write increments revision
```

FCS tests:

```text
metadata reads parameter names
metadata reads event count when available
preview returns requested x/y axes
preview is deterministic
unsupported datatype returns structured error
```

UI tests:

```text
gate editor renders nonblank plot
polygon can be drawn
saved polygon appears in workspace JSON
external workspace revision refreshes UI
agent-written gate appears on open plot within polling interval
invalid agent-written workspace does not replace last valid view
stale write produces visible status
```

Do not judge the MVP by visual appearance alone. The proof is that the file-backed loop works.

Performance tests:

```text
metadata read does not parse event data
preview size is capped
preview generation is deterministic
dragging a polygon does not call get_event_preview
dragging a vertex does not call write_workspace until drag end
large point preview switches to bins or rejects with clear size guidance
```

Manual performance check:

```text
open one realistic FCS file
render FSC-A/SSC-A preview
draw a polygon with 5-8 vertices
drag every vertex
move the polygon
confirm no visible input lag
confirm workspace JSON updates only on commit
```

## Copy Plan From Datalox

Initial copy/adapt list:

```text
/Users/yifanjin/datalox/src/components/plot/polygon-drawer.tsx
/Users/yifanjin/datalox/src/components/plot/canvas-scatter.tsx
/Users/yifanjin/datalox/src/components/plot/density-plot.tsx
/Users/yifanjin/datalox/src/modules/flow/types.ts
```

Expected changes:

```text
remove @/ imports
replace Datalox GateStep with WorkspaceGate
remove workflow services
remove biological/manual-label callbacks
make all persistence flow through MCP tools
```

Do not copy:

```text
/Users/yifanjin/datalox/src/components/plot/gating-plot.tsx
/Users/yifanjin/datalox/backend/domains/flow_cytometry/gate_preview.py
/Users/yifanjin/datalox/backend/domains/flow_cytometry/gate_artifacts.py
```

Those files are useful references, but they carry Datalox workflow assumptions that do not belong in the MCP artifact editor.

## What Not To Build First

Do not build a full FlowJo replacement UI.

Do not build automatic gating.

Do not build full compensation workflows.

Do not build report generation into the MCP.

Do not optimize for every FCS edge case before the live artifact loop works.

The first proof is simple:

```text
Open FCS. Draw gate. JSON changes. Agent edits JSON. Plot changes.
```

## Datalox Reuse

Reusable Datalox code was audited in:

```text
docs/datalox-reuse-audit.md
```

Use this starting point:

```text
copy PolygonDrawer + Canvas/Density renderer
build a fresh small GateEditor around the JSON workspace artifact
```

Do not copy the full Datalox `GatingPlot` or backend preview/runtime code. Those are tied to Datalox workflow state rather than this MCP's file-backed artifact model.
