#!/usr/bin/env node
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
import { renderPlotImage } from "../app/gate-editor/plot-image.js";
import { GATE_EDITOR_HTML } from "../app/gate-editor/ui.js";
import { getGateEditorState, getPlotContext, recommendedAxes, startGateEditorServer, type GateEditorServer } from "../app/gate-editor/server.js";
import {
  FlowcytoError,
  deleteGate,
  getEventPreview,
  getSampleMetadata,
  listSamples,
  openFcsArtifact,
  openWorkspace,
  readWorkspace,
  upsertGate,
  validateWorkspace,
  writeWorkspace,
  type FlowcytoWorkspace,
  type WorkspaceGate,
} from "../core/index.js";

const GATE_EDITOR_RESOURCE_URI = "ui://flowcyto/gate-editor-v1.html";
const CAPABILITIES_RESOURCE_URI = "flowcyto://capabilities";
const OPEN_FCS_WORKFLOW_RESOURCE_URI = "flowcyto://workflow/open-fcs-and-gate";
const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

const JsonObject = z.record(z.string(), z.unknown());
const JsonResultSchema = {
  result: z.unknown(),
};
const GateEditorSurfaceSchema = z.enum(["auto", "mcp_app", "native_window"]);
const OpenFcsSurfaceSchema = z.enum(["auto", "mcp_app", "native_window", "none"]);
const GateEditorMcpAppMeta = {
  ui: {
    resourceUri: GATE_EDITOR_RESOURCE_URI,
    visibility: ["model", "app"],
  },
  "openai/outputTemplate": GATE_EDITOR_RESOURCE_URI,
  "openai/widgetAccessible": true,
};
const WidgetAccessibleToolMeta = {
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
  compensationId?: string;
};

const FlowcytoCapabilities = {
  supportsFileTypes: [".fcs", "flowcyto.workspace.json"],
  canParseMetadata: true,
  canRenderPlots: true,
  canRenderPlotImages: true,
  canOpenCompactApp: true,
  canWriteStructuredGates: true,
  liveRefreshAfterUpsertGate: true,
  canonicalArtifact: "flowcyto.workspace.json",
  primaryTools: ["open_fcs", "list_compensations", "get_compensation_matrix", "render_plot", "render_plot_image", "open_gate_editor", "get_plot_context", "upsert_gate"],
  preferredWorkflowResource: OPEN_FCS_WORKFLOW_RESOURCE_URI,
  compactGateEditor: {
    entryTool: "open_gate_editor",
    requiredFor: ["gate", "draw", "edit", "inspect_population"],
    defaultSurfaceForAgentHosts: "native_window",
    surfaceForMcpAppsHosts: "mcp_app",
    liveRefresh: "upsert_gate increments the workspace revision and the already-open compact app refreshes by polling.",
  },
};

const OpenFcsAndGateWorkflow = {
  orderedTools: [
    "open_fcs",
    "open_gate_editor",
    "get_plot_context",
    "upsert_gate",
    "get_workspace_revision",
  ],
  notes: [
    "Call open_fcs when the user asks to open, inspect, render, analyze, or gate an .fcs file.",
    "Do not stop after open_fcs for gating or population inspection; follow result.nextAction immediately.",
    "By default open_fcs returns open_gate_editor(surface=native_window) so non-UI agent hosts open a compact gate editor without another user request.",
    "Use render_plot or get_plot_context results for gate geometry.",
    "Write gates through upsert_gate with expected_revision.",
    "Do not patch flowcyto.workspace.json directly when upsert_gate is available.",
    "AGENTS.md is optional convenience guidance, not the product contract.",
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultContent(result: unknown, meta?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ result }, null, 2) }],
    structuredContent: { result },
    ...(meta ? { _meta: meta } : {}),
  };
}

