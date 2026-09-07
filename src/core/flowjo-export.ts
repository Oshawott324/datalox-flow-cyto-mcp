import { promises as fs } from "node:fs";
import path from "node:path";

import { XMLBuilder } from "fast-xml-parser";

import { readWorkspace, resolveSamplePath, validateWorkspace } from "./workspace.js";
import { FlowcytoError, type AxisScale, type FlowcytoSample, type FlowcytoWorkspace, type WorkspaceGate } from "./types.js";

export type ExportFlowJoWorkspaceInput = {
  workspacePath: string;
  outputPath: string;
  bundleMode?: "reference_only";
  compensationId?: string;
};

export type ExportFlowJoWorkspaceResult = {
  ok: true;
  wspPath: string;
  bundlePath: null;
  samplesExported: number;
  gatesExported: number;
  compensationExported: boolean;
  warnings: string[];
};

type XmlElement = Record<string, unknown>;

type ExportTransform =
  | { kind: "log"; t: number; m: number }
  | { kind: "fasinh"; t: number; m: number; a: number; length: number };

type ExportTransformContext = {
  transformsByChannel: Map<string, ExportTransform>;
};

const FLOWCYTO_LOG_T = 10;
const FLOWCYTO_LOG_M = 1;
const FLOWCYTO_ARCSINH_M = 1 / Math.LN10;
const FLOWCYTO_ARCSINH_A = 0;
const FLOWCYTO_ARCSINH_LENGTH = 1;
const FLOWCYTO_ARCSINH_T = 150 * Math.sinh(1);

function sampleName(sample: FlowcytoSample): string {
  return path.basename(sample.path) || sample.id;
}

function fileUri(filePath: string): string {
  const normalized = path.resolve(filePath).replaceAll("\\", "/");
  if (/^[A-Za-z]:\//.test(normalized)) return `file:///${encodeURI(normalized).replaceAll("%2F", "/")}`;
  return `file://${encodeURI(normalized).replaceAll("%2F", "/")}`;
}

function gateName(gate: WorkspaceGate): string {
  return gate.name || gate.id;
}

function flowJoTransformForScale(scale: AxisScale): ExportTransform | null {
  if (scale === "log") return { kind: "log", t: FLOWCYTO_LOG_T, m: FLOWCYTO_LOG_M };
  if (scale === "arcsinh") {
    return {
      kind: "fasinh",
      t: FLOWCYTO_ARCSINH_T,
      m: FLOWCYTO_ARCSINH_M,
      a: FLOWCYTO_ARCSINH_A,
      length: FLOWCYTO_ARCSINH_LENGTH,
    };
  }
  return null;
}

function addChannelScale(scales: Map<string, AxisScale>, channel: string, scale: AxisScale): void {
  if (scale === "linear") return;
  const existing = scales.get(channel);
  if (existing && existing !== scale) {
    throw new FlowcytoError("ambiguous_flowjo_transform", `Channel ${channel} has conflicting view scales: ${existing} and ${scale}.`, "/views");
  }
  scales.set(channel, scale);
}

function gateChannels(gate: WorkspaceGate): string[] {
  if (gate.type === "range") return [gate.x];
  return [gate.x, gate.y];
}

function buildTransformContext(workspace: FlowcytoWorkspace): ExportTransformContext {
  const channelScales = new Map<string, AxisScale>();
  for (const view of workspace.views) {
    addChannelScale(channelScales, view.x, view.scale.x);
    addChannelScale(channelScales, view.y, view.scale.y);
  }

  const exportedGateChannels = new Set(workspace.gates.flatMap(gateChannels));
  const transformsByChannel = new Map<string, ExportTransform>();
  for (const channel of exportedGateChannels) {
    const scale = channelScales.get(channel);
    if (!scale || scale === "linear") continue;
    if (scale === "biex") {
      throw new FlowcytoError(
        "unsupported_flowjo_biex_export",
        `FlowJo biex export for channel ${channel} is not implemented. Export would misposition gates without the FlowJo spline transform.`,
        "/views",
      );
    }
    const transform = flowJoTransformForScale(scale);
    if (transform) transformsByChannel.set(channel, transform);
  }
  return { transformsByChannel };
}

function exportCoordinate(value: number, channel: string, context: ExportTransformContext): number {
  const transform = context.transformsByChannel.get(channel);
  if (!transform) return value;
  if (transform.kind === "log") return (Math.log10(value / transform.t) / transform.m) + 1;
  return transform.length
    * (Math.asinh(value * Math.sinh(transform.m * Math.LN10) / transform.t) + (transform.a * Math.LN10))
    / ((transform.m + transform.a) * Math.LN10);
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new FlowcytoError("invalid_flowjo_export_coordinate", "FlowJo export produced a non-finite gate coordinate.", "/gates");
  }
  return String(value);
}

function transformStore(context: ExportTransformContext): XmlElement | null {
  const transforms: XmlElement = {};
  for (const [channel, transform] of Array.from(context.transformsByChannel.entries()).sort(([left], [right]) => left.localeCompare(right))) {
    const key = transform.kind === "log" ? "transforms:log" : "transforms:fasinh";
    const entry = transform.kind === "log"
      ? {
        "@_transforms:T": String(transform.t),
        "@_transforms:M": String(transform.m),
        "data-type:parameter": { "@_data-type:name": channel },
      }
      : {
        "@_transforms:T": String(transform.t),
        "@_transforms:M": String(transform.m),
        "@_transforms:A": String(transform.a),
        "@_transforms:length": String(transform.length),
        "data-type:parameter": { "@_data-type:name": channel },
      };
    const current = transforms[key];
    transforms[key] = current === undefined ? entry : [...(Array.isArray(current) ? current : [current]), entry];
  }
  if (Object.keys(transforms).length === 0) return null;
  return {
    Cytometer: {
      "@_name": "Flowcyto",
      "@_linearRescale": "1",
      TransformStore: {
        MatrixID: {
          "@_matrixId": "uncompensated",
          Transforms: transforms,
        },
      },
    },
  };
}

