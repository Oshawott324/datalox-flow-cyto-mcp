# Implementation Details

## MVP Shape

A small window containing one interactive cytometry plot is enough for the first version.

It should not be only a chart. It should be a file-backed gate editor:

```text
FCS/workspace -> agent calls MCP -> compact app opens -> agent upserts gates -> app refreshes live
```

The UI can be small, but the artifact boundary must be complete.

## Agent-Opened Compact App Target

The product target is an agent-opened MCP app, not a human-started browser page
and not a demo script that patches JSON behind the agent.

Required target flow:

```text
User asks agent: "Open this FCS/workspace and gate the main population."
Agent calls MCP tool: flowcyto.open_gate_editor.
MCP host renders the compact Flowcyto app from the tool's UI resource.
Agent calls flowcyto.get_plot_context.
Agent calls flowcyto.upsert_gate.
The already-open compact app updates live.
```

This is the contract to make real for Codex, Claude Code, ChatGPT Apps, and
other MCP-capable agent hosts.

`flowcyto.open_gate_editor` is the entrypoint. In an MCP Apps-capable host, its
tool descriptor should point to:

```text
ui://flowcyto/gate-editor-v1.html
```

through tool metadata such as:

```text
_meta.ui.resourceUri
_meta["openai/outputTemplate"]
```

The embedded app should use the host-provided bridge:

```text
window.openai.callTool(...)
```

to call the same MCP tools the agent can call directly.

The required model-facing tool loop is:

```text
flowcyto.open_gate_editor(workspace_path, sample_id?, view_id?)
flowcyto.get_plot_context(workspace_path, sample_id?, view_id?)
flowcyto.upsert_gate(workspace_path, gate, expected_revision)
```

`get_plot_context` should return enough structured plot context for the agent to
make a gate without guessing:

```text
active sample
active x/y channels
display transform and visible data bounds
preview density/points summary
current gates
workspace revision
recommended gate shape schema
```

If a host cannot render MCP Apps resources, the same entrypoint may launch a
compact native surface instead. Minimum native parity targets are:

```text
macOS: WKWebView compact window
Windows: WebView2 compact window
```

The browser route remains a developer/debug surface. It is not the product
experience we should optimize demos around.

During migration, older tool names such as `render_gate_editor` and
`get_gate_editor_state` may remain compatibility aliases. New docs, demos, and
host validation should use `flowcyto.open_gate_editor`,
`flowcyto.get_plot_context`, and `flowcyto.upsert_gate`.

## Make The Agent-Opened Flow Real

Implement this as a contract migration, not as another demo script.

Current status in the repo:

```text
Milestone A is implemented.
Milestone B is implemented.
Milestone C is implemented.
Milestone D is implemented.
Milestone E is implemented.
Milestone F has a passed Codex macOS native_window row.
Milestone G is implemented.
Milestone H is implemented and @datalox/flowcyto-mcp@0.1.1 is published under the alpha tag.
Milestone I is implemented and @datalox/flowcyto-mcp@0.1.4 is published under the alpha tag.
Real dataset live test fixes are documented in `docs/real-dataset-live-test-2026-05-12.md`.
open_gate_editor owns the MCP Apps UI resource metadata.
open_gate_editor(surface="auto" | "mcp_app") returns the MCP app resource contract.
open_gate_editor(surface="native_window") launches the compact native window path.
render_gate_editor remains as a deprecated compatibility alias.
get_plot_context exists and returns revision, axes, bounds, preview, gates, gateSchema, recommendedGate, agentContract, and nextAction.
get_gate_editor_state remains as a deprecated compatibility alias.
agent-side upsert_gate returns workspacePath, revision, gateCount, agentContract, and nextAction.
AGENTS.md is optional convenience guidance; the product loop is carried by MCP tool descriptors and tool results.
the already-open embedded app polls get_workspace_revision and refreshes through get_plot_context.
native_window fallback uses macOS WKWebView or Windows WebView2 launcher contracts, never a browser tab.
flowcyto-live-gating is generated as a clean demo repo with no gate writer scripts.
the demo harness can validate the Codex macOS host result artifact.
```

Remaining gaps:

```text
Milestone F still has host/platform rows that require external environments:
Claude Code macOS, Windows WebView2, and OpenAI Apps-capable embedded host.
```

The remaining implementation must close those gaps in this order.

### Milestone A: Promote `open_gate_editor` To The UI Entry Tool

Status: passed on 2026-05-09.

Code work:

```text
src/mcp/server.ts
  move MCP Apps UI metadata from render_gate_editor to open_gate_editor
  keep render_gate_editor as a deprecated compatibility alias
  add optional surface: "mcp_app" | "native_window" | "auto"
  for surface="mcp_app", return the UI resource contract only
  for surface="native_window", launch the compact native window from the MCP tool
  for surface="auto", prefer mcp_app and let agents request native_window in non-UI hosts

tests/core.test.ts
  assert open_gate_editor has _meta.ui.resourceUri
  assert open_gate_editor has _meta["openai/outputTemplate"]
  assert render_gate_editor is only an alias, not the tested happy path

README.md
  list open_gate_editor as the app-opening tool
```

Pass criteria:

```text
tools/list includes open_gate_editor
open_gate_editor descriptor points to ui://flowcyto/gate-editor-v1.html
open_gate_editor returns surface.kind="mcp_app" for surface="mcp_app"
render_gate_editor still works but no README/demo/test happy path depends on it
npm test has a failing assertion if the UI metadata is only on render_gate_editor
```

### Milestone B: Add `get_plot_context`

Status: passed on 2026-05-09.

Code work:

```text
src/mcp/server.ts
  register get_plot_context
  keep get_gate_editor_state as a deprecated compatibility alias

src/app/gate-editor/server.ts
  rename or wrap getGateEditorState as getPlotContext

src/app/gate-editor/ui.ts
  embedded app calls get_plot_context for /api/state
  local preview shim supports get_plot_context

tests/core.test.ts
  call get_plot_context through stdio MCP
  call get_plot_context through Streamable HTTP MCP
  verify embedded app branch calls get_plot_context
```

`get_plot_context` response must be explicit enough that the agent does not
need to scrape pixels or invent coordinate bounds:

