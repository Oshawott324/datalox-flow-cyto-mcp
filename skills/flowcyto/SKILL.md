# Flowcyto

Use this skill when the user is working with `.fcs` files, flow cytometry,
FSC/SSC plots, marker plots, manual gating, agent-assisted gating, or a
`flowcyto.workspace.json` artifact.

## MCP First

Prefer Flowcyto MCP tools when an MCP host is available. The product contract is
the MCP server, not `AGENTS.md`.

```text
open_fcs -> open_gate_editor -> render_plot or get_plot_context -> upsert_gate -> get_workspace_revision
```

Use `open_fcs` when the user asks to open, inspect, render, analyze, or gate a
raw `.fcs` file or an existing `flowcyto.workspace.json`.

Use `import_flowjo_workspace` when the user provides a FlowJo `.wsp` file and
wants FlowJo gates converted into `flowcyto.workspace.json`. If the `.wsp`
contains stale or machine-specific FCS paths, pass an explicit
`sample_path_map`; do not guess sample bindings from nearby files.
If the user is working on one opened FCS file, pass `sample_names` or
`sample_ids` so only the matching FlowJo sample is imported. Omit those filters
only for an intentional batch import of every sample in the `.wsp`. Existing
workspace sample paths are preserved unless `overwrite_samples=true` is
explicitly requested.

Use `export_flowjo_workspace` when the user wants to hand off Flowcyto gates to
FlowJo. The current export path writes reference-only `.wsp` files for polygon,
rectangle, and range gates. Do not claim portable bundles, compensated FCS
export, or full FlowJo transform compatibility unless those tools are added.

Do not stop after `open_fcs` when the user asked to draw, edit, or manually
review a gate. Follow the returned `nextAction` so the compact gate editor opens
and the workspace has a live, user-visible gate-writing surface. In fresh CLI
agents this defaults to `open_gate_editor` with `surface="native_window"`; in
MCP Apps hosts use `surface="mcp_app"`.

Use `render_plot` for agent-readable plot data such as FSC/SSC, marker plots,
or comparing channels. Use `render_plot_image` when the user asks to show,
display, or include an inline graph in the chat. If the host does not visibly
render MCP image content, use the `render_plot_image` file output path under
`.datalox/cache/plots/`. Use `get_plot_context` for the active compact editor
view.

Use render tools for agent inspection. Use `open_gate_editor` only when the user
needs to visually review or manually adjust a gate. Keep one native editor per
workspace by default: reuse the current session unless the user explicitly asks
for multiple windows.

Host surface choice:

- In MCP Apps hosts, use `surface="mcp_app"` and let the embedded gate editor
  call widget-accessible tools when the host supports `openai/widgetAccessible`.
- In CLI, VS Code, or hosts without embedded MCP app support, use
  `surface="native_window"` for manual gating when a native window is available.
  Let the default `reuse_session=true` update the same workspace editor instead
  of opening extra windows.
- For render-only automation or hosts that cannot show a UI, use `surface="none"`
  and call `render_plot_image` for a deterministic SVG file.

Write gates through `upsert_gate` with `expected_revision` from `render_plot` or
`get_plot_context`. Do not patch `flowcyto.workspace.json` directly when
`upsert_gate` is available.

Use `propagate_gates` after the user confirms that reviewed gate geometry should
be reused across explicit target samples. Pass all selected parent gates together
with their children so the hierarchy can be remapped. After propagation, use
`get_population_table` with `column_key="name_path"` for cross-sample summaries
when target samples have sample-specific gate IDs for the same logical
populations.

Use Flowcyto preview/render outputs for gate geometry. Do not create local
Python plots, inspect local preview URLs, or infer gates from screenshots when
`render_plot` or `get_plot_context` is available.

Use `suggest_singlet_gate` when the user asks for an initial singlet gate or a
FSC-A/FSC-H style suggestion. It returns a proposed polygon only; do not write
it with `upsert_gate` unless the user asks you to apply it.

Use `suggest_apoptosis_quadrants` when the user asks for Annexin V / PI,
Annexin V / 7-AAD, or similar apoptosis quadrant analysis. Pass explicit
`annexin_channel` and `death_channel`; do not infer the assay from filenames
alone. Prefer a non-debris singlet parent population, not a live-cell parent
gate, because apoptotic/dead events are the measured biology. The tool returns
one coupled quadrant gate with four named populations and an `upsert_gate` next action; do not write
those gates unless the user asks you to apply them.

