# Compact Gate Editor Auto-Open Live Test - 2026-05-12

Dataset:

```text
/Users/yifanjin/Downloads/2_20211001_Tet/A12 FMO Tet.fcs
```

Goal:

```text
A fresh agent should not need the user to separately ask for the Flowcyto
gate editor. When the user asks to open, inspect, or gate an FCS file, the MCP
contract should make the next gate-editor-opening step explicit and executable.
```

Expected agent path:

```text
open_fcs
  -> required nextAction.tool = open_gate_editor
open_gate_editor
  -> compact surface opens
  -> nextAction.tool = get_plot_context
get_plot_context
  -> nextAction.tool = upsert_gate
upsert_gate
  -> workspace revision increments
get_workspace_revision
  -> confirms the already-open app can refresh
```

## Issue 1: Gate Editor Opening Was Too Easy To Skip

Observed risk:

```text
open_fcs could return a render-only nextAction when an agent chose the
render-only path. That made the compact gate editor feel optional even when the
user asked to inspect or gate a population.
```

Solution:

```text
For MCP open_fcs, the default result now includes:

  gateEditorPolicy.compactGateEditorRequired = true
  nextAction.tool = "open_gate_editor"
  nextAction.required = true
  nextAction.arguments.surface = "native_window"

The render-only path still exists, but only when the caller explicitly passes
surface="none".
```

Why this is the right boundary:

```text
The MCP tool result carries the product contract. AGENTS.md and demo scripts are
optional hints only. A fresh agent can discover the workflow from tool
descriptions, resources, prompts, and nextAction fields.
```

Files changed:

```text
src/mcp/server.ts
src/cli/main.ts
README.md
skills/flowcyto/SKILL.md
tests/core.test.ts
```

## Issue 2: Plot Context Included Unneeded Raw Metadata

Observed during the first fresh Codex live run:

```text
The tool chain succeeded, but get_plot_context returned full FCS keyword
metadata. That bloated the agent context even though gate drawing only needs
sample id, event count, parameters, bounds, preview, gates, and revision.
```

Solution:

```text
get_plot_context now returns compact metadata:

  sampleId
  path
  eventCount
  parameters

The explicit get_sample_metadata tool still returns full keywords for workflows
that actually need raw FCS metadata.
```

Files changed:

```text
src/app/gate-editor/server.ts
tests/core.test.ts
```

## Direct MCP Live Test

Command shape:

```text
node dist/src/mcp/server.js over MCP stdio
open_fcs(real FCS, workspace_dir=temp)
follow result.nextAction to open_gate_editor
get_plot_context
upsert_gate
get_workspace_revision
close_gate_editor
```

Result:

```text
ok: true
sampleId: A12_FMO_Tet
open_fcs nextAction: open_gate_editor
open_fcs nextAction.required: true
open_fcs nextAction.arguments.surface: native_window
opened surface: native_window
metadata.keywords in get_plot_context: absent
revision: 1
gateCount: 1
```

## Fresh Codex Session Live Test

Fresh-session constraints:

```text
temporary empty working directory
--ignore-user-config
--ignore-rules
no project AGENTS.md
Flowcyto MCP registered only for this one run
model: gpt-5.4-mini
```

Observed tool trace:

```text
open_fcs
open_gate_editor
get_plot_context
upsert_gate
get_workspace_revision
```

Final result:

```text
FLOWCYTO_FRESH_CODEX_OK
surface=mcp_app
revision=1
gate_count=1
```

Codex used the embedded MCP app surface because Codex can consume the MCP Apps
resource contract. The direct MCP test covers the non-UI native-window path.

## Claude Session Status

This machine did not have a `claude` CLI on `PATH`, so the equivalent fresh
Claude session was not runnable in this environment.

Required Claude pass criteria when available:

```text
fresh directory with no Flowcyto AGENTS.md dependency
Flowcyto MCP registered as one command
agent calls open_fcs
agent follows required nextAction to open_gate_editor
compact surface opens as native_window or host-native MCP UI
agent calls get_plot_context
agent calls upsert_gate
agent calls get_workspace_revision and sees revision 1 / gateCount 1
```

## Pass Criteria

```text
npm test passes
direct MCP live test opens a compact native window from open_fcs.nextAction
direct MCP live test writes one revision-safe gate
get_plot_context omits raw metadata keywords
fresh Codex session succeeds without AGENTS.md or scripts
fresh Codex tool trace includes open_gate_editor before get_plot_context
Claude blocker is documented if the CLI is unavailable
```
