import process from "node:process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { GATE_EDITOR_HTML } from "../app/gate-editor/ui.js";
import { getGateEditorState, startGateEditorServer, type GateEditorServer } from "../app/gate-editor/server.js";
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

function gateEditorSurface(params: {
  url?: string;
  workspacePath: string;
  sampleId?: string;
  parent?: string;
  x?: string;
  y?: string;
  maxEvents?: number;
  kind: "webview" | "mcp_app";
}) {
  const titleParts = [params.sampleId, params.parent ?? "Ungated"].filter(Boolean);
  return {
    kind: params.kind,
    title: titleParts.length > 0 ? titleParts.join(" · ") : "Flowcyto Gate Editor",
    preferredWidth: 620,
    preferredHeight: 620,
    ...(params.url ? { url: params.url } : {}),
    ...(params.kind === "mcp_app" ? { resourceUri: GATE_EDITOR_RESOURCE_URI } : {}),
    workspacePath: params.workspacePath,
    sampleId: params.sampleId,
    parent: params.parent ?? "root",
    x: params.x,
    y: params.y,
    maxEvents: params.maxEvents,
  };
}

function createFlowcytoMcpServer(): McpServer {
  const server = new McpServer({
    name: "flowcyto-mcp",
    version: "0.1.0",
  });
  const gateEditorSessions = new Map<string, GateEditorServer>();

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
    description: "Return capped renderable preview points for two sample channels.",
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
    }),
  ),
);

server.registerTool(
  "get_gate_editor_state",
  {
    description: "Return the complete render state for the embedded gate editor.",
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
    };
  }),
);

server.registerTool(
  "upsert_gate",
  {
    description: "Create or update a gate in the canonical workspace artifact using revision-safe writes.",
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
    }),
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
    description: "Render the compact gate editor as an MCP Apps component.",
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
    _meta: {
      ui: {
        resourceUri: GATE_EDITOR_RESOURCE_URI,
        visibility: ["model", "app"],
      },
      "openai/outputTemplate": GATE_EDITOR_RESOURCE_URI,
      "openai/widgetAccessible": true,
    },
  },
  async ({ workspace_path, sample_id, parent_gate_id, x, y, max_events }) => toolContent(async () => ({
    ok: true,
    workspacePath: workspace_path,
    sampleId: sample_id,
    parent: parent_gate_id ?? "root",
    x,
    y,
    maxEvents: max_events,
    surface: gateEditorSurface({
      kind: "mcp_app",
      workspacePath: workspace_path,
      sampleId: sample_id,
      parent: parent_gate_id,
      x,
      y,
      maxEvents: max_events,
    }),
  }), {
    ui: {
      resourceUri: GATE_EDITOR_RESOURCE_URI,
    },
    "openai/outputTemplate": GATE_EDITOR_RESOURCE_URI,
  }),
);

server.registerTool(
  "open_gate_editor",
  {
    description: "Start a local live gate editor surface for a workspace.",
    inputSchema: {
      workspace_path: z.string(),
      host: z.string().optional(),
      port: z.number().int().min(0).max(65535).optional(),
      sample_id: z.string().optional(),
      x: z.string().optional(),
      y: z.string().optional(),
      max_events: z.number().int().positive().optional(),
    },
    outputSchema: JsonResultSchema,
  },
  async ({ workspace_path, host, port, sample_id, x, y, max_events }) => toolContent(async () => {
    const gateEditor = await startGateEditorServer({
      workspacePath: workspace_path,
      host,
      port,
      sampleId: sample_id,
      x,
      y,
      maxEvents: max_events,
    });
    gateEditorSessions.set(gateEditor.sessionId, gateEditor);
    return {
      ok: true,
      sessionId: gateEditor.sessionId,
      workspacePath: gateEditor.workspacePath,
      host: gateEditor.host,
      port: gateEditor.port,
      url: gateEditor.url,
      mcpAppPreviewUrl: gateEditor.mcpAppPreviewUrl,
      surface: gateEditorSurface({
        kind: "webview",
        url: gateEditor.url,
        workspacePath: gateEditor.workspacePath,
        sampleId: sample_id,
        parent: "root",
        x,
        y,
        maxEvents: max_events,
      }),
    };
  }),
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
    const gateEditor = gateEditorSessions.get(session_id);
    if (!gateEditor) {
      throw new FlowcytoError("unknown_gate_editor_session", `Gate editor session ${session_id} is not present.`, "/session_id");
    }
    await gateEditor.close();
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