function imageResultContent(params: {
  result: unknown;
  mimeType: string;
  data: string;
  meta?: Record<string, unknown>;
}) {
  return {
    content: [
      { type: "image" as const, mimeType: params.mimeType, data: params.data },
      { type: "text" as const, text: JSON.stringify({ result: params.result }, null, 2) },
    ],
    structuredContent: { result: params.result },
    ...(params.meta ? { _meta: params.meta } : {}),
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
      "do_not_attempt_compensation_estimation_without_mcp_tools",
      "do_not_run_local_python_for_compensation",
    ],
    ...extra,
  };
}

function plotContextNextAction(selection: GateEditorSelection) {
  const args: Record<string, unknown> = {
    workspace_path: selection.workspacePath,
    sample_id: selection.sampleId,
    parent_gate_id: selection.parent,
    x: selection.x,
    y: selection.y,
    max_events: selection.maxEvents,
    format: "bins",
    bin_width: 64,
    bin_height: 64,
  };
  if (selection.compensationId) args.compensation_id = selection.compensationId;
  return {
    tool: "get_plot_context",
    arguments: args,
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

function firstRecommendedView(result: Awaited<ReturnType<typeof openFcsArtifact>>) {
  const view = result.recommendedViews[0];
  return {
    x: view?.x ?? result.channels[0]?.name,
    y: view?.y ?? result.channels[1]?.name,
  };
}

function openFcsNextAction(result: Awaited<ReturnType<typeof openFcsArtifact>>, surface: "auto" | "mcp_app" | "native_window" | "none") {
  const view = firstRecommendedView(result);
  if (surface === "none") {
    const args: Record<string, unknown> = {
      workspace_path: result.workspacePath,
      sample_id: result.sampleId,
      x: view.x,
      y: view.y,
      parent_gate_id: "root",
      format: "bins",
      bin_width: 64,
      bin_height: 64,
    };
    return {
      tool: "render_plot",
      required: false,
      reason: "surface=none requested the render-only path instead of opening the compact gate editor.",
      arguments: args,
    };
  }
  const args: Record<string, unknown> = {
    workspace_path: result.workspacePath,
    sample_id: result.sampleId,
    x: view.x,
    y: view.y,
    surface,
  };
  return {
    tool: "open_gate_editor",
    required: true,
    reason: "Opening the compact gate editor is part of the FCS gating and population inspection workflow.",
    requiredFor: ["gate", "draw", "edit", "inspect_population"],
    liveRefresh: "The opened compact gate editor refreshes when upsert_gate updates the workspace revision.",
    arguments: args,
  };
}

function openFcsGateEditorPolicy(surface: "auto" | "mcp_app" | "native_window" | "none") {
  return {
    compactGateEditorRequired: surface !== "none",
    requestedSurface: surface,
    openTool: "open_gate_editor",
    defaultSurfaceForAgentHosts: "native_window",
    surfaceForMcpAppsHosts: "mcp_app",
    requiredFor: ["gate", "draw", "edit", "inspect_population"],
    reason: surface === "none"
      ? "surface=none is the explicit render-only path."
      : "Agents should open the compact gate editor before drawing or editing gates so user-visible state updates live.",
  };
}

function promptText(title: string, lines: string[]): string {
  return [
    `# ${title}`,
    "",
    ...lines,
  ].join("\n");
}

function workflowPrompt(pathPlaceholder: string): string {
  return promptText("Open FCS And Gate Main Population", [
    `Use Flowcyto MCP tools for ${pathPlaceholder}.`,
    "",
    "Tool order:",
    "1. open_fcs with path set to the .fcs file or flowcyto.workspace.json.",
    "2. Follow open_fcs result.nextAction immediately. For fresh non-UI agent hosts this opens open_gate_editor(surface=\"native_window\").",
    "3. get_plot_context with result.nextAction.arguments from open_gate_editor.",
    "4. upsert_gate with expected_revision from get_plot_context.",
    "5. get_workspace_revision to confirm the already-open compact app can refresh.",
    "",
    "Do not stop after open_fcs when the user asked to inspect, gate, draw, or edit a population.",
    "Do not patch flowcyto.workspace.json directly when upsert_gate is available.",
    "Do not infer gate geometry from screenshots when render_plot/get_plot_context returns preview data.",
    "AGENTS.md is optional convenience guidance, not required product behavior.",
  ]);
}

function renderPlotPrompt(pathPlaceholder: string): string {
  return promptText("Render FCS Plot", [
    `Use Flowcyto MCP tools for ${pathPlaceholder}.`,
    "",
    "Tool order:",
    "1. open_fcs if the input is a raw .fcs file.",
    "2. render_plot with workspace_path, sample_id, x, y, and format=\"bins\" unless raw points are explicitly needed.",
    "3. Use the returned preview, bounds, gates, recommendedGate, and nextAction for follow-up gating.",
    "",
    "Do not create local Python plots or inspect local preview URLs for gate geometry.",
  ]);
}

function reviewWorkspacePrompt(pathPlaceholder: string): string {
  return promptText("Review Workspace Gates", [
    `Use Flowcyto MCP tools for ${pathPlaceholder}.`,
    "",
    "Tool order:",
    "1. open_fcs with the workspace path.",
    "2. render_plot or get_plot_context for each relevant sample/view.",
    "3. read_workspace only for reviewing canonical gate JSON after tool-based context is available.",
    "",
    "Do not modify gates unless the user asks for a write; if writing, use upsert_gate with expected_revision.",
  ]);
}

async function resolveGateEditorSelection(params: {
  workspacePath: string;
  sampleId?: string;
  parent?: string;
  x?: string;
  y?: string;
  maxEvents?: number;
  compensationId?: string;
}): Promise<GateEditorSelection> {
  const workspace = await readWorkspace(params.workspacePath);
  const sampleId = params.sampleId ?? workspace.samples[0]?.id;
  if (!sampleId) {
    throw new FlowcytoError("missing_sample", "Workspace must contain at least one sample.", "/samples");
  }
  const metadata = await getSampleMetadata(params.workspacePath, sampleId);
  const view = workspace.views.find((entry) => entry.sample === sampleId);
  const axes = recommendedAxes(metadata);
  const x = params.x ?? view?.x ?? axes.x;
  const y = params.y ?? view?.y ?? axes.y;
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
    ...(params.compensationId ? { compensationId: params.compensationId } : {}),
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
  compensationId?: string;
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
  compensationId?: string;
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
    ...(params.compensationId ? { compensationId: params.compensationId } : {}),
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
      compensationId: params.selection.compensationId,
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
    compensationId?: string;
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
    compensationId: params.compensationId,
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
        compensationId: params.selection.compensationId,
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
    version: "0.1.4",
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

server.registerResource(
  "flowcyto_capabilities",
  CAPABILITIES_RESOURCE_URI,
  {
    title: "Flowcyto Capabilities",
    description: "Machine-readable Flowcyto MCP file, rendering, compact app, and gate-writing capabilities.",
    mimeType: "application/json",
  },
  async () => ({
    contents: [{
      uri: CAPABILITIES_RESOURCE_URI,
      mimeType: "application/json",
      text: JSON.stringify(FlowcytoCapabilities, null, 2),
    }],
  }),
);

server.registerResource(
  "flowcyto_open_fcs_and_gate_workflow",
  OPEN_FCS_WORKFLOW_RESOURCE_URI,
  {
    title: "Flowcyto Open FCS And Gate Workflow",
    description: "Ordered MCP tool workflow for opening an FCS file, rendering a plot, and writing a revision-safe gate.",
    mimeType: "application/json",
  },
  async () => ({
    contents: [{
      uri: OPEN_FCS_WORKFLOW_RESOURCE_URI,
      mimeType: "application/json",
      text: JSON.stringify(OpenFcsAndGateWorkflow, null, 2),
    }],
  }),
);

server.registerPrompt(
  "open-fcs-and-gate-main-population",
  {
    title: "Open FCS And Gate Main Population",
    description: "Use Flowcyto MCP tools to open an .fcs/workspace, render the main population, and write a revision-safe gate.",
    argsSchema: { path: z.string().optional() },
  },
  ({ path }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: workflowPrompt(path ?? "the user-provided .fcs or workspace"),
      },
    }],
  }),
);