### Multi-sample apoptosis workflow

When the user asks to run an apoptosis analysis on a multi-sample workspace,
propose the complete gate hierarchy before writing anything, then write and
propagate everything in one approved batch.

Phase 1 - propose all gates, no writes yet:

1. Propose or inspect the main non-debris cell gate first using Flowcyto
   preview/render context on FSC/SSC. If no dedicated main-cell suggestion tool
   exists, clearly mark the main gate as agent-proposed from plot context and
   ask before writing it.

2. Call `suggest_singlet_gate` on FSC-A vs FSC-H or FSC-W, using the main cell
   gate as the parent when available. Show the proposed polygon and the
   percentage of parent events retained.

3. Call `suggest_apoptosis_quadrants` with
   `threshold_method="negative_control_percentile"` and the user-identified
   negative control. Show the proposed coupled thresholds and the four
   preliminary percentage breakdown on the reference sample. Use the singlet
   gate as the parent; do not use a live/dead exclusion parent for apoptosis.

4. Summarize the complete proposed hierarchy in one table: gate name, parent,
   and percent of parent for the reference sample. Ask once: "Approve this
   hierarchy to write and propagate to all samples?"

Phase 2 - write and propagate after a single approval:

5. Write the reviewed hierarchy in one revision-safe action. Use `upsert_gates`
   for multiple proposed gates or the suggestion's `upsert_gate` next action
   when only the coupled quadrant gate remains to be written.

6. Use `propagate_gates` to copy the full hierarchy, including main cell,
   singlet, and the quadrant gate, to every other treatment sample.
   Always include parent gates when propagating children.

7. Call `get_population_table` with `column_key="name_path"` and
   `compensation_id` if compensation was applied. Show the four quadrant
   populations across all samples and briefly interpret group differences.

Future multi-sample morphology tools should inspect treatment samples with
matched axes before fitting and then pool only eligible samples. Use up to
`max_events_per_sample` events per eligible sample, default 5000; exclude
samples below `min_events_for_pooling` after any parent-gate filter, default
500; and surface included/excluded sample IDs before writing gates. If all
samples are below the minimum, do not fit a pooled gate; ask the user whether to
lower the threshold, exclude samples, or collect more events.

What must come from the user, and cannot be inferred from filenames or metadata:

- Whether the FCS files are pre-compensated or raw.
- Which sample is the negative/unstained control.

If either is unclear, ask before starting Phase 1.

Use `get_population_graph` when the user asks for population counts,
percentages, or a hierarchy summary. It evaluates the workspace gates against
the FCS events and returns exact count, percent-of-parent, and percent-of-root
values for each node.

Use `get_population_table` when the user wants counts or percentages across
multiple samples. Use `column_key="gate_id"` for exact gate IDs and
`column_key="name_path"` for propagated gates that represent the same logical
population across samples but have different gate IDs.

## Compensation

Compensation is agent-explicit. Never silently apply compensation just because
`open_fcs` discovers an embedded matrix.

When `open_fcs` returns `compensationSummary.available=true`, inspect the
available matrix before using it:

```text
open_fcs -> list_compensations -> get_compensation_matrix
```

Apply conventional compensation only by passing the chosen `compensation_id` to
preview, render, editor, and population-statistics tools that support it:
`render_plot`, `render_plot_image`, `get_plot_context`, `open_gate_editor`,
`get_population_graph`, and `get_population_table`. If the file appears
pre-compensated, spectral, or ambiguous, ask the user before passing
`compensation_id`.

If `compensationSummary.available=false`, proceed without compensation and
surface `list_compensations` diagnostics to the user if compensation was
expected.

For control-derived compensation, use explicit mappings only:

```text
estimate_compensation_from_controls -> upsert_compensation_matrix
```

Do not infer single-stain control mappings from filenames alone. Ask the user
for the detector/channel controlled by each file when the mapping is not already
explicit.

### Bead controls with mixed negative/positive populations

Some bead-based single-stain control preparations contain a mixed population:
roughly 10% bright positive beads and 90% negative beads. The default all-event
median estimator fails on these because the negative bead population dominates
the median and contaminates off-diagonal spillover values.

When the user provides bead controls of this type, use `event_selection`:

```text
estimate_compensation_from_controls({
  ...,
  event_selection: {
    type: "primary_channel_top_percentile",
    percentile: 90
  }
})
```

`percentile: 90` keeps the top 10% of events by background-corrected primary
channel signal - the bright positive bead fraction.

