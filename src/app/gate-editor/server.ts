import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import {
  FlowcytoError,
  deleteGate,
  getEventPreview,
  getSampleMetadata,
  readWorkspace,
  upsertGate,
  validateWorkspace,
  watchWorkspaceFile,
  type PreviewFormat,
  type FlowcytoWorkspace,
  type WorkspaceGate,
} from "../../core/index.js";
import { GATE_EDITOR_HTML } from "./ui.js";

export type GateEditorServerOptions = {
  workspacePath: string;
  host?: string;
  port?: number;
  sampleId?: string;
  x?: string;
  y?: string;
  maxEvents?: number;
};

export type GateEditorServer = {
  sessionId: string;
  workspacePath: string;
  host: string;
  port: number;
  url: string;
  mcpAppPreviewUrl: string;
  close(): Promise<void>;
};

type JsonBody = Record<string, unknown>;

export type GateEditorStateOptions = {
  workspacePath: string;
  sampleId?: string;
  parent?: string;
  x?: string;
  y?: string;
  maxEvents?: number;
  format?: PreviewFormat;
  binWidth?: number;
  binHeight?: number;
};

function jsonResponse(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function htmlResponse(response: ServerResponse, value: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(value);
}

function scriptJson(value: unknown): string {
  if (value === undefined) return "undefined";
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function mcpAppPreviewHtml(options: GateEditorServerOptions): string {
  const config = {
    workspacePath: options.workspacePath,
    sampleId: options.sampleId,
    x: options.x,
    y: options.y,
    maxEvents: options.maxEvents,
  };
  const shim = `
  <script>
    window.__flowcytoMcpAppPreview = true;
    window.openai = {
      toolInput: ${scriptJson(config)},
      toolOutput: {
        ok: true,
        workspacePath: ${scriptJson(options.workspacePath)},
        sampleId: ${scriptJson(options.sampleId)},
        x: ${scriptJson(options.x)},
        y: ${scriptJson(options.y)},
        maxEvents: ${scriptJson(options.maxEvents)},
        surface: {
          kind: "mcp_app_preview",
          title: "Flowcyto Gate Editor",
          preferredWidth: 620,
          preferredHeight: 620
        }
      },
      async callTool(name, args = {}) {
        function value(name, fallback) {
          return args[name] || fallback;
        }
        function result(body, isError = false) {
          return { structuredContent: { result: body }, content: [{ type: "text", text: JSON.stringify({ result: body }, null, 2) }], isError };
        }
        async function jsonFetch(path, options) {
          const response = await fetch(path, options);
          const body = await response.json();
          return result(body, !response.ok || body.ok === false);
        }
        if (name === "get_gate_editor_state") {
          const params = new URLSearchParams();
          const sampleId = value("sample_id", ${scriptJson(options.sampleId)});
          const parent = value("parent_gate_id", "root");
          const x = value("x", ${scriptJson(options.x)});
          const y = value("y", ${scriptJson(options.y)});
          const maxEvents = value("max_events", ${scriptJson(options.maxEvents)});
          if (sampleId) params.set("sample_id", sampleId);
          if (parent) params.set("parent", parent);
          if (x) params.set("x", x);
          if (y) params.set("y", y);
          if (maxEvents) params.set("max_events", String(maxEvents));
          return jsonFetch("/api/state?" + params.toString());
        }
        if (name === "get_workspace_revision") {
          const response = await fetch("/api/health");
          const body = await response.json();
          return result({
            ok: body.ok,
            workspacePath: body.workspacePath,
            revision: body.revision,
            gateCount: body.gateCount,
            validation: body.validation,
            errors: body.errors
          }, body.ok === false);
        }
        if (name === "upsert_gate") {
          return jsonFetch("/api/gates/upsert", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ gate: args.gate, expectedRevision: args.expected_revision })
          });
        }
        if (name === "delete_gate") {
          return jsonFetch("/api/gates/delete", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ gateId: args.gate_id, expectedRevision: args.expected_revision })
          });
        }
        throw new Error("Unsupported preview MCP tool: " + name);
      }
    };
  </script>`;
  return GATE_EDITOR_HTML.replace("<body>", `<body>${shim}`);
}

function errorBody(error: unknown): { ok: false; errors: Array<{ path: string; code: string; message: string }> } {
  if (error instanceof FlowcytoError) {
    return {
      ok: false,
      errors: [{ path: error.path ?? "/", code: error.code, message: error.message }],
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    errors: [{ path: "/", code: "request_failed", message }],
  };
}

function readJsonBody(request: IncomingMessage): Promise<JsonBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > 1_000_000) {
        reject(new FlowcytoError("request_too_large", "JSON request body exceeds 1 MB."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) as JsonBody : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function stringParam(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  return value && value.length > 0 ? value : undefined;
}

function numberParam(url: URL, key: string): number | undefined {
  const value = url.searchParams.get(key);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatParam(url: URL): PreviewFormat | undefined {
  const value = stringParam(url, "format");
  if (value === "auto" || value === "points" || value === "bins") return value;
  return undefined;
}

function requiredString(value: unknown, path: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new FlowcytoError("missing_field", `${label} is required.`, path);
  }
  return value;
}

function requiredRevision(value: unknown): number {
  if (!Number.isInteger(value)) {
    throw new FlowcytoError("missing_expected_revision", "expectedRevision is required.", "/expectedRevision");
  }
  return value as number;
}

function chooseSample(workspace: FlowcytoWorkspace, requested?: string): string {
  const sampleId = requested ?? workspace.views[0]?.sample ?? workspace.samples[0]?.id;
  if (!sampleId) throw new FlowcytoError("workspace_has_no_samples", "Workspace has no samples.", "/samples");
  return sampleId;
}

export async function getGateEditorState(options: GateEditorStateOptions): Promise<unknown> {
  const workspace = await readWorkspace(options.workspacePath);
  const sampleId = chooseSample(workspace, options.sampleId);
  const metadata = await getSampleMetadata(options.workspacePath, sampleId);
  const view = workspace.views.find((entry) => entry.sample === sampleId);
  const parent = options.parent ?? view?.parent ?? "root";
  const x = options.x ?? view?.x ?? metadata.parameters[0]?.name;
  const y = options.y ?? view?.y ?? metadata.parameters[1]?.name;
  if (!x || !y) throw new FlowcytoError("missing_axes", "Both x and y axes are required.", "/views");
  const preview = await getEventPreview({
    workspacePath: options.workspacePath,
    sampleId,
    x,
    y,
    parent,
    maxEvents: options.maxEvents ?? 10000,
    format: options.format,
    binWidth: options.binWidth,
    binHeight: options.binHeight,
  });
  const validation = await validateWorkspace(options.workspacePath);
  return {
    ok: true,
    workspacePath: options.workspacePath,
    workspace,
    validation,
    sampleId,
    parent,
    x,
    y,
    metadata,
    preview,
  };
}

async function statePayload(options: GateEditorServerOptions, url: URL): Promise<unknown> {
  return getGateEditorState({
    workspacePath: options.workspacePath,
    sampleId: stringParam(url, "sample_id") ?? options.sampleId,
    parent: stringParam(url, "parent"),
    x: stringParam(url, "x") ?? options.x,
    y: stringParam(url, "y") ?? options.y,
    maxEvents: numberParam(url, "max_events") ?? options.maxEvents,
    format: formatParam(url),
    binWidth: numberParam(url, "bin_width"),
    binHeight: numberParam(url, "bin_height"),
  });
}

async function previewPayload(options: GateEditorServerOptions, url: URL): Promise<unknown> {
  const sampleId = requiredString(stringParam(url, "sample_id"), "/sample_id", "sample_id");
  const x = requiredString(stringParam(url, "x"), "/x", "x");
  const y = requiredString(stringParam(url, "y"), "/y", "y");
  return {
    ok: true,
    preview: await getEventPreview({
      workspacePath: options.workspacePath,
      sampleId,
      x,
      y,
      parent: stringParam(url, "parent") ?? "root",
      maxEvents: numberParam(url, "max_events") ?? options.maxEvents ?? 10000,
      format: formatParam(url),
      binWidth: numberParam(url, "bin_width"),
      binHeight: numberParam(url, "bin_height"),
    }),
  };
}

async function handleJsonRoute(
  options: GateEditorServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  if (request.method === "GET" && url.pathname === "/api/state") {
    jsonResponse(response, 200, await statePayload(options, url));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/workspace") {
    jsonResponse(response, 200, {
      ok: true,
      workspace: await readWorkspace(options.workspacePath),
      validation: await validateWorkspace(options.workspacePath),
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/health") {
    try {
      const workspace = await readWorkspace(options.workspacePath);
      const validation = await validateWorkspace(options.workspacePath);
      jsonResponse(response, 200, {
        ok: validation.ok,
        workspacePath: options.workspacePath,
        revision: workspace.revision,
        sampleCount: workspace.samples.length,
        gateCount: workspace.gates.length,
        validation,
      });
    } catch (error) {
      jsonResponse(response, 200, errorBody(error));
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/preview") {
    jsonResponse(response, 200, await previewPayload(options, url));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/gates/upsert") {
    const body = await readJsonBody(request);
    const result = await upsertGate({
      workspacePath: options.workspacePath,
      gate: body.gate as WorkspaceGate,
      expectedRevision: requiredRevision(body.expectedRevision),
    });
    jsonResponse(response, result.ok ? 200 : 409, result);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/gates/delete") {
    const body = await readJsonBody(request);
    const result = await deleteGate({
      workspacePath: options.workspacePath,
      gateId: requiredString(body.gateId, "/gateId", "gateId"),
      expectedRevision: requiredRevision(body.expectedRevision),
    });
    jsonResponse(response, result.ok ? 200 : 409, result);
    return;
  }
  jsonResponse(response, 404, {
    ok: false,
    errors: [{ path: url.pathname, code: "not_found", message: `No gate editor route for ${url.pathname}.` }],
  });
}

async function handleEvents(options: GateEditorServerOptions, response: ServerResponse): Promise<void> {
  const workspace = await readWorkspace(options.workspacePath);
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  response.write(`event: connected\ndata: ${JSON.stringify({ revision: workspace.revision })}\n\n`);
  const watcher = watchWorkspaceFile(options.workspacePath, (change) => {
    response.write(`event: workspace_changed\ndata: ${JSON.stringify({
      revision: change.revision,
      workspace: change.workspace,
    })}\n\n`);
  }, ({ error }) => {
    response.write(`event: workspace_error\ndata: ${JSON.stringify(errorBody(error))}\n\n`);
  });
  response.on("close", () => watcher.close());
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new FlowcytoError("invalid_server_address", "Gate editor server did not expose a TCP address."));
        return;
      }
      resolve(address.port);
    });
  });
}

export async function startGateEditorServer(options: GateEditorServerOptions): Promise<GateEditorServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 0;
  const sessionId = randomUUID();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${requestedPort}`}`);
    if (request.method === "GET" && url.pathname === "/") {
      htmlResponse(response, GATE_EDITOR_HTML);
      return;
    }
    if (request.method === "GET" && url.pathname === "/mcp-app-preview") {
      htmlResponse(response, mcpAppPreviewHtml(options));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      handleEvents(options, response).catch((error) => jsonResponse(response, 500, errorBody(error)));
      return;
    }
    handleJsonRoute(options, request, response, url).catch((error) => {
      jsonResponse(response, 500, errorBody(error));
    });
  });
  const port = await listen(server, host, requestedPort);
  const url = `http://${host}:${port}/`;
  const mcpAppPreviewUrl = `${url}mcp-app-preview`;
  return {
    sessionId,
    workspacePath: options.workspacePath,
    host,
    port,
    url,
    mcpAppPreviewUrl,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
  };
}
