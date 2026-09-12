# Flowcyto MCP Tool Loading Branch Migration Review

Date: 2026-09-10

Source reviewed:

```text
Complexity-LLC/datalox@flowcyto-mcp-tool-loading
```

Goal: decide what should be copied, ported, reimplemented, or left behind from
the old Datalox flow-cytometry branch into this standalone TypeScript
`@datalox/flowcyto-mcp` package.

## Decision

Do not merge the old branch directly.

The old branch is useful as source material, but its flow-cytometry code is
embedded in a broader Datalox runtime with event-sourcing, program graph, Python
domain modules, and Nanocode MCP client/tool-loading code. The current MCP repo
has a smaller contract:

```text
FCS file -> flowcyto.workspace.json -> MCP tools -> compact gate editor
```

Migrations should preserve that contract and keep agent-facing tools explicit,
typed, testable, and file-backed.

## Tier 1: Copy Immediately When Safe

These assets have high validation value and little implementation risk, but
must be checked for privacy and redistribution rights before committing.

| Asset | Recommendation | Status |
|---|---|---|
| `20211130 BDC Tet.wsp` | Use as local/live FlowJo import validation for nested rect and polygon gates. Commit only if approved for redistribution. | Local-only candidate. Do not commit yet. |
| `20230315 BMDC guanosine.wsp` | Use as local/live validation for more complex hierarchy and ellipsoid behavior. Commit only if approved for redistribution. | Local-only candidate. Do not commit yet. |
| `seed_simple_chain_v10_8.wsp` | Initially looked like a safe seed fixture, but inspection showed it is not a normal FlowJo/Gating-ML workspace. | Do not commit as FlowJo fixture. |

Notes:

- The real `.wsp` files are the most useful immediate validation material.
- The repo should keep synthetic `.wsp` fixtures for unit tests and use real
  lab workspaces only as local live-validation artifacts unless redistribution
  is cleared.
- Do not commit paired `.fcs` files from private lab data.

## Tier 2: Port Logic, Leave Python Behind

These pieces are useful and self-contained enough to port into TypeScript, but
should not be copied wholesale.

| Old component | What to port | Current status |
|---|---|---|
| `compensation/parse_spillover_align.py` | Robust spillover parsing and channel alignment behavior. | Mostly ported through conventional compensation work. Semicolon-delimited spillover now has regression coverage in PR #13. |
| `singlet/singlet.py` | Robust area-vs-height singlet band suggestion using median/MAD-style statistics. | Ported as `suggest_singlet_gate` in PR #13. |

Implementation constraints:

- Keep compensation application explicit. Discovery may suggest a matrix, but
  render/context/editor calls apply compensation only when `compensation_id` is
  passed.
- Keep singlet suggestion read-only. `suggest_singlet_gate` should return a
  proposed gate plus `upsert_gate` nextAction; the agent writes it only after
  user confirmation.
- Prefer deterministic tests over visual-only validation.

## Tier 3: Implement Fresh, Use Old Code As Product Evidence

These concepts are valuable, but the old implementation is coupled to the
Datalox workflow engine and should not be ported directly.

| Concept | New MCP shape | Current status |
|---|---|---|
| Gate statistics | Exact counts and percentages for each gate in a sample hierarchy. | Implemented as `get_population_graph` in PR #13. |
| Population graph | Tree/DAG representation of populations, parent-child edges, counts, percent of parent, percent of root. | Implemented in the simpler workspace model as `get_population_graph`; old active/candidate/merge node roles are not ported. |
| FlowJo export | `flowcyto.workspace.json` to `.wsp` XML, with transforms where supported. | Implemented in current repo; old Python mapper is useful only as reference. |
| FlowJo import | `.wsp` XML to workspace gates for evaluation ground truth. | Implemented in current repo; not present in old branch. |
| Multi-sample aggregation | Aggregate/sample-group analysis across files. | Defer until demo and evaluation needs require it. |
| Model-improvement replay data | Capture visible plot context, AI gate, user-edited gate, compensation state, and parent population for future eval/replay. | Should be a separate plan, not part of FlowJo import/export. |

## Tier 4: Do Not Port Directly

These are architecture-specific, dependency-heavy, or not faithful to the
current MCP contract.

| Old component | Reason to skip |
|---|---|
| `population_graph/builder.py` | Coupled to old runtime engine, program graph, and step references. Reimplement against `FlowcytoWorkspace` instead. |
| `export/flowjo/mapper.py` | Maps from old population graph/run result objects, not current `WorkspaceGate`. Use as reference only. |
| `steps/`, `kernel/`, `runtime/`, `compat/`, `context/` | Old workflow framework infrastructure, outside standalone MCP scope. |
| `biological/strategies/gmm.py`, `density_core.py`, `hdr_multicloud.py` | Python/NumPy gating strategies. Consider later as separate algorithm work or sidecar design, not direct TypeScript port. |
| `debris/`, `live_dead/`, `time_gate/` | Useful gating concepts, but tied to old data model. Reimplement only when there is a clear agent-facing tool contract. |
| Nanocode MCP client/tool-loading code | Client-side MCP infrastructure for a different host/runtime; not part of this MCP server. |

## Recommended Order

1. Finish and merge PR #13:
   - `suggest_singlet_gate`
   - `get_population_graph`
   - semicolon spillover regression coverage
2. Add local live-validation notes for the real `.wsp` files without committing
   private data.
3. Add a real redistributable FlowJo `.wsp` fixture only when licensing and
   privacy are clear.
4. Start a separate model-improvement data-capture plan:
   - visible plot context
   - AI-proposed gate
   - user-edited gate
   - workspace revision
   - compensation state
   - parent population
5. Defer additional automatic gate suggestions until the first alpha feedback
   identifies the highest-value gates.

## Current Status

Already implemented in the current TypeScript MCP repo:

- Conventional compensation from embedded FCS spillover metadata.
- Control-derived compensation from explicit single-stain mappings.
- FlowJo import/export for supported gate types and transforms.
- FlowJo biex transform support validated against generated reference fixtures.
- `suggest_singlet_gate` read-only MCP proposal tool.
- `get_population_graph` exact hierarchy count/percentage MCP tool.

Still pending or explicitly deferred:

- Redistribution-safe real FlowJo `.wsp` fixtures.
- Ellipsoid approximation from real FlowJo workspaces if alpha users need it.
- Multi-sample aggregation.
- FCSExpress import/export.
- Model-improvement replay capture.
- Clean-room expansion of additional automatic gating suggestions.