server.registerPrompt(
  "render-fcs-plot",
  {
    title: "Render FCS Plot",
    description: "Use Flowcyto MCP tools to render FSC/SSC or marker plot data without local plotting scripts.",
    argsSchema: { path: z.string().optional() },
  },
  ({ path }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: renderPlotPrompt(path ?? "the user-provided .fcs or workspace"),
      },
    }],
  }),
);

server.registerPrompt(
  "review-workspace-gates",
  {
    title: "Review Workspace Gates",
    description: "Use Flowcyto MCP tools to inspect a workspace and review gates without direct JSON patching.",
    argsSchema: { path: z.string().optional() },
  },
  ({ path }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: reviewWorkspacePrompt(path ?? "the user-provided flowcyto.workspace.json"),
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
  "open_fcs",
  {
    description: "Open an .fcs file or flowcyto.workspace.json workspace, create or reuse a Flowcyto workspace, parse FCS metadata, and return the required nextAction. Use this when the user asks to open, inspect, render, analyze, or gate an FCS file. For gating or population inspection, follow nextAction immediately so the compact gate editor opens; omit surface in fresh CLI agents to use native_window, pass surface=mcp_app in MCP Apps hosts, or surface=none only for render-only automation.",
    inputSchema: {
      path: z.string(),
      workspace_dir: z.string().optional(),
      sample_id: z.string().optional(),
      surface: OpenFcsSurfaceSchema.optional(),
    },
    outputSchema: JsonResultSchema,
    annotations: { readOnlyHint: false },
  },
  async ({ path, workspace_dir, sample_id, surface }) => toolContent(async () => {
    const result = await openFcsArtifact({
      path,
      workspaceDir: workspace_dir,
      sampleId: sample_id,
    });
    const selectedSurface = surface ?? "native_window";
    return {
      ...result,
      agentContract: flowcytoAgentContract({
        discovery: "open_fcs_is_the_entry_tool_for_raw_fcs_or_workspace_inputs",
        gateEditor: "follow_nextAction_to_open_compact_gate_editor_before_gate_writes",
      }),
      gateEditorPolicy: openFcsGateEditorPolicy(selectedSurface),
      nextAction: openFcsNextAction(result, selectedSurface),
    };
  }),
);

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
  "list_compensations",
  {
    description: "List stored conventional compensation matrices discovered from FCS keywords or workspace metadata. This does not apply compensation; pass a returned compensation_id to get_plot_context/render_plot/render_plot_image/open_gate_editor explicitly.",
    inputSchema: {
      workspace_path: z.string(),
      sample_id: z.string().optional(),
    },
    outputSchema: JsonResultSchema,
    annotations: { readOnlyHint: true },
  },
  async ({ workspace_path, sample_id }) => toolContent(async () => {
    const workspace = await readWorkspace(workspace_path);
    const compensations = (workspace.compensations ?? [])
      .filter((matrix) => !sample_id || matrix.sample === sample_id || matrix.sample === undefined)
      .map((matrix) => ({
        id: matrix.id,
        name: matrix.name,
        source: matrix.source,
        sample: matrix.sample,
        keyword: matrix.keyword,
        channels: matrix.channels,
        size: matrix.channels.length,
      }));
    return {
      ok: true,
      workspacePath: workspace_path,
      sampleId: sample_id,
      count: compensations.length,
      compensations,
      compensationStatus: sample_id ? workspace.compensationStatus?.[sample_id] : workspace.compensationStatus,
      nextAction: compensations.length === 1
        ? {
          tool: "get_compensation_matrix",
          arguments: { workspace_path, compensation_id: compensations[0].id },
        }
        : null,
    };
  }),
);

