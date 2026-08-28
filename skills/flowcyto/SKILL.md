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

Write gates through `upsert_gate` with `expected_revision` from `render_plot` or
`get_plot_context`. Do not patch `flowcyto.workspace.json` directly when
`upsert_gate` is available.

Use Flowcyto preview/render outputs for gate geometry. Do not create local
Python plots, inspect local preview URLs, or infer gates from screenshots when
`render_plot` or `get_plot_context` is available.

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
