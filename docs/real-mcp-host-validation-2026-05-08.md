# Real MCP Host Validation - 2026-05-08

## Scope

This run attempted the checklist in `docs/implementation-details.md` under
`Real MCP Host Validation`.

Security boundary for this run:

```text
host: 127.0.0.1
port: 8787
public tunnel: none
public network exposure: none
```

The MCP server was started with:

```bash
node dist/src/mcp/server.js --http --host 127.0.0.1 --port 8787
```

`lsof` confirmed the listener was localhost-only:

```text
TCP 127.0.0.1:8787 (LISTEN)
```

The server was stopped after validation.

## Host Availability

No usable named MCP Apps host was available to automate from this environment.

Observed local host surfaces:

```text
Codex CLI/app: available, but this session does not expose an embedded MCP Apps
surface for ui:// resources.

Cursor.app: installed, but this project has no configured Cursor MCP server in
~/.cursor/projects/Users-yifanjin-datalox-flow-cyto-mcp/mcps, and Cursor is not
the intended ChatGPT Apps host for window.openai.callTool component embedding.

Computer Use desktop control: blocked by macOS automation permission:
Apple event error -10000: Sender process is not authenticated.
```

Because of that, the full named-host UI proof remains blocked. The protocol
path was still validated with a real Streamable HTTP MCP client against the
localhost endpoint.

Protocol client used:

```text
MCP TypeScript SDK StreamableHTTPClientTransport
endpoint: http://127.0.0.1:8787/mcp
```

This is a real MCP transport/client check, but it is not a substitute for a
ChatGPT Apps or equivalent host rendering the embedded component.

## Checklist Result

| Checklist item | Result | Evidence |
| --- | --- | --- |
| `tools/list` includes `render_gate_editor`, `get_gate_editor_state`, `upsert_gate`, `delete_gate`, and `get_workspace_revision` | Pass | SDK client returned all required tools. |
| `resources/read` returns `ui://flowcyto/gate-editor-v1.html` with `text/html;profile=mcp-app` | Pass | SDK client read the resource with the expected MIME type. |
| `render_gate_editor` opens the compact plot panel inside the host, not a browser tab | Blocked | No automatable named MCP Apps host was available. The tool returned the expected `ui://` surface descriptor. |
| Embedded app receives `window.openai.callTool` from the host | Blocked | Requires a named MCP Apps host render. Local preview and SDK bridge have already tested compatible code paths, but this run did not prove host injection. |
| Human draw/edit writes a gate and increments `workspace.revision` | Blocked | Requires the embedded component to be open in a named host. |
| Agent calls `upsert_gate` or `write_workspace` while the app is open | Partial pass | SDK client called `upsert_gate`; revision incremented to `1`. It was not performed while a named-host app was open. |
| Open app shows the new revision and gate without manual reload | Blocked | Requires the embedded component to be open in a named host. |

## Protocol Evidence

The Streamable HTTP MCP client returned:

```json
{
  "host": "MCP TypeScript SDK StreamableHTTPClientTransport",
  "endpoint": "http://127.0.0.1:8787/mcp",
  "checks": {
    "toolsListIncludesRequired": true,
    "resourceListed": true,
    "resourceMime": "text/html;profile=mcp-app",
    "resourceHasCallToolCode": true,
    "renderToolOk": true,
    "renderResourceUri": "ui://flowcyto/gate-editor-v1.html",
    "agentWriteOk": true,
    "revisionAfterAgentWrite": 1,
    "gateCountAfterAgentWrite": 1
  },
  "requiredTools": [
    "delete_gate",
    "get_gate_editor_state",
    "get_workspace_revision",
    "render_gate_editor",
    "upsert_gate"
  ]
}
```

## Conclusion

The localhost Streamable HTTP MCP protocol path passes.

The full named MCP Apps host checklist does not pass yet because no automatable
host was available that can render `ui://flowcyto/gate-editor-v1.html` and inject
`window.openai.callTool`.

Public beta should remain blocked until this exact checklist passes in a named
MCP Apps host, with localhost or an authenticated/TLS deployment only.
