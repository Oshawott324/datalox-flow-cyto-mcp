# Flowcyto MCP Host Compatibility Validation

Date: 2026-08-28

Branch: `docs/flowcyto-host-compatibility`

## Purpose

Validate that the same Flowcyto MCP contract works in Codex Desktop, Claude
Desktop, and VS Code/Codex CLI after the plot image export, gate editor contract,
and PR1 conventional compensation work landed on `main`.

This is a host compatibility exercise. It should not change core gating,
compensation, preview, or workspace semantics.

Before running this checklist, register Flowcyto MCP in the target host using
[mcp-host-setup.md](mcp-host-setup.md).

## Stable Contract

Agents should use the same product contract in every host:

```text
open_fcs
-> follow result.nextAction
-> open_gate_editor or render_plot_image
-> get_plot_context or render_plot
-> upsert_gate
-> get_workspace_revision
```

Do not depend on a browser tab as the primary product surface. A host may support
an embedded MCP app, a native compact window, deterministic image export, or only
agent-readable plot data. All of those should still use the same MCP tools and
the canonical `flowcyto.workspace.json` artifact.

## Compatibility Matrix

| Host | OS | MCP app surface | `openai/widgetAccessible` honored | Native window | `render_plot_image` visible | Expected path |
| --- | --- | --- | --- | --- | --- | --- |
| Codex Desktop | Windows | Test | Test | Test WebView2 | Test SVG file path and inline image | Prefer `mcp_app` when embedded widget tool calls work; otherwise `native_window` or SVG file output |
| Claude Desktop | Windows/macOS | Test | Unknown until live run | Test if app surface is unavailable | Test SVG file path and inline image | Prefer embedded MCP app if Claude honors widget tool calls; otherwise agent calls tools and uses SVG output |
| VS Code / Codex CLI | Windows/macOS | Likely unavailable | Likely no | Test native window | Test SVG file path | Use `native_window` or `surface=none` plus `render_plot_image` |

The key PR2-specific check is whether the embedded app can call these
widget-accessible tools directly:

- `get_plot_context`
- `get_workspace_revision`
- `upsert_gate`
- `delete_gate`

If those fail inside the widget but agent-side MCP calls work, record that as a
host widget bridge issue, not a Flowcyto workspace or compensation failure.

## Demo Dataset

Use one small, repeatable FCS file for host validation. Recommended default:

```text
C:\Users\fangxf\Research Tools\test data\3. flow\2_20211001_Tet\B1 44 1-1.fcs
```

Substitute this FCS path for the local environment when another tester runs the
same checklist.

Use a fresh workspace directory for each host run so revisions start from a
known state and old gates do not confuse the demo:

```text
C:\tmp\flowcyto-host-validation\<host-name>
```

## Fresh Host Prompt

Use this prompt in each host after registering the Flowcyto MCP server:

```text
Use Flowcyto MCP to open this FCS file and show the FSC-A vs SSC-A gate editor:

C:\Users\fangxf\Research Tools\test data\3. flow\2_20211001_Tet\B1 44 1-1.fcs

Use a fresh workspace directory:
C:\tmp\flowcyto-host-validation\<host-name>

Follow the Flowcyto MCP contract exactly:
1. open_fcs
2. follow open_fcs.nextAction immediately
3. get_plot_context or render_plot for FSC-A vs SSC-A
4. upsert_gate only if I ask you to write a gate
5. get_workspace_revision after writing a gate

Do not create local Python plots, inspect local preview URLs, or edit
flowcyto.workspace.json directly.
```

## Compensation Prompt Add-On

Use this only for a compensation-aware host check:

```text
After open_fcs, check whether compensationSummary.available is true.
If compensation is available, call list_compensations and get_compensation_matrix.
Do not apply compensation automatically. Ask me before passing compensation_id to
render_plot, render_plot_image, get_plot_context, or open_gate_editor.
```

## Pass Criteria

A host row passes only when all relevant checks below are true:

- `open_fcs` succeeds and returns `gateEditorPolicy`.
- The first recommended FSC/SSC view is not a timing plot such as `TLSW` vs
  `TMSW`.
- The host follows `nextAction` instead of stopping after `open_fcs`.
- If `surface="mcp_app"` is used, the embedded app does not show
  `Invalid MCP tool call params`.
- If `surface="mcp_app"` is used, the widget can call
  `get_plot_context`, `get_workspace_revision`, `upsert_gate`, and `delete_gate`
  when the host honors `openai/widgetAccessible`.
- If the host cannot render the embedded app, `surface="native_window"` or
  `surface="none"` plus `render_plot_image` still completes the workflow.
- `render_plot_image` writes a deterministic SVG under `.datalox/cache/plots/`.
- A gate written through `upsert_gate` increments `workspace.revision`.
- The already-open gate editor or follow-up render reflects the updated gate.

## Failure Classification

Use these labels in notes so host issues do not get mixed with core MCP issues:

- `host_widget_bridge`: embedded app opens but widget tool calls fail.
- `host_inline_image`: SVG or image artifact is produced but not displayed.
- `native_window_runtime`: WebView2/WKWebView/native helper launch failure.
- `mcp_contract`: MCP tool schema, args, or structured result mismatch.
- `data_contract`: incorrect axes, sample id, gate hierarchy, preview, or
  compensation behavior.

## Result Log

Add one subsection per live host run.

### Codex Desktop

Status: passed fresh-host MCP contract run.

Observed:

- `open_fcs` succeeded.
- `open_fcs.nextAction` was followed immediately.
- Gate editor opened.
- `get_plot_context` loaded the intended FSC/SSC view:
  `FSC 488/10-A` vs `SSC 488/10-A`.
- The host did not stop on a timing plot such as `TLSW` vs `TMSW`.
- No gate was written during this run.
- No compensation was applied.
- `compensationSummary.available=true`.
- `list_compensations` and `get_compensation_matrix` found one embedded
  conventional matrix: `fcs_spillover_B1_44_1-1`.
- The agent reported that compensation should be confirmed before applying.

Workspace:

```text
C:\tmp\flowcyto-host-validation\codex-desktop\flowcyto.workspace.json
```

Sample/context:

- Sample: `B1_44_1-1`
- Events: `68,814`
- Revision: `1`
- Existing gates: none

Classification: pass.

### Claude Desktop

Status: blocked before Flowcyto MCP contract run.

Observed:

- Claude session refreshed available MCP servers.
- Connected servers were `claude-code-remote`, `remote-devices`, `visualize`,
  and `claude-in-chrome`.
- Flowcyto MCP tools were not present.
- The linked Windows machine was visible, but the proxied MCP servers did not
  include Flowcyto.
- No `open_fcs`, `get_plot_context`, `render_plot`, `upsert_gate`,
  `get_workspace_revision`, `list_compensations`, or `get_compensation_matrix`
  tool was available to call.

Required next action:

- Register Flowcyto MCP in Claude Desktop on the linked Windows machine.
- Restart Claude Desktop or restart the MCP server.
- Re-run the same fresh-host prompt.

Classification: `mcp_contract` not reached; host setup blocked by missing
Flowcyto MCP registration.

### VS Code / Codex CLI

Status: pending fresh-host run.