```text
ok
workspacePath
revision
sampleId
viewId
x channel
y channel
scale
visible data bounds
preview format and summary
current gates
gate schema
recommended expected_revision value
```

Pass criteria:

```text
get_plot_context returns revision, axes, bounds, preview, gates, and gateSchema
get_plot_context returns structured errors for missing sample/channel/workspace
embedded app renders using get_plot_context, not get_gate_editor_state
get_gate_editor_state still works as an alias during migration
```

### Milestone C: Make Agent Writes Refresh The Already-Open App

Status: passed on 2026-05-09.

Code work:

```text
src/app/gate-editor/ui.ts
  polls get_workspace_revision while visible
  on revision change, calls get_plot_context through /api/state
  does not refresh during in-progress drag/draw or unsaved local gate edits
  leaves stale_revision errors visible when a save conflict is rejected

src/mcp/server.ts
  upsert_gate returns ok, revision, gate, gateCount, workspacePath
  delete_gate returns ok, revision, gateCount, workspacePath

tests/core.test.ts
  opens the embedded app
  calls upsert_gate from the agent side
  asserts the already-open app shows the new gate without page reload
  asserts pointer moves do not write the workspace before Save
  asserts stale expected_revision returns structured stale_revision details
```

Pass criteria:

```text
agent upsert_gate increments workspace.revision exactly once
already-open embedded app shows the new gate within 1 second
human UI edit increments workspace.revision exactly once
stale expected_revision returns a structured stale_revision error
no workspace write happens on every pointer move
```

### Milestone D: Make Non-UI Agent Hosts Still Open A Compact Window

Status: passed on 2026-05-09.

Some MCP hosts will not render MCP Apps UI resources. Codex CLI and Claude Code
may need this path until they support embedded app resources.

Code work:

```text
src/mcp/server.ts
  open_gate_editor(surface="native_window") starts the compact native window after native readiness preflight
  returns surface.kind="native_window"
  returns runtime: "macos_wkwebview" or "windows_webview2"
  returns structured native_window_unsupported on Linux/unsupported platforms

src/app/gate-editor/native-window.ts
  keep macOS WKWebView path
  keep Windows WebView2 path
  reject public/non-local URLs
  expose launcher plans for macOS and Windows so tests prove no browser command is used

tests/core.test.ts
  assert native_window unsupported path is structured on unsupported platform
  assert launcher command contract for macOS and Windows helpers
```

Pass criteria:

```text
on macOS, agent calls open_gate_editor(surface="native_window") and a compact WKWebView opens
on Windows, agent calls open_gate_editor(surface="native_window") and a compact WebView2 window opens
neither path opens a normal browser tab
neither path requires modifying Codex, Claude Code, or Datalox UI source
the MCP tool call itself is what starts the compact surface
```

### Milestone E: Add The Real Demo Harness

Status: passed on 2026-05-09.

The demo repo should prove the product, not work around it.

Demo repo contents:

```text
flowcyto-live-gating/
  flowcyto.workspace.json
  data/*.fcs
  README.md
  AGENTS.md
  .mcp.json or host-specific MCP registration notes
```

Do not require:

```text
manual browser launch
manual compact window launch
agent-host source edits
JSON writer scripts as the primary path
prompt instructions that force rectangle gates
```

Allowed:

```text
starting/registering the Flowcyto MCP server
an AGENTS.md telling the agent to use Flowcyto MCP tools
small shell commands that install dependencies or start the MCP server
```

Implementation:

```text
scripts/create-live-gating-demo.mjs
  creates or refreshes /Users/yifanjin/flowcyto-live-gating
  copies data/sample_001.fcs
  writes flowcyto.workspace.json with revision 0 and no gates
  writes .mcp.json pointing at the local Flowcyto MCP server
  writes AGENTS.md with the required MCP tool sequence
  removes old scripts/, prompts/, and .datalox/ watcher artifacts

tests/core.test.ts
  asserts the generated demo contains only the expected files
  asserts no gate writer scripts or prompt hacks are present
  asserts AGENTS.md names open_gate_editor, get_plot_context, and upsert_gate
  asserts the workspace validates, starts at revision 0, and has no gates
```

Pass criteria for the video:

```text
fresh repo starts with no hand-authored demo gate
user prompt is exactly: Open this FCS/workspace and gate the main population.
tool trace shows open_gate_editor
compact app appears from the tool call
tool trace shows get_plot_context
tool trace shows upsert_gate
the already-open app updates without manual reload
workspace revision increments
the gate is biologically plausible for the visible population
no host app code changes are made during the demo
```

### Milestone F: Host Matrix

Status: Codex macOS row passed on 2026-05-10. Claude Code and Windows WebView2
rows still require those hosts/platforms.

Milestone F is a host validation milestone. It should not add another product
path or a JSON writer workaround. It should prove that real agents can use the
same MCP tools from the clean `flowcyto-live-gating` repo.

Priority:

```text
P0:
  Codex on macOS -> native_window WKWebView
  Claude Code on macOS -> native_window WKWebView
  Windows agent host -> native_window WebView2

P1:
  ChatGPT/OpenAI Apps-capable host -> embedded MCP Apps resource
```

The first real host matrix should stay small:

```text
ChatGPT/OpenAI Apps-capable host:
  expected surface: embedded MCP Apps resource
  pass: host renders ui://flowcyto/gate-editor-v1.html after open_gate_editor
  priority: P1

Codex:
  expected surface: native_window until embedded MCP Apps UI exists
  pass: agent calls open_gate_editor(surface="native_window") and compact app opens
  priority: P0

Claude Code:
  expected surface: native_window until embedded MCP Apps UI exists
  pass: agent calls open_gate_editor(surface="native_window") and compact app opens
  priority: P0
```

Platform pass matrix:

```text
macOS:
  mcp_app host pass when available
  native_window WKWebView pass required

Windows:
  native_window WebView2 pass required
  mcp_app host pass when available
```

Host-row validation setup:

```text
scripts/create-live-gating-demo.mjs
  resets /Users/yifanjin/flowcyto-live-gating to revision 0 with no gates
  writes a thin optional AGENTS.md hint that points at Flowcyto MCP and nextAction
  removes old generated instruction/skill/event folders from the disposable demo repo

scripts/validate-live-demo-result.mjs
  validates the final workspace artifact after a real host run
  requires revision 1
  requires exactly one gate
  requires gate id agent_main_population_gate
  requires polygon type
  requires sample_001, root, FSC-A, SSC-A
  rejects scripts/ and prompts/ in the demo repo
```