function dimension(context: ExportTransformContext, parameterName: string, min?: number, max?: number): XmlElement {
  return {
    "@_gating:compensation-ref": "uncompensated",
    ...(min !== undefined ? { "@_gating:min": formatNumber(exportCoordinate(min, parameterName, context)) } : {}),
    ...(max !== undefined ? { "@_gating:max": formatNumber(exportCoordinate(max, parameterName, context)) } : {}),
    "data-type:parameter": { "@_data-type:name": parameterName },
  };
}

function gateBody(gate: WorkspaceGate, context: ExportTransformContext): XmlElement {
  if (gate.type === "polygon") {
    return {
      "gating:PolygonGate": {
        "@_gating:id": gate.id,
        "@_gating:parent_id": gate.parent === "root" ? "" : gate.parent,
        "gating:dimension": [dimension(context, gate.x), dimension(context, gate.y)],
        "gating:vertex": gate.vertices.map((vertex) => ({
          "gating:coordinate": [
            { "@_data-type:value": formatNumber(exportCoordinate(vertex[0], gate.x, context)) },
            { "@_data-type:value": formatNumber(exportCoordinate(vertex[1], gate.y, context)) },
          ],
        })),
      },
    };
  }
  if (gate.type === "rect") {
    return {
      "gating:RectangleGate": {
        "@_gating:id": gate.id,
        "@_gating:parent_id": gate.parent === "root" ? "" : gate.parent,
        "gating:dimension": [
          dimension(context, gate.x, gate.xMin, gate.xMax),
          dimension(context, gate.y, gate.yMin, gate.yMax),
        ],
      },
    };
  }
  return {
    "gating:RangeGate": {
      "@_gating:id": gate.id,
      "@_gating:parent_id": gate.parent === "root" ? "" : gate.parent,
      "gating:dimension": dimension(context, gate.x, gate.min, gate.max),
    },
  };
}

function buildGateTree(gates: WorkspaceGate[], parent: string, context: ExportTransformContext): XmlElement[] {
  return gates
    .filter((gate) => gate.parent === parent)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((gate) => ({
      "@_name": gateName(gate),
      "@_owningGroup": "",
      "@_gating:id": gate.id,
      "@_gating:parent_id": gate.parent === "root" ? "" : gate.parent,
      ...gateBody(gate, context),
      Subpopulations: {
        Gate: buildGateTree(gates, gate.id, context),
      },
    }));
}

function sampleElement(workspacePath: string, workspace: FlowcytoWorkspace, sample: FlowcytoSample, context: ExportTransformContext): XmlElement {
  const gates = workspace.gates.filter((gate) => gate.sample === sample.id);
  const rootGates = buildGateTree(gates, "root", context);
  return {
    DataSet: {
      "@_uri": fileUri(resolveSamplePath(workspacePath, sample.path)),
      "@_keyword": "$CYT",
    },
    SampleNode: {
      "@_name": sampleName(sample),
      "@_owningGroup": "",
      Subpopulations: {
        Gate: rootGates,
      },
    },
  };
}

function buildFlowJoXml(workspacePath: string, workspace: FlowcytoWorkspace): string {
  const context = buildTransformContext(workspace);
  const cytometers = transformStore(context);
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    format: true,
    suppressEmptyNode: true,
  });
  const document = {
    "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" },
    Workspace: {
      "@_version": "20.0",
      "@_creator": "Flowcyto",
      "@_xmlns:gating": "http://www.isac-net.org/std/Gating-ML/v2.0/gating",
      "@_xmlns:data-type": "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes",
      "@_xmlns:transforms": "http://www.isac-net.org/std/Gating-ML/v2.0/transformations",
      ...(cytometers ? { Cytometers: cytometers } : {}),
      SampleList: {
        Sample: workspace.samples.map((sample) => sampleElement(workspacePath, workspace, sample, context)),
      },
    },
  };
  return `${builder.build(document)}\n`;
}

export async function exportFlowJoWorkspace(input: ExportFlowJoWorkspaceInput): Promise<ExportFlowJoWorkspaceResult> {
  if (input.bundleMode && input.bundleMode !== "reference_only") {
    throw new FlowcytoError("unsupported_flowjo_bundle_mode", "Only reference_only FlowJo export is implemented.", "/bundle_mode");
  }
  const workspacePath = path.resolve(input.workspacePath);
  const outputPath = path.resolve(input.outputPath);
  const validation = await validateWorkspace(workspacePath);
  if (!validation.ok) {
    const first = validation.errors[0];
    throw new FlowcytoError(first?.code ?? "invalid_workspace", first?.message ?? "Workspace is invalid.", first?.path);
  }
  const workspace = await readWorkspace(workspacePath);
  if (input.compensationId && !workspace.compensations?.some((matrix) => matrix.id === input.compensationId)) {
    throw new FlowcytoError("unknown_compensation", `Compensation ${input.compensationId} is not present.`, "/compensation_id");
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, buildFlowJoXml(workspacePath, workspace), "utf8");
  return {
    ok: true,
    wspPath: outputPath,
    bundlePath: null,
    samplesExported: workspace.samples.length,
    gatesExported: workspace.gates.length,
    compensationExported: false,
    warnings: input.compensationId ? ["Compensation matrix export is not implemented in this initial FlowJo export path."] : [],
  };
}
