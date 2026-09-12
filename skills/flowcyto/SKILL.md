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

Do not stop after `open_fcs` when the user asked to gate, draw, edit, or inspect
the main population. Follow the returned `nextAction` immediately so the compact
gate editor opens and the workspace has a live, user-visible gate-writing
surface. In fresh CLI agents this defaults to `open_gate_editor` with
`surface="native_window"`; in MCP Apps hosts use `surface="mcp_app"`.

Use `render_plot` for agent-readable plot data such as FSC/SSC, marker plots,
or comparing channels. Use `render_plot_image` when the user asks to show,
display, or include an inline graph in the chat. If the host does not visibly
render MCP image content, use the `render_plot_image` file output path under
`.datalox/cache/plots/`. Use `get_plot_context` for the active compact editor
view.

Host surface choice:

- In MCP Apps hosts, use `surface="mcp_app"` and let the embedded gate editor
  call widget-accessible tools when the host supports `openai/widgetAccessible`.
- In CLI, VS Code, or hosts without embedded MCP app support, use
  `surface="native_window"` for manual gating when a native window is available.
- For render-only automation or hosts that cannot show a UI, use `surface="none"`
  and call `render_plot_image` for a deterministic SVG file.

Write gates through `upsert_gate` with `expected_revision` from `render_plot` or
`get_plot_context`. Do not patch `flowcyto.workspace.json` directly when
`upsert_gate` is available.

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
four proposed quadrant gates and an `upsert_gates` next action; do not write
those gates unless the user asks you to apply them.

Use `get_population_graph` when the user asks for population counts,
percentages, or a hierarchy summary. It evaluates the workspace gates against
the FCS events and returns exact count, percent-of-parent, and percent-of-root
values for each node.

## Compensation

Compensation is agent-explicit. Never silently apply compensation just because
`open_fcs` discovers an embedded matrix.

When `open_fcs` returns `compensationSummary.available=true`, inspect the
available matrix before using it:

```text
open_fcs -> list_compensations -> get_compensation_matrix
```

Apply conventional compensation only by passing the chosen `compensation_id` to
`render_plot`, `render_plot_image`, `get_plot_context`, or `open_gate_editor`.
If the file appears pre-compensated, spectral, or ambiguous, ask the user before
passing `compensation_id`.

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