server.registerTool(
  "get_compensation_matrix",
  {
    description: "Inspect a stored conventional spillover compensation matrix. Matrix orientation is detector rows by fluorochrome columns; applying requires passing this compensation_id to preview/render tools.",
    inputSchema: {
      workspace_path: z.string(),
      compensation_id: z.string(),
    },
    outputSchema: JsonResultSchema,
    annotations: { readOnlyHint: true },
  },
  async ({ workspace_path, compensation_id }) => toolContent(async () => {
    const workspace = await readWorkspace(workspace_path);
    const matrix = (workspace.compensations ?? []).find((entry) => entry.id === compensation_id);
    if (!matrix) {
      throw new FlowcytoError("unknown_compensation", `Compensation ${compensation_id} is not present.`, "/compensation_id");
    }
    return {
      ok: true,
      workspacePath: workspace_path,
      compensation: matrix,
      orientation: "matrix[i][j] = fraction of fluorochrome j spilling into detector i; apply as Xcomp = Xraw @ inv(S), implemented by solve(S.T, Xraw.T).T.",
      nextAction: {
        tool: "render_plot",
        arguments: {
          workspace_path,
          sample_id: matrix.sample,
          compensation_id,
        },
      },
    };
  }),
);

server.registerTool(
  "get_event_preview",
  {
    description: "Lower-level preview primitive for two sample channels. Prefer render_plot when the user asks to show, render, plot, inspect, or compare FSC/SSC or marker channels. Use this MCP result instead of reading FCS files with local Python or plotting scripts.",
    inputSchema: {
      workspace_path: z.string(),
      sample_id: z.string(),
      x: z.string(),
      y: z.string(),
      parent_gate_id: z.string().optional(),
      max_events: z.number().int().positive().optional(),
      compensation_id: z.string().optional(),
      format: z.enum(["auto", "points", "bins"]).optional(),
      bin_width: z.number().int().positive().optional(),
      bin_height: z.number().int().positive().optional(),
    },
    outputSchema: JsonResultSchema,
  },
  async ({ workspace_path, sample_id, x, y, parent_gate_id, max_events, compensation_id, format, bin_width, bin_height }) => toolContent(() =>
    getEventPreview({
      workspacePath: workspace_path,
      sampleId: sample_id,
      x,
      y,
      parent: parent_gate_id,
      maxEvents: max_events,
      compensationId: compensation_id,
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
          compensation_id,
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
    description: "Return revision, axes, bounds, preview, and recommended gate-write contract for the active gate editor view. Call this before upsert_gate. Use render_plot for user-intent plotting and this tool for active editor context. Use the returned preview/bins for gate geometry; do not read FCS files with local scripts.",
    inputSchema: {
      workspace_path: z.string(),
      sample_id: z.string().optional(),
      parent_gate_id: z.string().optional(),
      x: z.string().optional(),
      y: z.string().optional(),
      max_events: z.number().int().positive().optional(),
      compensation_id: z.string().optional(),
      format: z.enum(["auto", "points", "bins"]).optional(),
      bin_width: z.number().int().positive().optional(),
      bin_height: z.number().int().positive().optional(),
    },
    outputSchema: JsonResultSchema,
    _meta: WidgetAccessibleToolMeta,
  },
  async ({ workspace_path, sample_id, parent_gate_id, x, y, max_events, compensation_id, format, bin_width, bin_height }) => toolContent(() =>
    getPlotContext({
      workspacePath: workspace_path,
      sampleId: sample_id,
      parent: parent_gate_id,
      x,
      y,
      maxEvents: max_events,
      compensationId: compensation_id,
      format,
      binWidth: bin_width,
      binHeight: bin_height,
    }),
  ),
);

server.registerTool(
  "render_plot",
  {
    description: "Return renderable flow cytometry plot data for FSC/SSC or marker channels. Use this when the user asks to show, render, plot, inspect, or compare cytometry channels. This wraps the same point/bin preview contract as the compact app and returns the next gate-writing action.",
    inputSchema: {
      workspace_path: z.string(),
      sample_id: z.string().optional(),
      parent_gate_id: z.string().optional(),
      x: z.string().optional(),
      y: z.string().optional(),
      max_events: z.number().int().positive().optional(),
      compensation_id: z.string().optional(),
      format: z.enum(["auto", "points", "bins"]).optional(),
      bin_width: z.number().int().positive().optional(),
      bin_height: z.number().int().positive().optional(),
    },
    outputSchema: JsonResultSchema,
    annotations: { readOnlyHint: true },
  },
  async ({ workspace_path, sample_id, parent_gate_id, x, y, max_events, compensation_id, format, bin_width, bin_height }) => toolContent(async () => {
    const context = await getPlotContext({
      workspacePath: workspace_path,
      sampleId: sample_id,
      parent: parent_gate_id,
      x,
      y,
      maxEvents: max_events,
      compensationId: compensation_id,
      format,
      binWidth: bin_width,
      binHeight: bin_height,
    });
    if (!isRecord(context)) return context;
    const recommendedGate = isRecord(context.recommendedGate)
      ? {
        ...context.recommendedGate,
        geometrySource: "preview_or_bins_from_render_plot",
      }
      : context.recommendedGate;
    return {
      ...context,
      renderIntent: "plot",
      recommendedGate,
      agentContract: flowcytoAgentContract({
        geometrySource: "preview_or_bins_from_render_plot",
        writeTool: "upsert_gate",
      }),
    };
  }),
);

server.registerTool(
  "render_plot_image",
  {
    description: "Return a deterministic human-visible flow cytometry plot image for inline display. This uses the same preview/bins and gate context as render_plot; use render_plot for agent-readable geometry and render_plot_image when the user asks to show or display the graph inline.",
    inputSchema: {
      workspace_path: z.string(),
      sample_id: z.string().optional(),
      parent_gate_id: z.string().optional(),
      x: z.string().optional(),
      y: z.string().optional(),
      max_events: z.number().int().positive().optional(),
      compensation_id: z.string().optional(),
      format: z.enum(["auto", "points", "bins"]).optional(),
      bin_width: z.number().int().positive().optional(),
      bin_height: z.number().int().positive().optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      image_format: z.enum(["svg"]).optional(),
      output: z.enum(["content", "file", "both"]).optional(),
      output_path: z.string().optional(),
    },
    outputSchema: JsonResultSchema,
    annotations: { readOnlyHint: true },
  },
  async ({ workspace_path, sample_id, parent_gate_id, x, y, max_events, compensation_id, format, bin_width, bin_height, width, height, image_format, output, output_path }) => {
    try {
      if (image_format && image_format !== "svg") {
        throw new FlowcytoError("unsupported_image_format", "render_plot_image currently supports image_format=svg.", "/image_format");
      }
      const result = await renderPlotImage({
        workspacePath: workspace_path,
        sampleId: sample_id,
        parent: parent_gate_id,
        x,
        y,
        maxEvents: max_events,
        compensationId: compensation_id,
        format,
        binWidth: bin_width,
        binHeight: bin_height,
        width,
        height,
        imageFormat: image_format,
        output,
        outputPath: output_path,
      });
      const { svg: _svg, ...image } = result.image;
      const structuredResult = {
        ...result,
        image,
        agentContract: flowcytoAgentContract({
          imageSource: "same_preview_or_bins_as_render_plot",
          dataTool: "render_plot",
        }),
      };
      if (output === "file") {
        return resultContent(structuredResult);
      }
      return imageResultContent({
        result: structuredResult,
        mimeType: result.image.mimeType,
        data: Buffer.from(result.image.svg, "utf8").toString("base64"),
      });
    } catch (error) {
      return {
        ...resultContent(errorResult(error)),
        isError: true as const,
      };
    }
  },
);

server.registerTool(
  "probe_inline_image",
  {
    description: "Diagnostic host-rendering probe. Returns one tiny SVG image and one tiny PNG image so a fresh MCP host can reveal which image MIME types it displays inline.",
    inputSchema: {},
    outputSchema: JsonResultSchema,
    annotations: { readOnlyHint: true },
  },
  async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60"><rect width="120" height="60" fill="#fff"/><circle cx="30" cy="30" r="18" fill="#1291ab"/><rect x="62" y="15" width="38" height="30" fill="#f7d03f"/><text x="60" y="55" text-anchor="middle" font-family="Arial" font-size="10" fill="#293241">svg probe</text></svg>`;
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mO88fHhfwAJ8wP/xk2IAAAAAABJRU5ErkJggg==";
    const result = {
      ok: true,
      probes: [
        { format: "svg", mimeType: "image/svg+xml", expectedInlineLabel: "svg probe" },
        { format: "png", mimeType: "image/png", expectedInlineLabel: "1x1 blue-ish PNG pixel" },
      ],
      nextDecision: "If SVG does not render inline but PNG does, make render_plot_image default to PNG via internal SVG-to-PNG rasterization.",
    };
    return {
      content: [
        { type: "image" as const, mimeType: "image/svg+xml", data: Buffer.from(svg, "utf8").toString("base64") },
        { type: "image" as const, mimeType: "image/png", data: png },
        { type: "text" as const, text: JSON.stringify({ result }, null, 2) },
      ],
      structuredContent: { result },
    };
  },
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
      compensation_id: z.string().optional(),
      format: z.enum(["auto", "points", "bins"]).optional(),
      bin_width: z.number().int().positive().optional(),
      bin_height: z.number().int().positive().optional(),
    },
    outputSchema: JsonResultSchema,
  },
  async ({ workspace_path, sample_id, parent_gate_id, x, y, max_events, compensation_id, format, bin_width, bin_height }) => toolContent(() =>
    getGateEditorState({
      workspacePath: workspace_path,
      sampleId: sample_id,
      parent: parent_gate_id,
      x,
      y,
      maxEvents: max_events,
      compensationId: compensation_id,
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
    _meta: WidgetAccessibleToolMeta,
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
    description: "Create or update a gate in the canonical workspace artifact using revision-safe writes. Use expected_revision from render_plot or get_plot_context. For FSC/SSC main-population gating, prefer polygon unless the user explicitly requests another shape. Do not patch workspace JSON directly. After this, call get_workspace_revision.",
    inputSchema: {
      workspace_path: z.string(),
      gate: JsonObject,
      expected_revision: z.number().int(),
    },
    outputSchema: JsonResultSchema,
    _meta: WidgetAccessibleToolMeta,
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
    _meta: WidgetAccessibleToolMeta,
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
      compensation_id: z.string().optional(),
    },
    outputSchema: JsonResultSchema,
    annotations: { readOnlyHint: true },
  },
  async ({ workspace_path, sample_id, parent_gate_id, x, y, max_events, compensation_id }) => toolContent(async () =>
    mcpAppGateEditorResult({
      workspacePath: workspace_path,
      selection: await resolveGateEditorSelection({
        workspacePath: workspace_path,
        sampleId: sample_id,
        parent: parent_gate_id,
        x,
        y,
        maxEvents: max_events,
        compensationId: compensation_id,
      }),
    }),
  GateEditorMcpAppMeta),
);

server.registerTool(
  "open_gate_editor",
  {
    description: "Open the compact gate editor surface for a workspace, including workspaces created by open_fcs. In CLI or non-UI agent hosts, pass surface=\"native_window\" so a compact native window opens. After this call, call get_plot_context using result.nextAction.arguments. Do not inspect local preview URLs, run local FCS analysis scripts, or write the workspace JSON directly.",
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
      compensation_id: z.string().optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
    },
    outputSchema: JsonResultSchema,
    annotations: { readOnlyHint: true },
    _meta: GateEditorMcpAppMeta,
  },
  async ({ workspace_path, surface, host, port, sample_id, parent_gate_id, x, y, max_events, compensation_id, width, height }) =>
    toolContent(async () => {
      const selection = await resolveGateEditorSelection({
        workspacePath: workspace_path,
        sampleId: sample_id,
        parent: parent_gate_id,
        x,
        y,
        maxEvents: max_events,
        compensationId: compensation_id,
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
          compensationId: selection.compensationId,
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
