import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import {
  FlowcytoError,
  deleteGate,
  getEventPreview,
  getSampleMetadata,
  includePoint,
  normalizeBounds,
  readWorkspace,
  transformPoint,
  upsertGate,
  validateWorkspace,
  watchWorkspaceFile,
  type AxisScale,
  type EventPreview,
  type PreviewFormat,
  type FlowcytoWorkspace,
  type PlotBounds,
  type SampleMetadata,
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
  compensationId?: string;
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
  compensationId?: string;
};

export type PlotContextOptions = GateEditorStateOptions;

export type RenderablePlotContext = {
  ok: true;
  workspacePath: string;
  revision: number;
  workspace: FlowcytoWorkspace;
  validation: Awaited<ReturnType<typeof validateWorkspace>>;
  sampleId: string;
  viewId?: string;
  parent: string;
  x: string;
  y: string;
  xLabel: string;
  yLabel: string;
  scale: { x: AxisScale; y: AxisScale };
  bounds: PlotBounds;
  visualBounds: PlotBounds;
  metadata: ReturnType<typeof compactContextMetadata>;
  preview: EventPreview;
  previewSummary: {
    format: EventPreview["format"];
    totalEvents: number;
    filteredEvents: number;
    sampledEvents: number;
    pointCount: number;
    binWidth?: number;
    binHeight?: number;
    compensation?: EventPreview["compensation"];
  };
  gates: WorkspaceGate[];
  gateSchema: {
    preferredTypes: string[];
    requiredRevisionField: string;
  };
  expected_revision: number;
  recommendedGate: ReturnType<typeof recommendedGateContract>;
  agentContract: ReturnType<typeof flowcytoAgentContract>;
  nextAction: {
    tool: "upsert_gate";
    arguments: {
      workspace_path: string;
      expected_revision: number;
      gateTemplate: WorkspaceGate;
    };
  };
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
    compensationId: options.compensationId,
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
        compensationId: ${scriptJson(options.compensationId)},
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
        if (name === "get_plot_context" || name === "get_gate_editor_state") {
          const params = new URLSearchParams();
          const sampleId = value("sample_id", ${scriptJson(options.sampleId)});
          const parent = value("parent_gate_id", "root");
          const x = value("x", ${scriptJson(options.x)});
          const y = value("y", ${scriptJson(options.y)});
          const maxEvents = value("max_events", ${scriptJson(options.maxEvents)});
          const compensationId = value("compensation_id", ${scriptJson(options.compensationId)});
          if (sampleId) params.set("sample_id", sampleId);
          if (parent) params.set("parent", parent);
          if (x) params.set("x", x);
          if (y) params.set("y", y);
          if (maxEvents) params.set("max_events", String(maxEvents));
          if (compensationId) params.set("compensation_id", compensationId);
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

function channelNamed(parameters: SampleMetadata["parameters"], names: string[]): string | undefined {
  const lowerNames = new Set(names.map((name) => name.toLowerCase()));
  return parameters.find((parameter) => lowerNames.has(parameter.name.toLowerCase()))?.name;
}

function channelWithPrefix(parameters: SampleMetadata["parameters"], prefix: string): string | undefined {
  const lowerPrefix = prefix.toLowerCase();
  return parameters.find((parameter) => parameter.name.toLowerCase().startsWith(lowerPrefix))?.name;
}

function channelWithPrefixAndArea(parameters: SampleMetadata["parameters"], prefix: string): string | undefined {
  const lowerPrefix = prefix.toLowerCase();
  return parameters.find((parameter) => {
    const name = parameter.name.toLowerCase();
    return name.startsWith(lowerPrefix) && (name.endsWith("-a") || name.includes("-a "));
  })?.name;
}

export function recommendedAxes(metadata: SampleMetadata): { x?: string; y?: string } {
  const parameters = metadata.parameters;
  const x = channelNamed(parameters, ["FSC-A"])
    ?? channelWithPrefixAndArea(parameters, "FSC")
    ?? channelWithPrefix(parameters, "FSC")
    ?? parameters[0]?.name;
  const y = channelNamed(parameters, ["SSC-A"])
    ?? channelWithPrefixAndArea(parameters, "SSC")
    ?? channelWithPrefix(parameters, "SSC")
    ?? parameters.find((parameter) => parameter.name !== x)?.name;
  return { x, y };
}

function plotBounds(preview: Awaited<ReturnType<typeof getEventPreview>>, gates: WorkspaceGate[]): PlotBounds {
  const bounds: PlotBounds = {
    xMin: Number.POSITIVE_INFINITY,
    xMax: Number.NEGATIVE_INFINITY,
    yMin: Number.POSITIVE_INFINITY,
    yMax: Number.NEGATIVE_INFINITY,
  };
  preview.points?.forEach((point) => includePoint(bounds, point));
  if (preview.bins) {
    includePoint(bounds, [preview.bins.xMin, preview.bins.yMin]);
    includePoint(bounds, [preview.bins.xMin, preview.bins.yMax]);
    includePoint(bounds, [preview.bins.xMax, preview.bins.yMin]);
    includePoint(bounds, [preview.bins.xMax, preview.bins.yMax]);
  }
  gates.forEach((gate) => {
    if (gate.type === "polygon") gate.vertices.forEach((point) => includePoint(bounds, point));
    if (gate.type === "rect") {
      includePoint(bounds, [gate.xMin, gate.yMin]);
      includePoint(bounds, [gate.xMin, gate.yMax]);
      includePoint(bounds, [gate.xMax, gate.yMin]);
      includePoint(bounds, [gate.xMax, gate.yMax]);
    }
  });
  return normalizeBounds(bounds, 0);
}

function visualPlotBounds(input: {
  preview: EventPreview;
  gates: WorkspaceGate[];
  scale: { x: AxisScale; y: AxisScale };
}): PlotBounds {
  const bounds: PlotBounds = {
    xMin: Number.POSITIVE_INFINITY,
    xMax: Number.NEGATIVE_INFINITY,
    yMin: Number.POSITIVE_INFINITY,
    yMax: Number.NEGATIVE_INFINITY,
  };
  input.preview.points?.forEach((point) => includePoint(bounds, transformPoint(point, input.scale)));
  if (input.preview.bins) {
    [
      [input.preview.bins.xMin, input.preview.bins.yMin],
      [input.preview.bins.xMin, input.preview.bins.yMax],
      [input.preview.bins.xMax, input.preview.bins.yMin],
      [input.preview.bins.xMax, input.preview.bins.yMax],
    ].forEach((point) => includePoint(bounds, transformPoint(point as [number, number], input.scale)));
  }
  input.gates.forEach((gate) => {
    if (gate.type === "polygon") {
      gate.vertices.forEach((point) => includePoint(bounds, transformPoint(point, input.scale)));
    }
    if (gate.type === "rect") {
      [
        [gate.xMin, gate.yMin],
        [gate.xMin, gate.yMax],
        [gate.xMax, gate.yMin],
        [gate.xMax, gate.yMax],
      ].forEach((point) => includePoint(bounds, transformPoint(point as [number, number], input.scale)));
    }
  });
  return normalizeBounds(bounds);
}

function activeGates(workspace: FlowcytoWorkspace, input: { sampleId: string; parent: string; x: string; y: string }): WorkspaceGate[] {
  return workspace.gates.filter((gate) => {
    if (gate.sample !== input.sampleId || gate.parent !== input.parent) return false;
    if (gate.type === "polygon" || gate.type === "rect") return gate.x === input.x && gate.y === input.y;
    return gate.x === input.x;
  });
}

function compactContextMetadata(metadata: SampleMetadata) {
  return {
    sampleId: metadata.sampleId,
    path: metadata.path,
    eventCount: metadata.eventCount,
    parameters: metadata.parameters,
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

function recommendedGateContract(input: { sampleId: string; parent: string; x: string; y: string }) {
  return {
    id: "agent_main_population_gate",
    name: "Agent Main Population Gate",
    type: "polygon",
    writeTool: "upsert_gate",
    reason: "FSC/SSC main-population gates are usually non-rectangular; polygon is the default unless the user explicitly requests another shape.",
    geometrySource: "preview_or_bins_from_get_plot_context",
    geometryInstructions: [
      "Use the preview.points or preview.bins returned by get_plot_context to choose vertices.",
      "Do not read the FCS file directly or create local plots for gate geometry.",
      "Fill gateTemplate.vertices with at least three [x, y] pairs, then call nextAction.tool.",
    ],
    requiredFields: [
      "id",
      "name",
      "sample",
      "parent",
      "type",
      "x",
      "y",
      "vertices",
    ],
    gateTemplate: {
      id: "agent_main_population_gate",
      name: "Agent Main Population Gate",
      sample: input.sampleId,
      parent: input.parent,
      type: "polygon",
      x: input.x,
      y: input.y,
      vertices: [],
    },
  };
}

export async function getRenderablePlotContext(options: PlotContextOptions): Promise<RenderablePlotContext> {
  const workspace = await readWorkspace(options.workspacePath);
  const sampleId = chooseSample(workspace, options.sampleId);
  const metadata = await getSampleMetadata(options.workspacePath, sampleId);
  const view = workspace.views.find((entry) => entry.sample === sampleId);
  const parent = options.parent ?? view?.parent ?? "root";
  const axes = recommendedAxes(metadata);
  const x = options.x ?? view?.x ?? axes.x;
  const y = options.y ?? view?.y ?? axes.y;
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
    compensationId: options.compensationId,
  });
  const validation = await validateWorkspace(options.workspacePath);
  // These are drawable overlays for the current plot. The full hierarchy remains in workspace.gates.
  const gates = activeGates(workspace, { sampleId, parent, x, y });
  const recommendedGate = recommendedGateContract({ sampleId, parent, x, y });
  const scale = view?.scale ?? preview.scale;
  return {
    ok: true,
    workspacePath: options.workspacePath,
    revision: workspace.revision,
    workspace,
    validation,
    sampleId,
    viewId: view?.id,
    parent,
    x,
    y,
    xLabel: x,
    yLabel: y,
    scale,
    bounds: plotBounds(preview, gates),
    visualBounds: visualPlotBounds({ preview, gates, scale }),
    metadata: compactContextMetadata(metadata),
    preview,
    previewSummary: {
      format: preview.format,
      totalEvents: preview.totalEvents,
      filteredEvents: preview.filteredEvents,
      sampledEvents: preview.sampledEvents,
      pointCount: preview.points?.length ?? 0,
      binWidth: preview.bins?.width,
      binHeight: preview.bins?.height,
      compensation: preview.compensation,
    },
    gates,
    gateSchema: {
      preferredTypes: ["polygon", "rect", "range"],
      requiredRevisionField: "expected_revision",
    },
    expected_revision: workspace.revision,
    recommendedGate,
    agentContract: flowcytoAgentContract({
      preferredGateType: "polygon",
      writeTool: "upsert_gate",
    }),
    nextAction: {
      tool: "upsert_gate",
      arguments: {
        workspace_path: options.workspacePath,
        expected_revision: workspace.revision,
        gateTemplate: recommendedGate.gateTemplate as WorkspaceGate,
      },
    },
  };
}

export async function getPlotContext(options: PlotContextOptions): Promise<unknown> {
  return getRenderablePlotContext(options);
}

export async function getGateEditorState(options: GateEditorStateOptions): Promise<unknown> {
  return getPlotContext(options);
}

async function statePayload(options: GateEditorServerOptions, url: URL): Promise<unknown> {
  return getPlotContext({
    workspacePath: options.workspacePath,
    sampleId: stringParam(url, "sample_id") ?? options.sampleId,
    parent: stringParam(url, "parent"),
    x: stringParam(url, "x") ?? options.x,
    y: stringParam(url, "y") ?? options.y,
    maxEvents: numberParam(url, "max_events") ?? options.maxEvents,
    format: formatParam(url),
    binWidth: numberParam(url, "bin_width"),
    binHeight: numberParam(url, "bin_height"),
    compensationId: stringParam(url, "compensation_id") ?? options.compensationId,
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
      compensationId: stringParam(url, "compensation_id") ?? options.compensationId,
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