Use `event_selection` when:

- Controls are bead-based with a declared or expected mixed negative/positive
  population.
- The estimated matrix disagrees strongly with the file-embedded `$SPILLOVER`
  matrix; check with `list_compensations`.
- The user or protocol specifies that controls contain both positive and
  negative beads, for example BD CompBeads or UltraComp eBeads.

Do NOT use `event_selection` when:

- Controls are single-stain cell samples where all cells stain uniformly.
- Controls match the flowCore reference format where all-event median was
  already validated.
- You are unsure of the bead population structure - ask the user first.

The default, with `event_selection` omitted, remains all-event median ratio and
is unchanged for existing callers.

## CLI Fallback

Use the CLI for setup, validation, fixture checks, or hosts without MCP.

```bash
npx -y -p @datalox/flowcyto-mcp@alpha flowcyto doctor
npx -y -p @datalox/flowcyto-mcp@alpha flowcyto open-fcs sample.fcs
npx -y -p @datalox/flowcyto-mcp@alpha flowcyto metadata flowcyto.workspace.json --sample sample_001
npx -y -p @datalox/flowcyto-mcp@alpha flowcyto preview flowcyto.workspace.json --sample sample_001 --x FSC-A --y SSC-A --format bins
npx -y -p @datalox/flowcyto-mcp@alpha flowcyto validate flowcyto.workspace.json
```

## Anti-Patterns

Do not create a separate gate writer script for the normal agent path.

Do not make `AGENTS.md` required for product correctness. It is optional convenience guidance and may be customized or ignored by the user.

Do not tell the user to install FlowJo for the MCP workflow unless they
explicitly need FlowJo-specific export/import behavior outside Flowcyto.

## Measuring Populations Exactly

Previews (`render_plot`, `get_event_preview`, `get_plot_context`) are sized for
drawing: point previews are capped and large populations are stride-sampled.
Use these tools when a number matters. Each reads every event, applies the
gate chain of `parent_gate_id` and the optional `compensation_id`, and samples
nothing:

- `get_population_stats`: count, min, max, mean, median, robust standard
  deviation and percentiles of one or more channels.
- `get_channel_histogram`: counts on a linear, log, arcsinh or biex scale, with
  bin edges in raw units that can be used directly as gate boundaries.
- `get_population_density`: a two-dimensional histogram of two channels, each
  on its own scale.
- `get_population_events`: the event indexes and channel values themselves,
  paged with `offset` and `limit`.

These tools accept a channel by parameter name or by detector id. Gates and
views are stored with parameter names.

## Compensation From Cell Controls

`estimate_compensation_from_controls` takes medians over whole files or over
the brightest events. That suits bead controls. For cell controls, where the
stained cells are a minority of the tube and autofluorescence differs between
cell types, gate the stained cells and matching unstained cells in each
control and call `estimate_compensation_from_gated_controls`. Choosing those
two populations is the analyst's decision; the tool only does the arithmetic.
Review the matrix, then store it with `upsert_compensation_matrix`.

## Headless Hosts

Start the server with `FLOWCYTO_HEADLESS=1` (or `--headless`) on hosts with no
screen, such as containers and batch runs. The gate-editor tools are not
offered, `open_fcs` defaults to `surface="none"`, and tool results carry no
editor guidance.

## Gate Objects

`upsert_gate` and `upsert_gates` take gate objects. Every gate has `id`,
`sample` (a sample id), `parent` (`"root"` or the id of another gate or
quadrant population of the same sample), and optionally `name` and `enabled`.
Coordinates are raw, untransformed values; `x` and `y` are parameter names.

- Range: `{ "type": "range", "x": "...", "min": 0, "max": 1000 }`. Both ends
  are included.
- Rectangle: `{ "type": "rect", "x": "...", "y": "...", "xMin": 0, "xMax": 1,
  "yMin": 0, "yMax": 1 }`. All four edges are included.
- Polygon: `{ "type": "polygon", "x": "...", "y": "...", "vertices": [[x, y],
  ...] }`, with at least three vertices.
- Quadrant: `{ "type": "quadrant", "x": "...", "y": "...", "xThreshold": 0,
  "yThreshold": 0, "quadrants": [{ "id": "...", "name": "...", "x": "+",
  "y": "-" }, ...] }`. Each quadrant is a population of its own, addressed by
  its `id`; `+` includes the threshold. The quadrant gate itself is a
  container and cannot be used as a parent.

A population is the events that pass a gate and every gate above it.