Run a host row:

```bash
cd /Users/yifanjin/datalox-flow-cyto-mcp
npm run build
node scripts/create-live-gating-demo.mjs --target /Users/yifanjin/flowcyto-live-gating --force

cd /Users/yifanjin/flowcyto-live-gating
# In the selected host, ask exactly:
# Open this FCS/workspace and gate the main population.

node /Users/yifanjin/datalox-flow-cyto-mcp/scripts/validate-live-demo-result.mjs \
  --workspace /Users/yifanjin/flowcyto-live-gating/flowcyto.workspace.json
```

Codex macOS command-line host result on 2026-05-10:

```text
result: passed
command: codex exec --skip-git-repo-check -C /Users/yifanjin/flowcyto-live-gating
         -m gpt-5.4-mini -s danger-full-access
         -c mcp_servers.flowcyto.command="node"
         -c mcp_servers.flowcyto.args=["/Users/yifanjin/datalox-flow-cyto-mcp/dist/src/mcp/server.js"]
         --output-last-message /tmp/flowcyto-codex-host-last-message.txt
         "Open this FCS/workspace and gate the main population."
tool trace: open_gate_editor -> get_plot_context -> upsert_gate -> get_workspace_revision
surface: native_window macOS WKWebView
validator: scripts/validate-live-demo-result.mjs returned ok true
artifact: revision 1, gateCount 1, gate id agent_main_population_gate, type polygon
```

Codex macOS command-line host result after Milestone G on 2026-05-11:

```text
result: passed
command: codex exec --skip-git-repo-check -C /Users/yifanjin/flowcyto-live-gating
         -m gpt-5.4-mini -s danger-full-access
         -c mcp_servers.flowcyto.command="node"
         -c mcp_servers.flowcyto.args=["/Users/yifanjin/datalox-flow-cyto-mcp/dist/src/mcp/server.js"]
         --output-last-message /tmp/flowcyto-codex-host-last-message.txt
         "Open this FCS/workspace and gate the main population."
tool trace: open_workspace -> open_gate_editor -> get_plot_context -> get_event_preview -> upsert_gate -> get_workspace_revision
surface: native_window macOS WKWebView
AGENTS.md: thin optional hint only; no required gate sequence or gate geometry instructions
validator: scripts/validate-live-demo-result.mjs returned ok true
artifact: revision 1, gateCount 1, gate id agent_main_population_gate, type polygon
note: the Datalox wrapper auto-added Datalox pack files to the disposable demo repo during this local run; that is host wrapper behavior, not a Flowcyto requirement.
```

Earlier Codex macOS attempt before Milestone G:

```text
result: blocked before correction
reason: Codex opened the native Flowcyto window and called get_plot_context, then
        drifted into Computer Use and local HTML/Python inspection before
        upsert_gate.
correction: the MCP descriptors/results now return agentContract, recommendedGate,
            and nextAction so the product path does not depend on detailed
            AGENTS.md gate instructions.
```

Unavailable rows in this environment:

```text
Claude Code macOS:
  blocked here because `claude` is not installed.
  run the same clean demo repo and validator when the host is available.

Windows WebView2:
  blocked here because this machine is macOS.
  run the same clean demo repo and validator on Windows after building
  npm run build:native:windows:x64 or npm run build:native:windows:arm64.

ChatGPT/OpenAI Apps-capable host:
  P1 only for this agent-first milestone.
  validate separately when an Apps-capable MCP host is available.
```

Do not mark a host row passed unless all of these are true:

```text
tool trace includes open_gate_editor
tool trace includes get_plot_context
tool trace includes upsert_gate
open_gate_editor is the command that opened the compact surface
the final artifact passes scripts/validate-live-demo-result.mjs
the already-open compact surface visibly refreshes after upsert_gate
no host app source code changed
```

### Milestone G: Remove Product Dependence On AGENTS.md

Status: passed on 2026-05-11.

Problem:

```text
AGENTS.md is user-owned host guidance.
Users may already have a custom AGENTS.md.
Some hosts may ignore AGENTS.md.
Some custom AGENTS.md files may conflict with Flowcyto's desired tool loop.
Therefore Flowcyto cannot depend on AGENTS.md for product behavior.
```

Target boundary:

```text
AGENTS.md:
  optional convenience hint only
  may point to Flowcyto MCP registration
  may say "follow Flowcyto tool nextAction fields"
  must not be required for the product loop

MCP tool descriptors:
  primary agent-facing contract for which tools to call

MCP tool results:
  primary machine-readable contract for next steps

workspace schema and gate validators:
  artifact correctness contract
```

Exact code change plan:

```text
src/mcp/server.ts
  added reusable agent workflow metadata helpers
  strengthen open_gate_editor description:
    "Open the compact gate editor, then call get_plot_context using
     result.nextAction.arguments. Do not inspect local preview URLs or write the
     workspace JSON directly."
  strengthen get_plot_context description:
    "Return revision, axes, bounds, preview, and recommended gate-write contract.
     Call this before upsert_gate."
  strengthen upsert_gate description:
    "Write gates using expected_revision from get_plot_context. For FSC/SSC
     main-population gating, prefer polygon unless the user explicitly requests
     another shape."
  open_gate_editor result includes:
    agentContract.version
    agentContract.intent = "open_then_context_then_gate"
    agentContract.forbiddenActions = [
      "do_not_write_workspace_json_directly",
      "do_not_inspect_local_preview_server",
      "do_not_use_browser_or_desktop_automation_for_gate_geometry",
      "do_not_read_fcs_or_workspace_with_local_scripts_for_gate_geometry",
      "do_not_use_local_python_or_plotting_for_gate_geometry"
    ]
    nextAction.tool = "get_plot_context"
    nextAction.arguments = normalized workspace/sample/parent/x/y/max_events/format/bin dimensions
  get_plot_context result includes:
    agentContract.version
    expected_revision
    recommendedGate.id = "agent_main_population_gate" when no gate id is provided
    recommendedGate.type = "polygon"
    recommendedGate.writeTool = "upsert_gate"
    recommendedGate.geometrySource = "preview_or_bins_from_get_plot_context"
    recommendedGate.geometryInstructions explain to use the MCP-returned preview/bins rather than local FCS reads or local plots
    recommendedGate.requiredFields = [
      "id",
      "name",
      "sample",
      "parent",
      "type",
      "x",
      "y",
      "vertices"
    ]
    nextAction.tool = "upsert_gate"
    nextAction.arguments.workspace_path
    nextAction.arguments.expected_revision
    nextAction.arguments.gateTemplate
  upsert_gate result includes:
    nextAction.tool = "get_workspace_revision"
    nextAction.arguments.workspace_path
    agentContract.refresh = "already_open_app_refreshes_from_revision_poll"

src/app/gate-editor/server.ts
  implement getPlotContext agentContract/recommendedGate/nextAction fields
  keep preview/bounds/gates unchanged
  do not add gate geometry heuristics; the agent still decides geometry from
  preview data

src/core/gates.ts
  validate revision strictly as today
  validate polygon gates have at least three vertices
  return agent-readable errors with code/path/message when required gate fields
  are missing
  do not reject rect globally; only make polygon the recommended default in
  agentContract so explicit user requests still work

scripts/create-live-gating-demo.mjs
  reduce generated AGENTS.md to thin guidance:
    "Use the registered Flowcyto MCP server. Follow nextAction fields returned
     by Flowcyto tools."
  remove detailed behavior rules from AGENTS.md once MCP contract tests pass
  remove stale generated host instruction/skill/event folders when refreshing the disposable demo repo

tests/core.test.ts
  add MCP stdio test:
    call open_gate_editor(surface="mcp_app")
    assert result.nextAction.tool === "get_plot_context"
    assert nextAction.arguments includes workspace_path, sample_id, x, y
  add MCP stdio test:
    call get_plot_context
    assert recommendedGate.type === "polygon"
    assert recommendedGate.writeTool === "upsert_gate"
    assert nextAction.tool === "upsert_gate"
    assert nextAction.arguments.expected_revision === result.expected_revision
  add MCP stdio test:
    call upsert_gate from the get_plot_context gateTemplate after filling
    vertices
    assert revision increments to 1
    assert result.nextAction.tool === "get_workspace_revision"
  add demo harness test:
    generated AGENTS.md no longer contains detailed gate behavior rules
    generated AGENTS.md does contain "follow nextAction"

README.md
  document that AGENTS.md is optional
  document the portable MCP-native loop:
    open_gate_editor -> get_plot_context -> upsert_gate -> get_workspace_revision

docs/implementation-details.md
  marked Milestone G passed after automated MCP contract tests and the Codex
  macOS host row proved the loop works without detailed AGENTS.md instructions
```

Pass criteria:

```text
npm run verify:alpha passes

Tool descriptor pass:
  tools/list exposes open_gate_editor, get_plot_context, upsert_gate
  each tool description contains the next required tool in the loop
  open_gate_editor descriptor still exposes ui://flowcyto/gate-editor-v1.html

Tool result pass:
  open_gate_editor returns nextAction.tool = get_plot_context
  get_plot_context returns recommendedGate.type = polygon
  get_plot_context returns nextAction.tool = upsert_gate
  upsert_gate returns nextAction.tool = get_workspace_revision

AGENTS independence pass:
  generated demo AGENTS.md is thin and optional
  tests do not depend on detailed AGENTS.md gate instructions
  a test proves the MCP results alone contain the full nextAction chain

Host pass:
  reset /Users/yifanjin/flowcyto-live-gating
  run Codex with Flowcyto MCP registered
  prompt is exactly: Open this FCS/workspace and gate the main population.
  Codex completes without detailed AGENTS.md gate instructions
  scripts/validate-live-demo-result.mjs returns ok true

Non-goals:
  no new JSON writer script
  no browser-debug route as product path
  no modification to Codex, Claude Code, ChatGPT, or Datalox UI source
  no hard-coded gate geometry algorithm in Flowcyto MCP
```

### Milestone H: One-Command `npx` Distribution

Status: passed on 2026-05-12. `@datalox/flowcyto-mcp@0.1.1` is published
to npm under the `alpha` tag.

Problem:

```text
The product is an MCP server, so users should not need to clone this repository,
install dependencies, run TypeScript builds, or point a host at dist/src/mcp/server.js.

The shipped experience should match normal MCP server distribution:
  TypeScript MCP servers -> npx package command
  Python MCP servers -> uvx or pip command
  Docker MCP servers -> docker run command

The MCP client configuration should be command + args, not a build recipe.
```

Reference behavior:

```text
Official MCP reference servers:
  TypeScript servers can be used directly with npx.
  Python servers can be used directly with uvx or pip.
  Claude Desktop-style client config is command + args.
  Windows wraps npx through cmd /c.

Fetch reference server:
  uv users can run uvx mcp-server-fetch with no separate installation step.
```

Source links:

```text
https://github.com/modelcontextprotocol/servers/blob/main/README.md
https://github.com/modelcontextprotocol/servers/blob/main/src/fetch/README.md
```

Target user configuration:

```json
{
  "mcpServers": {
    "flowcyto": {
      "command": "npx",
      "args": ["-y", "-p", "@datalox/flowcyto-mcp@alpha", "flowcyto-mcp"]
    }
  }
}
```

Use explicit `-p ... flowcyto-mcp` instead of relying on `npx
@datalox/flowcyto-mcp` because this package exposes two bins:

```text
flowcyto      -> CLI for humans, scripts, and validation
flowcyto-mcp  -> MCP stdio server for agent hosts
```

Windows target configuration:

```json
{
  "mcpServers": {
    "flowcyto": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "-p", "@datalox/flowcyto-mcp@alpha", "flowcyto-mcp"]
    }
  }
}
```

Current repo state:

```text
package name is already @datalox/flowcyto-mcp
package has bin.flowcyto
package has bin.flowcyto-mcp
package has a files allowlist
package no longer has private: true
src/cli/main.ts has #!/usr/bin/env node
src/mcp/server.ts has #!/usr/bin/env node
publishConfig.registry points to https://registry.npmjs.org/
local tarball smoke passes through npm exec and MCP SDK startup
public package smoke passes through npx and MCP SDK startup
```

