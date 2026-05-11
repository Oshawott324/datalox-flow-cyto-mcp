import process from "node:process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  isLocalGateEditorPreviewUrl,
  launchNativeGateEditorWindow,
  nativeGateEditorReadinessError,
  type NativeGateEditorWindow,
} from "../app/gate-editor/native-window.js";
import { GATE_EDITOR_HTML } from "../app/gate-editor/ui.js";
import { getGateEditorState, getPlotContext, startGateEditorServer, type GateEditorServer } from "../app/gate-editor/server.js";
import {
  FlowcytoError,
  deleteGate,
  getEventPreview,
  getSampleMetadata,
  listSamples,
  openWorkspace,
  readWorkspace,
  upsertGate,
  validateWorkspace,
  writeWorkspace,
  type FlowcytoWorkspace,
  type WorkspaceGate,
} from "../core/index.js";

const GATE_EDITOR_RESOURCE_URI = "ui://flowcyto/gate-editor-v1.html";
const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

const JsonObject = z.record(z.string(), z.unknown());
const JsonResultSchema = {
  result: z.unknown(),
};
const GateEditorSurfaceSchema = z.enum(["auto", "mcp_app", "native_window"]);
const GateEditorMcpAppMeta = {
  ui: {
    resourceUri: GATE_EDITOR_RESOURCE_URI,
    visibility: ["model", "app"],
  },
  "openai/outputTemplate": GATE_EDITOR_RESOURCE_URI,
  "openai/widgetAccessible": true,
};

type GateEditorSession = {
  server: GateEditorServer;
  nativeWindow?: NativeGateEditorWindow;
};

type GateEditorSelection = {
  workspacePath: string;
  sampleId: string;
  parent: string;
  x: string;
  y: string;
  maxEvents: number;
};

function resultContent(result: unknown, meta?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ result }, null, 2) }],
    structuredContent: { result },
    ...(meta ? { _meta: meta } : {}),
  };
}