Implementation details:

```text
src/mcp/server.ts
  add a first-line shebang:
    #!/usr/bin/env node
  keep the file ESM-compatible
  ensure the compiled dist/src/mcp/server.js also starts with the shebang
  keep stdio as the default transport when no --http flag is present

package.json
  remove private: true only when the package is ready for npm alpha publish
  keep name = @datalox/flowcyto-mcp
  keep bin.flowcyto = dist/src/cli/main.js
  keep bin.flowcyto-mcp = dist/src/mcp/server.js
  add engines:
    "node": ">=20"
  add publishConfig:
    "access": "public"
    "tag": "alpha"
    "registry": "https://registry.npmjs.org/"
  add prepack:
    "npm run build"
  add verify:publish:
    "npm run verify:alpha && npm run smoke:package"
  keep files allowlist tight:
    dist/src/**/*
    dist/native/windows/**/*
    native/windows/**/*
    docs/**/*.md
    schemas/**/*
    scripts/*.mjs
    testdata/fixtures/manifest.json

README.md
  make npx MCP registration the first install path
  move clone/npm ci/npm run build to Contributor Setup
  show macOS/Linux config
  show Windows cmd /c config
  show local tarball smoke-test commands for maintainers
  document that --http remains localhost-only alpha/debug mode

docs/implementation-details.md
  keep this milestone as the release gate for npx distribution
  do not mark passed until published-package smoke tests pass

tests or scripts
  add a package smoke script if repeated manually:
    npm pack
    npm exec --yes --package ./datalox-flowcyto-mcp-0.1.1.tgz -- flowcyto doctor
    MCP SDK starts flowcyto-mcp from the tarball and calls tools/list
  avoid tests that depend on the public npm registry for normal local CI

CI/release
  build TypeScript before npm pack
  run npm run verify:publish on macOS
  build Windows WebView2 helpers on Windows if native_window parity is claimed
  upload/publish alpha only after package smoke passes
```

Published result:

```text
command:
  npm publish --access public --tag alpha

result:
  + @datalox/flowcyto-mcp@0.1.1

public version:
  npm view @datalox/flowcyto-mcp@alpha version -> 0.1.1

public CLI smoke:
  npx -y -p @datalox/flowcyto-mcp@alpha flowcyto doctor -> ok true

public MCP smoke:
  npx -y -p @datalox/flowcyto-mcp@alpha flowcyto-mcp
  MCP SDK tools/list exposes open_gate_editor, get_plot_context, and upsert_gate
  MCP SDK resources/read exposes ui://flowcyto/gate-editor-v1.html
```

Local tarball smoke commands:

```bash
npm run verify:publish
npm pack

npm exec --yes --package ./datalox-flowcyto-mcp-0.1.1.tgz -- flowcyto doctor
npm exec --yes --package ./datalox-flowcyto-mcp-0.1.1.tgz -- flowcyto validate \
  /path/to/flowcyto.workspace.json
```

MCP stdio smoke should use an MCP client, not a long-running naked command:

```text
start command:
  npm exec --yes --package ./datalox-flowcyto-mcp-0.1.1.tgz -- flowcyto-mcp

client assertions:
  initialize succeeds
  tools/list includes open_gate_editor
  tools/list includes get_plot_context
  tools/list includes upsert_gate
  resources/list or resources/read exposes ui://flowcyto/gate-editor-v1.html
```

Published alpha smoke commands:

```bash
npm view @datalox/flowcyto-mcp@alpha version
npx -y -p @datalox/flowcyto-mcp@alpha flowcyto doctor
```

Published MCP host config smoke:

```text
create a fresh flowcyto-live-gating repo
configure host with npx -p @datalox/flowcyto-mcp@alpha flowcyto-mcp
ask exactly: Open this FCS/workspace and gate the main population.
verify the compact surface opens
verify the agent writes through upsert_gate
verify scripts/validate-live-demo-result.mjs passes
```

Windows native_window parity decision:

```text
Option A: claim MCP tools on Windows, but not native_window parity yet
  npx config works
  get_plot_context/upsert_gate work
  open_gate_editor(surface="native_window") returns structured unsupported or missing-helper error
  README says Windows native helper is not bundled in this alpha

Option B: claim full Windows native_window parity
  CI builds dist/native/windows/win-x64 helper
  CI builds dist/native/windows/win-arm64 helper
  npm tarball includes those helpers
  Windows host validation opens WebView2 compact window from npx-installed package
```

Prefer Option A until real Windows host validation passes. It is better to ship
honest MCP functionality than to imply native desktop parity that has not been
validated on Windows.

Pass criteria:

```text
Package metadata pass:
  src/mcp/server.ts has #!/usr/bin/env node
  dist/src/mcp/server.js has #!/usr/bin/env node after npm run build
  package.json has engines.node >=20
  package.json has publishConfig.access public
  package.json has publishConfig.tag alpha
  package.json has publishConfig.registry https://registry.npmjs.org/
  package.json has no private: true when publishing
  npm pack --dry-run contains dist/src/mcp/server.js
  npm pack --dry-run contains dist/src/cli/main.js
  npm pack --dry-run excludes src/**/*.ts, tests, .datalox, agent-wiki, and local run logs

Local tarball pass:
  npm exec --yes --package ./datalox-flowcyto-mcp-*.tgz -- flowcyto doctor returns ok true
  MCP SDK can start flowcyto-mcp from the tarball
  MCP SDK tools/list contains open_gate_editor, get_plot_context, upsert_gate
  MCP SDK resources/read can fetch ui://flowcyto/gate-editor-v1.html

Published alpha pass:
  npm publish --access public --tag alpha succeeds
  npm view @datalox/flowcyto-mcp@alpha version returns the published version
  npx config works in at least one named real host on macOS
  host row validates with scripts/validate-live-demo-result.mjs

Documentation pass:
  README first install path is npx config
  build-from-source is under Contributor Setup
  Windows config uses cmd /c npx
  docs state whether Windows native_window is bundled or intentionally unsupported in alpha

Security boundary pass:
  --http examples bind to 127.0.0.1
  docs continue to say not to expose --http publicly without auth/TLS
  no public network listener is introduced by the npx path
```

Non-goals:

```text
do not require global npm install
do not require git clone for users
do not require npm run build for users
do not make the browser debug route the release path
do not claim Windows native_window support until a real Windows run passes
do not publish latest; use alpha until host matrix and fixture coverage improve
```

### Milestone I: MCP Self-Discovery For FCS Gating

Status: passed on 2026-05-12. Implemented and published in `@datalox/flowcyto-mcp@0.1.3`.

Problem:

```text
Publishing an MCP server is not enough for agent usability.

If the user says:
  "Open this FCS file and gate the main population."

the agent must discover from the MCP server itself that Flowcyto can:
  parse/open .fcs files
  create or open flowcyto.workspace.json
  render FSC/SSC and marker plots through tool results
  open the compact Flowcyto app
  write gates with revision-safe JSON updates

This must work without AGENTS.md, demo scripts, local plotting scripts, or
host-specific prompt injection.
```

How mature MCP servers solve this:

```text
Tool names match user intent:
  a user asks to fetch, search, read, browse, open, or render;
  the MCP exposes tools with those verbs, not only internal primitives.

Tool descriptions are model-facing routing hints:
  each important tool says when to use it, what input it accepts, and the next
  expected tool in the workflow.

Prompts expose reusable workflows:
  prompts are optional but discoverable. They give the host/model a named
  recipe such as "open this file and summarize it" or "review this artifact."

Resources expose durable facts/capabilities:
  resources can tell the model what the server supports without requiring the
  model to infer it from package docs.

Host docs or AGENTS.md are convenience layers:
  useful for demos and local repos, but not the product contract.
```

Target MCP discovery contract:

```text
User asks:
  Open this FCS/workspace and gate the main population.

Agent discovers:
  flowcyto.open_fcs
  flowcyto.render_plot
  flowcyto.open_gate_editor
  flowcyto.get_plot_context
  flowcyto.upsert_gate

Agent calls:
  open_fcs(file_path or workspace_path)
  open_gate_editor(workspace_path, surface?)
  get_plot_context(workspace_path, sample_id, x, y)
  upsert_gate(workspace_path, expected_revision, gate)

Already-open compact app:
  polls get_workspace_revision
  refreshes through get_plot_context
```

Required product changes:

```text
src/mcp/server.ts
  add open_fcs
    description:
      "Open an .fcs file or flowcyto.workspace.json, create or reuse a
       Flowcyto workspace, parse FCS metadata, and return the next tool to
       render or gate it. Use this when the user asks to open, inspect,
       render, analyze, or gate an FCS file."

    input:
      path: string
      workspace_dir?: string
      sample_id?: string
      surface?: "auto" | "mcp_app" | "native_window" | "none"

    behavior:
      if path ends with .fcs:
        create/reuse flowcyto.workspace.json under workspace_dir or parent dir
        add the FCS as sample_id
        parse metadata only, not all events
      if path ends with flowcyto.workspace.json:
        open existing workspace
      return:
        workspacePath
        sampleId
        channels
        recommendedViews
        nextAction.tool = "render_plot" or "open_gate_editor"

  add render_plot
    description:
      "Return renderable flow cytometry plot data for FSC/SSC or marker
       channels. Use this when the user asks to show, render, plot, inspect,
       or compare cytometry channels."

    behavior:
      wraps get_event_preview/get_plot_context
      returns the same point/bin preview contract the compact app uses
      does not create PNGs unless a future explicit image export tool exists

  keep get_plot_context
    role:
      lower-level active editor view context
    description:
      still references render_plot/open_gate_editor/upsert_gate

  update existing descriptions
    open_gate_editor:
      mention it accepts workspaces created by open_fcs
    get_event_preview:
      mention render_plot is the user-intent alias
    upsert_gate:
      mention expected_revision comes from render_plot/get_plot_context

  add resources/list support for:
    flowcyto://capabilities
    flowcyto://workflow/open-fcs-and-gate

  add resources/read:
    flowcyto://capabilities returns JSON:
      supportsFileTypes: [".fcs", "flowcyto.workspace.json"]
      canParseMetadata: true
      canRenderPlots: true
      canOpenCompactApp: true
      canWriteStructuredGates: true
      liveRefreshAfterUpsertGate: true
      canonicalArtifact: "flowcyto.workspace.json"

    flowcyto://workflow/open-fcs-and-gate returns text or JSON:
      orderedTools:
        open_fcs
        open_gate_editor
        get_plot_context or render_plot
        upsert_gate
        get_workspace_revision

  add prompts/list support for:
    open-fcs-and-gate-main-population
    render-fcs-plot
    review-workspace-gates

  add prompts/get:
    each prompt should include concrete tool-call order and forbid direct JSON
    patching when upsert_gate is available.

src/cli/main.ts
  add CLI alias:
    flowcyto open-fcs <path> [--workspace-dir <dir>] [--sample-id <id>]

  keep CLI secondary:
    the MCP path is primary for agents, but CLI should allow maintainers to
    validate the same behavior outside a host.

skills/flowcyto/SKILL.md
  add an optional agent skill for hosts that support repo/package skills.
  This skill is not the product contract; MCP discovery must work without it.

  purpose:
    teach agents when Flowcyto is relevant:
      .fcs files
      flow cytometry
      FSC/SSC plots
      marker plots
      manual or agent-assisted gating
      flowcyto.workspace.json artifacts

  required guidance:
    prefer MCP tools when an MCP host is available
    use CLI only for setup, validation, fixture checks, or hosts without MCP
    never patch flowcyto.workspace.json directly when upsert_gate is available
    use preview/render outputs from Flowcyto rather than local Python plotting
    preserve revision-safe writes

  MCP path:
    open_fcs -> open_gate_editor -> get_plot_context or render_plot ->
    upsert_gate -> get_workspace_revision

  CLI fallback examples:
    npx -y -p @datalox/flowcyto-mcp@alpha flowcyto doctor
    npx -y -p @datalox/flowcyto-mcp@alpha flowcyto open-fcs sample.fcs
    npx -y -p @datalox/flowcyto-mcp@alpha flowcyto metadata flowcyto.workspace.json --sample sample_001
    npx -y -p @datalox/flowcyto-mcp@alpha flowcyto preview flowcyto.workspace.json --sample sample_001 --x FSC-A --y SSC-A --format bins
    npx -y -p @datalox/flowcyto-mcp@alpha flowcyto validate flowcyto.workspace.json

  anti-patterns:
    do not create a separate gate writer script
    do not infer gates from screenshots when render_plot/get_plot_context is available
    do not use AGENTS.md as the only way to teach this workflow
    do not tell the user to install FlowJo

README.md
  add "Agent Discovery" section:
    no AGENTS.md required
    user prompt examples
    exact MCP config using npx
    exact expected tool path

docs/implementation-details.md
  keep this milestone separate from host matrix and packaging.
```

Concrete tool-result requirements:

```text
open_fcs result:
  ok: true
  workspacePath: absolute path
  sampleId: string
  sourcePath: absolute .fcs or workspace path
  channels: compact metadata list
  recommendedViews:
    - { x: "FSC-A", y: "SSC-A", intent: "main_population" }
    - marker pairs when obvious from metadata
  nextAction:
    tool: "open_gate_editor"
    arguments:
      workspace_path: workspacePath
      sample_id: sampleId
      x: "FSC-A"
      y: "SSC-A"
      surface: "native_window" or "auto"

render_plot result:
  ok: true
  workspacePath
  sampleId
  revision
  x
  y
  bounds
  preview:
    format: "points" | "bins"
    points? or bins?
  gates
  recommendedGate:
    type: "polygon"
    geometrySource: "preview_or_bins_from_render_plot"
  nextAction:
    tool: "upsert_gate"
```

No-AGENTS demo harness:

```text
scripts/create-live-gating-demo.mjs
  add --no-agents
  when set:
    do not write AGENTS.md
    do not write prompt guidance files
    do not write gate scripts
    only write:
      flowcyto.workspace.json or raw .fcs depending on test mode
      data/*.fcs
      .mcp.json
      README.md with human-neutral description only

scripts/validate-live-demo-result.mjs
  add --allow-no-agents
  assert no AGENTS.md exists when validating no-AGENTS run

tests/core.test.ts
  unit test tools/list includes open_fcs and render_plot
  unit test tool descriptions include .fcs, render, gate, and next tool hints
  unit test resources/list includes flowcyto://capabilities
  unit test prompts/list includes open-fcs-and-gate-main-population
  unit test skills/flowcyto/SKILL.md exists and contains MCP-first guidance
  integration test open_fcs on fixture .fcs creates/opens a workspace
  integration test render_plot returns bins or points for FSC-A/SSC-A
  integration test no-AGENTS demo harness contains no gate scripts or AGENTS.md
```

Pass criteria:

```text
MCP discovery pass:
  tools/list includes open_fcs
  tools/list includes render_plot
  open_fcs description contains ".fcs", "workspace", "render", "gate"
  render_plot description contains "FSC/SSC", "marker", "render", "plot"
  open_gate_editor description points back to open_fcs-created workspaces
  upsert_gate description references expected_revision from render_plot/get_plot_context

Resource pass:
  resources/list includes flowcyto://capabilities
  resources/read flowcyto://capabilities returns supportsFileTypes including .fcs
  capabilities says canRenderPlots true
  capabilities says canWriteStructuredGates true
  capabilities says canonicalArtifact flowcyto.workspace.json

Prompt pass:
  prompts/list includes open-fcs-and-gate-main-population
  prompts/get open-fcs-and-gate-main-population names the tool order
  prompt text does not depend on AGENTS.md

Skill-doc pass:
  skills/flowcyto/SKILL.md exists
  skill says MCP is preferred over CLI when available
  skill documents CLI fallback commands with npx
  skill says do not patch flowcyto.workspace.json directly when upsert_gate exists
  skill says AGENTS.md is optional convenience, not required product behavior

Functional pass:
  open_fcs on a real fixture .fcs returns workspacePath, sampleId, channels, and nextAction
  render_plot using open_fcs result returns revision, bounds, preview, recommendedGate, and nextAction
  upsert_gate using render_plot expected_revision writes a gate and increments revision
  already-open compact app refreshes after upsert_gate

No-AGENTS host pass:
  create fresh demo repo with --no-agents
  register published or local Flowcyto MCP through npx
  ask a real agent host:
    "Open this FCS file and gate the main population."
  pass only if the trace uses Flowcyto MCP tools without AGENTS.md, scripts,
  Python plotting, direct JSON patching, or browser inspection
  validate final artifact with scripts/validate-live-demo-result.mjs --allow-no-agents

Release pass:
  npm run verify:publish passes
  public alpha package is bumped and published after implementation
  public npx MCP SDK smoke confirms open_fcs, render_plot, open_gate_editor,
  get_plot_context, and upsert_gate are exposed
```

Non-goals:

```text
do not build a full analysis engine into Flowcyto MCP
do not hard-code the main-population gate algorithm
do not rely on AGENTS.md for product correctness
do not add a JSON-writing demo script as the agent path
do not require users to know the workspace format before opening an FCS file
```

Global pass criteria:

```text
npm run check passes
npm test passes
npm run verify:alpha passes
README lists the target tool names
docs do not present browser debug as the user path
new Datalox trajectory uses exact code_change or document_change evidence
```

If any pass criterion requires a human/manual step, write the exact command,
host name, OS, expected visual result, and failure output before calling it
passed.

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
agent opens compact app -> app tracks workspace revision
agent calls upsert_gate -> workspace revision increments -> open app refreshes
human edits gate in UI -> workspace revision increments -> agent sees updated context
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

Windows native preview parity should use the same local server and compact app
surface hosted in WebView2, not a browser tab or Electron shell. The concrete
implementation plan is in:

```text
docs/windows-webview2-compact-window.md
```

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
no direct CLI equivalent            get_plot_context
no direct CLI equivalent            upsert_gate/delete_gate
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
    ui://flowcyto/gate-editor-v1.html
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
get_plot_context
get_event_preview
upsert_gate
delete_gate
get_workspace_revision
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
flowcyto.open_gate_editor(workspace_path, sample_id?, view_id?) -> compact app surface
flowcyto.get_plot_context(workspace_path, sample_id?, view_id?) -> agent-ready plot context
flowcyto.upsert_gate(workspace_path, gate, expected_revision) -> revision-safe gate write
flowcyto.delete_gate(workspace_path, gate_id, expected_revision) -> revision-safe gate delete
flowcyto.open_workspace(path) -> workspace summary
flowcyto.read_workspace(path) -> workspace JSON
flowcyto.write_workspace(path, workspace, expected_revision?) -> validation result
flowcyto.list_samples(workspace_path) -> sample ids and FCS paths
flowcyto.get_sample_metadata(workspace_path, sample_id) -> parameters and keywords
flowcyto.get_event_preview(workspace_path, sample_id, x, y, parent_gate_id?, max_events?) -> renderable points or bins
flowcyto.validate_workspace(workspace_path) -> errors for agent repair
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