function errorResult(error: unknown) {
  if (error instanceof FlowcytoError) {
    return {
      ok: false,
      errors: [{ path: error.path ?? "/", code: error.code, message: error.message }],
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    errors: [{ path: "/", code: "tool_failed", message }],
  };
}

function flowcytoAgentContract(extra?: Record<string, unknown>) {
  return {
    version: 1,
    intent: "open_then_context_then_gate",
    forbiddenActions: [
      "do_not_write_workspace_json_directly",
      "do_not_inspect_local_preview_server",
      "do_not_use_browser_or_desktop_automation_for_gate_geometry",
      "do_not_read_fcs_or_workspace_with_local_scripts_for_gate_geometry",
      "do_not_use_local_python_or_plotting_for_gate_geometry",
    ],
    ...extra,
  };
}

function plotContextNextAction(selection: GateEditorSelection) {
  return {
    tool: "get_plot_context",
    arguments: {
      workspace_path: selection.workspacePath,
      sample_id: selection.sampleId,
      parent_gate_id: selection.parent,
      x: selection.x,
      y: selection.y,
      max_events: selection.maxEvents,
      format: "bins",
      bin_width: 64,
      bin_height: 64,
    },
  };
}

function workspaceRevisionNextAction(workspacePath: string) {
  return {
    tool: "get_workspace_revision",
    arguments: {
      workspace_path: workspacePath,
    },
  };
}

async function resolveGateEditorSelection(params: {
  workspacePath: string;
  sampleId?: string;
  parent?: string;
  x?: string;
  y?: string;
  maxEvents?: number;
}): Promise<GateEditorSelection> {
  const workspace = await readWorkspace(params.workspacePath);
  const sampleId = params.sampleId ?? workspace.samples[0]?.id;
  if (!sampleId) {
    throw new FlowcytoError("missing_sample", "Workspace must contain at least one sample.", "/samples");
  }
  const metadata = await getSampleMetadata(params.workspacePath, sampleId);
  const view = workspace.views.find((entry) => entry.sample === sampleId);
  const x = params.x ?? view?.x ?? metadata.parameters[0]?.name;
  const y = params.y ?? view?.y ?? metadata.parameters[1]?.name;
  if (!x || !y) {
    throw new FlowcytoError("missing_axes", "Both x and y axes are required.", "/views");
  }
  return {
    workspacePath: params.workspacePath,
    sampleId,
    parent: params.parent ?? view?.parent ?? "root",
    x,
    y,
    maxEvents: params.maxEvents ?? 10000,
  };
}

function gateEditorSurface(params: {
  url?: string;
  workspacePath: string;
  sampleId?: string;
  parent?: string;
  x?: string;
  y?: string;
  maxEvents?: number;
  runtime?: string;
  pid?: number;
  kind: "webview" | "mcp_app";
} | {
  url: string;
  workspacePath: string;
  sampleId?: string;
  parent?: string;
  x?: string;
  y?: string;
  maxEvents?: number;
  runtime: string;
  pid?: number;
  kind: "native_window";
}) {
  const titleParts = [params.sampleId, params.parent ?? "Ungated"].filter(Boolean);
  return {
    kind: params.kind,
    title: titleParts.length > 0 ? titleParts.join(" · ") : "Flowcyto Gate Editor",
    preferredWidth: 620,
    preferredHeight: 620,
    ...(params.url ? { url: params.url } : {}),
    ...(params.kind === "mcp_app" ? { resourceUri: GATE_EDITOR_RESOURCE_URI } : {}),
    ...(params.kind === "native_window" ? { runtime: params.runtime, pid: params.pid } : {}),
    workspacePath: params.workspacePath,
    sampleId: params.sampleId,
    parent: params.parent ?? "root",
    x: params.x,
    y: params.y,
    maxEvents: params.maxEvents,
  };
}

function mcpAppGateEditorResult(params: {
  workspacePath: string;
  selection: GateEditorSelection;
}) {
  return {
    ok: true,
    workspacePath: params.workspacePath,
    sampleId: params.selection.sampleId,
    parent: params.selection.parent,
    x: params.selection.x,
    y: params.selection.y,
    maxEvents: params.selection.maxEvents,
    surface: gateEditorSurface({
      kind: "mcp_app",
      workspacePath: params.workspacePath,
      sampleId: params.selection.sampleId,
      parent: params.selection.parent,
      x: params.selection.x,
      y: params.selection.y,
      maxEvents: params.selection.maxEvents,
    }),
    agentContract: flowcytoAgentContract({
      refresh: "already_open_app_refreshes_from_revision_poll",
    }),
    nextAction: plotContextNextAction(params.selection),
  };
}

async function nativeWindowGateEditorResult(
  sessions: Map<string, GateEditorSession>,
  params: {
    workspacePath: string;
    host?: string;
    port?: number;
    sampleId?: string;
    parent?: string;
    x?: string;
    y?: string;
    maxEvents?: number;
    selection: GateEditorSelection;
    width?: number;
    height?: number;
  },
) {
  const readinessError = nativeGateEditorReadinessError();
  if (readinessError) throw readinessError;

  const gateEditor = await startGateEditorServer({
    workspacePath: params.workspacePath,
    host: params.host,
    port: params.port,
    sampleId: params.sampleId,
    x: params.x,
    y: params.y,
    maxEvents: params.maxEvents,
  });
  try {
    if (!isLocalGateEditorPreviewUrl(gateEditor.mcpAppPreviewUrl)) {
      throw new FlowcytoError(
        "native_window_url_not_local",
        "Native gate editor windows only accept the local /mcp-app-preview URL.",
        "/surface/url",
      );
    }
    const nativeWindow = launchNativeGateEditorWindow({
      url: gateEditor.mcpAppPreviewUrl,
      title: `${params.sampleId ?? "Ungated"} - Flowcyto`,
      width: params.width,
      height: params.height,
    });
    await nativeWindow.ready;
    sessions.set(gateEditor.sessionId, { server: gateEditor, nativeWindow });
    return {
      ok: true,
      sessionId: gateEditor.sessionId,
      workspacePath: gateEditor.workspacePath,
      host: gateEditor.host,
      port: gateEditor.port,
      url: gateEditor.url,
      mcpAppPreviewUrl: gateEditor.mcpAppPreviewUrl,
      surface: gateEditorSurface({
        kind: "native_window",
        url: gateEditor.mcpAppPreviewUrl,
        runtime: nativeWindow.runtime,
        pid: nativeWindow.pid,
        workspacePath: gateEditor.workspacePath,
        sampleId: params.selection.sampleId,
        parent: params.selection.parent,
        x: params.selection.x,
        y: params.selection.y,
        maxEvents: params.selection.maxEvents,
      }),
      agentContract: flowcytoAgentContract({
        refresh: "already_open_app_refreshes_from_revision_poll",
      }),
      nextAction: plotContextNextAction(params.selection),
    };
  } catch (error) {
    await gateEditor.close().catch(() => undefined);
    throw error;
  }
}

function createFlowcytoMcpServer(): McpServer {
  const server = new McpServer({
    name: "flowcyto-mcp",
    version: "0.1.0",
  });
  const gateEditorSessions = new Map<string, GateEditorSession>();

server.registerResource(
  "flowcyto_gate_editor",
  GATE_EDITOR_RESOURCE_URI,
  {
    title: "Flowcyto Gate Editor",
    description: "Compact embedded flow cytometry gate editor.",
    mimeType: MCP_APP_MIME_TYPE,
    _meta: {
      ui: {
        prefersBorder: true,
      },
    },
  },
  async () => ({
    contents: [{
      uri: GATE_EDITOR_RESOURCE_URI,
      mimeType: MCP_APP_MIME_TYPE,
      text: GATE_EDITOR_HTML,
      _meta: {
        ui: {
          prefersBorder: true,
        },
      },
    }],
  }),
);

async function toolContent(action: () => Promise<unknown>, meta?: Record<string, unknown>) {
  try {
    return resultContent(await action(), meta);
  } catch (error) {
    return {
      ...resultContent(errorResult(error)),
      isError: true as const,
    };
  }
}

server.registerTool(
  "open_workspace",
  {
    description: "Open a flow cytometry workspace and return a summary.",
    inputSchema: { path: z.string() },
    outputSchema: JsonResultSchema,
  },
  async ({ path }) => toolContent(() => openWorkspace(path)),
);

server.registerTool(
  "read_workspace",
  {
    description: "Read the canonical flowcyto.workspace.json artifact.",
    inputSchema: { path: z.string() },
    outputSchema: JsonResultSchema,
  },
  async ({ path }) => toolContent(() => readWorkspace(path)),
);

server.registerTool(
  "write_workspace",
  {
    description: "Validate and atomically write a replacement workspace artifact.",
    inputSchema: {
      path: z.string(),
      workspace: JsonObject,
      expected_revision: z.number().int().optional(),
    },
    outputSchema: JsonResultSchema,
  },
  async ({ path, workspace, expected_revision }) => toolContent(() =>
    writeWorkspace({
      workspacePath: path,
      workspace: workspace as FlowcytoWorkspace,
      expectedRevision: expected_revision,
    }),
  ),
);

server.registerTool(
  "validate_workspace",
  {
    description: "Validate a flowcyto.workspace.json artifact.",
    inputSchema: { path: z.string() },
    outputSchema: JsonResultSchema,
  },
  async ({ path }) => toolContent(() => validateWorkspace(path)),
);

server.registerTool(
  "list_samples",
  {
    description: "List sample ids and FCS paths in a workspace.",
    inputSchema: { workspace_path: z.string() },
    outputSchema: JsonResultSchema,
  },
  async ({ workspace_path }) => toolContent(() => listSamples(workspace_path)),
);

server.registerTool(
  "get_sample_metadata",
  {
    description: "Read FCS metadata for a workspace sample without loading event data.",
    inputSchema: { workspace_path: z.string(), sample_id: z.string() },
    outputSchema: JsonResultSchema,
  },
  async ({ workspace_path, sample_id }) => toolContent(() => getSampleMetadata(workspace_path, sample_id)),
);

server.registerTool(
  "get_event_preview",
  {
    description: "Return capped renderable preview points or bins for two sample channels. Use this MCP result instead of reading FCS files with local Python or plotting scripts.",
    inputSchema: {
      workspace_path: z.string(),
      sample_id: z.string(),
      x: z.string(),
      y: z.string(),
      parent_gate_id: z.string().optional(),
      max_events: z.number().int().positive().optional(),
      format: z.enum(["auto", "points", "bins"]).optional(),
      bin_width: z.number().int().positive().optional(),
      bin_height: z.number().int().positive().optional(),
    },
    outputSchema: JsonResultSchema,
  },
  async ({ workspace_path, sample_id, x, y, parent_gate_id, max_events, format, bin_width, bin_height }) => toolContent(() =>
    getEventPreview({
      workspacePath: workspace_path,
      sampleId: sample_id,
      x,
      y,
      parent: parent_gate_id,
      maxEvents: max_events,
      format,
      binWidth: bin_width,
      binHeight: bin_height,
    }).then((result) => ({
      ...result,
      agentContract: flowcytoAgentContract({
        geometrySource: "preview_from_this_tool_result",
      }),
      nextAction: {
        tool: "get_plot_context",
        arguments: {
          workspace_path,
          sample_id,
          parent_gate_id: parent_gate_id ?? "root",
          x,
          y,
          max_events,
          format,
          bin_width,
          bin_height,
        },
      },
    })),
  ),
);

server.registerTool(
  "get_plot_context",
  {
    description: "Return revision, axes, bounds, preview, and recommended gate-write contract for the active gate editor view. Call this before upsert_gate. Use the returned preview/bins for gate geometry; do not read FCS files with local scripts.",
    inputSchema: {
      workspace_path: z.string(),
      sample_id: z.string().optional(),
      parent_gate_id: z.string().optional(),
      x: z.string().optional(),
      y: z.string().optional(),
      max_events: z.number().int().positive().optional(),
      format: z.enum(["auto", "points", "bins"]).optional(),
      bin_width: z.number().int().positive().optional(),
      bin_height: z.number().int().positive().optional(),
    },
    outputSchema: JsonResultSchema,
  },
  async ({ workspace_path, sample_id, parent_gate_id, x, y, max_events, format, bin_width, bin_height }) => toolContent(() =>
    getPlotContext({
      workspacePath: workspace_path,
      sampleId: sample_id,
      parent: parent_gate_id,
      x,
      y,
      maxEvents: max_events,
      format,
      binWidth: bin_width,
      binHeight: bin_height,
    }),
  ),
);

server.registerTool(
  "get_gate_editor_state",
  {
    description: "Deprecated alias for get_plot_context.",
    inputSchema: {
      workspace_path: z.string(),
      sample_id: z.string().optional(),
      parent_gate_id: z.string().optional(),
      x: z.string().optional(),
      y: z.string().optional(),
      max_events: z.number().int().positive().optional(),
      format: z.enum(["auto", "points", "bins"]).optional(),
      bin_width: z.number().int().positive().optional(),
      bin_height: z.number().int().positive().optional(),
    },
    outputSchema: JsonResultSchema,
  },
  async ({ workspace_path, sample_id, parent_gate_id, x, y, max_events, format, bin_width, bin_height }) => toolContent(() =>
    getGateEditorState({
      workspacePath: workspace_path,
      sampleId: sample_id,
      parent: parent_gate_id,
      x,
      y,
      maxEvents: max_events,
      format,
      binWidth: bin_width,
      binHeight: bin_height,
    }),
  ),
);

server.registerTool(
  "get_workspace_revision",
  {
    description: "Return the current workspace revision for lightweight embedded UI refresh checks.",
    inputSchema: { workspace_path: z.string() },
    outputSchema: JsonResultSchema,
  },
  async ({ workspace_path }) => toolContent(async () => {
    const workspace = await readWorkspace(workspace_path);
    return {
      ok: true,
      workspacePath: workspace_path,
      revision: workspace.revision,
      gateCount: Array.isArray(workspace.gates) ? workspace.gates.length : 0,
      nextAction: null,
    };
  }),
);

server.registerTool(
  "upsert_gate",
  {
    description: "Create or update a gate in the canonical workspace artifact using revision-safe writes. Use expected_revision from get_plot_context. For FSC/SSC main-population gating, prefer polygon unless the user explicitly requests another shape. Do not patch workspace JSON directly. After this, call get_workspace_revision.",
    inputSchema: {
      workspace_path: z.string(),
      gate: JsonObject,
      expected_revision: z.number().int(),
    },
    outputSchema: JsonResultSchema,
  },
  async ({ workspace_path, gate, expected_revision }) => toolContent(() =>
    upsertGate({
      workspacePath: workspace_path,
      gate: gate as WorkspaceGate,
      expectedRevision: expected_revision,
    }).then((result) => ({
      ...result,
      agentContract: flowcytoAgentContract({
        refresh: "already_open_app_refreshes_from_revision_poll",
      }),
      nextAction: result.ok ? workspaceRevisionNextAction(workspace_path) : null,
    })),
  ),
);

server.registerTool(
  "delete_gate",
  {
    description: "Delete a gate from the canonical workspace artifact using revision-safe writes.",
    inputSchema: {
      workspace_path: z.string(),
      gate_id: z.string(),
      expected_revision: z.number().int(),
    },
    outputSchema: JsonResultSchema,
  },
  async ({ workspace_path, gate_id, expected_revision }) => toolContent(() =>
    deleteGate({
      workspacePath: workspace_path,
      gateId: gate_id,
      expectedRevision: expected_revision,
    }),
  ),
);

server.registerTool(
  "render_gate_editor",
  {
    description: "Deprecated alias for open_gate_editor with surface=mcp_app.",
    inputSchema: {
      workspace_path: z.string(),
      sample_id: z.string().optional(),
      parent_gate_id: z.string().optional(),
      x: z.string().optional(),
      y: z.string().optional(),
      max_events: z.number().int().positive().optional(),
    },
    outputSchema: JsonResultSchema,
    annotations: { readOnlyHint: true },
  },
  async ({ workspace_path, sample_id, parent_gate_id, x, y, max_events }) => toolContent(async () =>
    mcpAppGateEditorResult({
      workspacePath: workspace_path,
      selection: await resolveGateEditorSelection({
        workspacePath: workspace_path,
        sampleId: sample_id,
        parent: parent_gate_id,
        x,
        y,
        maxEvents: max_events,
      }),
    }),
  GateEditorMcpAppMeta),
);

server.registerTool(
  "open_gate_editor",
  {
    description: "Open the compact gate editor surface for a workspace. In CLI or non-UI agent hosts, pass surface=\"native_window\" so a compact native window opens. After this call, call get_plot_context using result.nextAction.arguments. Do not inspect local preview URLs, run local FCS analysis scripts, or write the workspace JSON directly.",
    inputSchema: {
      workspace_path: z.string(),
      surface: GateEditorSurfaceSchema.optional(),
      host: z.string().optional(),
      port: z.number().int().min(0).max(65535).optional(),
      sample_id: z.string().optional(),
      parent_gate_id: z.string().optional(),
      x: z.string().optional(),
      y: z.string().optional(),
      max_events: z.number().int().positive().optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
    },
    outputSchema: JsonResultSchema,
    annotations: { readOnlyHint: true },
    _meta: GateEditorMcpAppMeta,
  },
  async ({ workspace_path, surface, host, port, sample_id, parent_gate_id, x, y, max_events, width, height }) =>
    toolContent(async () => {
      const selection = await resolveGateEditorSelection({
        workspacePath: workspace_path,
        sampleId: sample_id,
        parent: parent_gate_id,
        x,
        y,
        maxEvents: max_events,
      });
      const selectedSurface = surface ?? "auto";
      if (selectedSurface === "native_window") {
        return nativeWindowGateEditorResult(gateEditorSessions, {
          workspacePath: workspace_path,
          host,
          port,
          sampleId: selection.sampleId,
          parent: selection.parent,
          x: selection.x,
          y: selection.y,
          maxEvents: selection.maxEvents,
          selection,
          width,
          height,
        });
      }
      return mcpAppGateEditorResult({
        workspacePath: workspace_path,
        selection,
      });
    }, GateEditorMcpAppMeta),
);

server.registerTool(
  "close_gate_editor",
  {
    description: "Close a gate editor session created by open_gate_editor.",
    inputSchema: {
      session_id: z.string(),
    },
    outputSchema: JsonResultSchema,
  },
  async ({ session_id }) => toolContent(async () => {
    const session = gateEditorSessions.get(session_id);
    if (!session) {
      throw new FlowcytoError("unknown_gate_editor_session", `Gate editor session ${session_id} is not present.`, "/session_id");
    }
    session.nativeWindow?.close();
    await session.server.close();
    gateEditorSessions.delete(session_id);
    return { ok: true, sessionId: session_id };
  }),
);

  return server;
}

type HttpOptions = {
  host: string;
  port: number;
  path: string;
};

function argValue(args: string[], name: string, fallback?: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function parseHttpOptions(args: string[]): HttpOptions | null {
  if (!args.includes("--http")) return null;
  return {
    host: argValue(args, "--host", "127.0.0.1") ?? "127.0.0.1",
    port: Number.parseInt(argValue(args, "--port", "3000") ?? "3000", 10),
    path: argValue(args, "--path", "/mcp") ?? "/mcp",
  };
}

function writeJsonResponse(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,mcp-session-id,mcp-protocol-version,last-event-id,authorization",
    "access-control-expose-headers": "mcp-session-id,mcp-protocol-version",
  });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function writeCorsPreflight(response: ServerResponse): void {
  response.writeHead(204, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,mcp-session-id,mcp-protocol-version,last-event-id,authorization",
    "access-control-expose-headers": "mcp-session-id,mcp-protocol-version",
    "access-control-max-age": "86400",
  });
  response.end();
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function containsInitializeRequest(value: unknown): boolean {
  return Array.isArray(value) ? value.some(isInitializeRequest) : isInitializeRequest(value);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim().length === 0) return undefined;
  return JSON.parse(text) as unknown;
}