type PlotContext = {
  ok: boolean
  workspacePath: string
  revision: number
  sampleId: string
  viewId?: string
  x: string
  y: string
  parent: string
  scale: { x: "linear" | "arcsinh" | "biex"; y: "linear" | "arcsinh" | "biex" }
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number }
  preview: EventPreview
  gates: WorkspaceGate[]
  gateSchema: {
    preferredTypes: Array<"polygon" | "rect" | "range">
    requiredRevisionField: "expected_revision"
  }
}
```

Tool behavior rules:

- `open_gate_editor` opens the compact surface. In MCP Apps hosts, it returns
  metadata that causes the host to render `ui://flowcyto/gate-editor-v1.html`.
- `get_plot_context` is the agent's read path for deciding what gate to write.
  It should not require the agent to scrape the UI or inspect raw canvas pixels.
- `upsert_gate` is the primary agent write path for gates and must require
  `expected_revision`.
- `read_workspace` returns the parsed JSON exactly enough for the agent to edit it.
- `write_workspace` validates before writing and returns structured errors.
- `get_event_preview` is for display only. It must not be treated as full analysis data.
- `get_sample_metadata` should expose enough FCS keywords for the agent to reason and write code.
- No tool should silently repair invalid artifacts.
- No tool should make biological choices.

## UI Resource

Provide one MCP App resource:

```text
ui://flowcyto/gate-editor-v1.html
```

The tool that opens it:

```text
flowcyto.open_gate_editor(workspace_path, sample_id?, view_id?) -> MCP App UI
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
flowcyto.get_plot_context
flowcyto.get_event_preview
flowcyto.upsert_gate
flowcyto.delete_gate
flowcyto.get_workspace_revision
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
agent calls open_gate_editor -> compact app opens and tracks revision
agent calls get_plot_context -> agent gets axes, bounds, preview, gates, revision
agent calls upsert_gate -> workspace revision increments
open compact app polls revision -> new gate appears without manual reload
human UI edit -> upsert_gate/write_workspace -> agent sees updated context
```

This is part of the MVP. Do not ship a gate editor that requires manual reload to see agent changes.

Implementation options:

- Server-side file watcher pushes updated workspace to the UI.
- UI polls `read_workspace` at a short interval.
- MCP App receives updated tool results from the host when the agent calls a write tool.

Start with polling if it keeps the system simple. Replace with a watcher only when needed.

Concrete MVP:

```text
UI polls get_workspace_revision every 1000 ms while visible.
UI compares revision.
If revision changed and no local edit is in progress, refresh through get_plot_context.
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

Direct file editing is a fallback, not the desired agent demo path. The desired
path is `get_plot_context` followed by `upsert_gate` so the agent sees the
revision contract and writes one structured gate rather than freehand patching
the whole workspace.

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
   verify flowcyto.open_gate_editor opens the compact surface without browser chrome
   verify flowcyto.get_plot_context gives the agent axes, bounds, preview, gates, and revision
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
flowcyto.open_gate_editor opens the compact resource in the real MCP host
flowcyto.get_plot_context returns agent-ready plot context
human-drawn gate increments workspace revision
agent-written upsert_gate appears in the already-open surface within about 1 second
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
   ask the agent to open the workspace and gate the main population
   verify the agent calls flowcyto.open_gate_editor
   verify the host embeds ui://flowcyto/gate-editor-v1.html
```

The named MCP host proof must check:

```text
tools/list includes open_gate_editor, get_plot_context, upsert_gate,
delete_gate, and get_workspace_revision

resources/read returns ui://flowcyto/gate-editor-v1.html with
text/html;profile=mcp-app

open_gate_editor opens the compact plot panel inside the host, not a browser
tab or a manually launched demo watcher

the embedded app receives window.openai.callTool from the host

agent calls get_plot_context after opening the surface

human draw/edit writes a gate and increments workspace.revision

agent calls upsert_gate while the app is open

the open app shows the new revision and gate without manual reload
```

The local `/mcp-app-preview` route is not the named host proof. It is only a
developer preview that injects a compatible `window.openai.callTool` shim.

Compatibility aliases may exist during migration, but the validation script and
video should use the target tool names. A passing proof should be understandable
as:

```text
natural language user request
-> flowcyto.open_gate_editor
-> compact embedded Flowcyto app appears
-> flowcyto.get_plot_context
-> flowcyto.upsert_gate
-> already-open app updates live
```

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

## Milestone J: Agent-Opened Compact Viewer Live Test

Status:

```text
passed on 2026-05-12 for Codex and direct MCP.
Claude CLI was not available on this machine, so Claude remains a documented
manual validation item.
```

Product requirement:

```text
When a user asks an agent to open, inspect, or gate an FCS file, the agent should
open the compact Flowcyto surface as part of the tool chain. The user should not
need a second prompt such as "now open the gate editor".
```

Implementation:

```text
open_fcs default nextAction now opens open_gate_editor
nextAction.required = true
gateEditorPolicy.compactGateEditorRequired = true
non-UI agent default surface = native_window
MCP Apps-capable host surface = mcp_app
surface="none" remains the explicit render-only automation path
```

Agent result chain:

```text
open_fcs
  -> open_gate_editor
  -> get_plot_context
  -> upsert_gate
  -> get_workspace_revision
```

Live-test evidence is recorded in:

```text
docs/compact-viewer-auto-open-live-test-2026-05-12.md
```

Pass criteria:

```text
npm test passes
direct MCP live test follows open_fcs.nextAction and opens native_window
fresh Codex run from an empty directory succeeds without AGENTS.md
fresh Codex tool trace includes open_gate_editor before get_plot_context
get_plot_context returns compact metadata without raw FCS keywords
```