async function startHttp(options: HttpOptions): Promise<void> {
  const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

  const writeJsonRpcError = (response: ServerResponse, status: number, code: number, message: string) => {
    writeJsonResponse(response, status, {
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    });
  };

  const handleMcpPost = async (request: IncomingMessage, response: ServerResponse) => {
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch {
      writeJsonRpcError(response, 400, -32700, "Parse error: Invalid JSON");
      return;
    }

    const sessionId = headerValue(request.headers["mcp-session-id"]);
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (existing) {
      await existing.transport.handleRequest(request, response, body);
      return;
    }

    if (sessionId) {
      writeJsonRpcError(response, 404, -32001, "Session not found");
      return;
    }

    if (!containsInitializeRequest(body)) {
      writeJsonRpcError(response, 400, -32000, "Bad Request: No valid session ID provided");
      return;
    }

    const mcpServer = createFlowcytoMcpServer();
    let transport: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        sessions.set(newSessionId, { server: mcpServer, transport });
      },
    });
    transport.onclose = () => {
      const closedSessionId = transport.sessionId;
      if (closedSessionId) sessions.delete(closedSessionId);
    };
    await mcpServer.connect(transport);
    await transport.handleRequest(request, response, body);
  };

  const handleMcpSessionRequest = async (request: IncomingMessage, response: ServerResponse) => {
    const sessionId = headerValue(request.headers["mcp-session-id"]);
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (!existing) {
      writeJsonRpcError(response, 400, -32000, "Invalid or missing MCP session ID");
      return;
    }
    await existing.transport.handleRequest(request, response);
  };

  const httpServer = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${options.host}:${options.port}`}`);
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-expose-headers", "mcp-session-id,mcp-protocol-version");

    if (request.method === "OPTIONS") {
      writeCorsPreflight(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/") {
      writeJsonResponse(response, 200, {
        ok: true,
        name: "flowcyto-mcp",
        transport: "streamable_http",
        mcpPath: options.path,
      });
      return;
    }
    if (url.pathname === options.path && (
      request.method === "GET" || request.method === "POST" || request.method === "DELETE"
    )) {
      const handler = request.method === "POST" ? handleMcpPost : handleMcpSessionRequest;
      handler(request, response).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!response.headersSent) {
          writeJsonRpcError(response, 500, -32603, message);
        } else {
          response.end();
        }
      });
      return;
    }
    writeJsonResponse(response, 404, {
      ok: false,
      errors: [{ path: url.pathname, code: "not_found", message: `No flowcyto MCP HTTP route for ${url.pathname}.` }],
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const url = `http://${options.host}:${port}${options.path}`;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    name: "flowcyto-mcp",
    transport: "streamable_http",
    host: options.host,
    port,
    path: options.path,
    url,
  }, null, 2)}\n`);
  process.stderr.write(`flowcyto MCP Streamable HTTP listening at ${url}\n`);

  const shutdown = async () => {
    await Promise.all([...sessions.values()].map(({ transport }) => transport.close().catch(() => undefined)));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
  process.once("SIGINT", () => {
    shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    shutdown().finally(() => process.exit(0));
  });
  await new Promise<void>(() => undefined);
}

async function main(): Promise<void> {
  const httpOptions = parseHttpOptions(process.argv.slice(2));
  if (httpOptions) {
    await startHttp(httpOptions);
    return;
  }
  const server = createFlowcytoMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
