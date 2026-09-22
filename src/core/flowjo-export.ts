import { promises as fs } from "node:fs";
import path from "node:path";

import { XMLBuilder } from "fast-xml-parser";

import { readFcsMetadata } from "./fcs.js";
import { readWorkspace, resolveSamplePath, validateWorkspace } from "./workspace.js";
import { FlowcytoError, type AxisScale, type FlowcytoSample, type FlowcytoWorkspace, type SampleMetadata, type WorkspaceGate } from "./types.js";

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

type ExportTransformContext = {
  parameterBySampleChannel: Map<string, string>;
  scaleBySampleParameter: Map<string, AxisScale>;
};

const FLOWCYTO_ARCSINH_M = 1 / Math.LN10;
const FLOWCYTO_ARCSINH_A = 0;
const FLOWCYTO_ARCSINH_LENGTH = 1;
const FLOWCYTO_ARCSINH_T = 150 * Math.sinh(1);

function sampleName(sample: FlowcytoSample): string {
  return path.basename(sample.path) || sample.id;
}

function fileUri(filePath: string): string {
  const normalized = path.resolve(filePath).replaceAll("\\", "/");
  if (/^[A-Za-z]:\//.test(normalized)) return `file:/${encodeURI(normalized).replaceAll("%2F", "/")}`;
  return `file://${encodeURI(normalized).replaceAll("%2F", "/")}`;
}

function gateName(gate: WorkspaceGate): string {
  return gate.name || gate.id;
}

function addChannelScale(scales: Map<string, AxisScale>, channel: string, scale: AxisScale): void {
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

function sampleChannelKey(sampleId: string, channel: string): string {
  return `${sampleId}\0${channel}`;
}

function flowJoParameter(metadata: SampleMetadata, channel: string): string {
  const parameter = metadata.parameters.find((entry) =>
    entry.name === channel || entry.detector === channel || entry.marker === channel
  );
  if (!parameter) {
    throw new FlowcytoError("unknown_flowjo_parameter", `Channel ${channel} is not present in sample ${metadata.sampleId}.`, "/gates");
  }
  return parameter.detector || parameter.name;
}

function buildTransformContext(workspace: FlowcytoWorkspace, metadataBySample: Map<string, SampleMetadata>): ExportTransformContext {
  const parameterBySampleChannel = new Map<string, string>();
  for (const gate of workspace.gates) {
    const metadata = metadataBySample.get(gate.sample);
    if (!metadata) throw new FlowcytoError("missing_sample_metadata", `Metadata for sample ${gate.sample} is unavailable.`, "/samples");
    for (const channel of gateChannels(gate)) {
      const parameter = flowJoParameter(metadata, channel);
      parameterBySampleChannel.set(sampleChannelKey(gate.sample, channel), parameter);
    }
  }
  const scaleBySampleParameter = new Map<string, AxisScale>();
  for (const view of workspace.views) {
    const metadata = metadataBySample.get(view.sample);
    if (!metadata) throw new FlowcytoError("missing_sample_metadata", `Metadata for sample ${view.sample} is unavailable.`, "/views");
    for (const [channel, scale] of [[view.x, view.scale.x], [view.y, view.scale.y]] as const) {
      const parameter = flowJoParameter(metadata, channel);
      parameterBySampleChannel.set(sampleChannelKey(view.sample, channel), parameter);
      addChannelScale(scaleBySampleParameter, sampleChannelKey(view.sample, parameter), scale);
    }
  }
  return { parameterBySampleChannel, scaleBySampleParameter };
}

function gateParameter(context: ExportTransformContext, sampleId: string, channel: string): string {
  const parameter = context.parameterBySampleChannel.get(sampleChannelKey(sampleId, channel));
  if (!parameter) throw new FlowcytoError("unknown_flowjo_parameter", `Channel ${channel} is not mapped for sample ${sampleId}.`, "/gates");
  return parameter;
}

function exportCoordinate(value: number, channel: string, context: ExportTransformContext): number {
  void channel;
  void context;
  return value;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new FlowcytoError("invalid_flowjo_export_coordinate", "FlowJo export produced a non-finite gate coordinate.", "/gates");
  }
  return String(value);
}

function sampleTransformations(metadata: SampleMetadata, context: ExportTransformContext): XmlElement {
  const transformations: XmlElement = {};
  for (const parameter of metadata.parameters) {
    const parameterName = parameter.detector || parameter.name;
    const range = parameter.range ?? 262144;
    const scale = context.scaleBySampleParameter.get(sampleChannelKey(metadata.sampleId, parameterName)) ?? "linear";
    const key = scale === "arcsinh" ? "transforms:fasinh" : `transforms:${scale}`;
    const entry = (() => {
      if (scale === "log") return {
        "@_transforms:offset": "1",
        "@_transforms:decades": String(Math.log10(range)),
        "data-type:parameter": { "@_data-type:name": parameterName },
      };
      if (scale === "arcsinh") return {
        "@_transforms:T": String(FLOWCYTO_ARCSINH_T),
        "@_transforms:M": String(FLOWCYTO_ARCSINH_M),
        "@_transforms:A": String(FLOWCYTO_ARCSINH_A),
        "@_transforms:length": String(FLOWCYTO_ARCSINH_LENGTH),
        "data-type:parameter": { "@_data-type:name": parameterName },
      };
      if (scale === "biex") return {
        "@_transforms:length": "256",
        "@_transforms:maxRange": String(range),
        "@_transforms:neg": "0",
        "@_transforms:width": "-10",
        "@_transforms:pos": String(Math.max(1, Math.log10(range) - 1)),
        "data-type:parameter": { "@_data-type:name": parameterName },
      };
      return {
        "@_transforms:minRange": "0",
        "@_transforms:maxRange": String(range),
        "@_gain": "1",
        "data-type:parameter": { "@_data-type:name": parameterName },
      };
    })();
    const current = transformations[key];
    transformations[key] = current === undefined ? entry : [...(Array.isArray(current) ? current : [current]), entry];
  }
  return transformations;
}

function sampleKeywords(metadata: SampleMetadata): XmlElement {
  return {
    Keyword: Object.entries(metadata.keywords)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => ({ "@_name": name, "@_value": value })),
  };
}

function dimension(context: ExportTransformContext, sampleId: string, channel: string, min?: number, max?: number): XmlElement {
  return {
    // Do NOT include gating:compensation-ref — real FlowJo WSP files omit it on uncompensated
    // scatter gates. Including "uncompensated" causes FlowJo to look up the channel in that
    // matrix's transform list; scatter channels are not in the transform store → "parameter missing".
    ...(min !== undefined ? { "@_gating:min": formatNumber(exportCoordinate(min, channel, context)) } : {}),
    ...(max !== undefined ? { "@_gating:max": formatNumber(exportCoordinate(max, channel, context)) } : {}),
    "data-type:fcs-dimension": { "@_data-type:name": gateParameter(context, sampleId, channel) },
  };
}

function gateBody(gate: WorkspaceGate, context: ExportTransformContext): XmlElement {
  if (gate.type === "polygon") {
    return {
      // gating:id and gating:parent_id are omitted here — real FlowJo puts them only on <Gate>,
      // not on the geometry element. Duplicating them confuses FlowJo's gate parser.
      "gating:PolygonGate": {
        "gating:dimension": [dimension(context, gate.sample, gate.x), dimension(context, gate.sample, gate.y)],
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
        "gating:dimension": [
          dimension(context, gate.sample, gate.x, gate.xMin, gate.xMax),
          dimension(context, gate.sample, gate.y, gate.yMin, gate.yMax),
        ],
      },
    };
  }
  if (gate.type === "quadrant") throw new FlowcytoError("invalid_flowjo_gate", "Quadrant gates must be expanded into FlowJo populations.", "/gates");
  return {
    "gating:RangeGate": {
      "gating:dimension": dimension(context, gate.sample, gate.x, gate.min, gate.max),
    },
  };
}

function buildGateTree(gates: WorkspaceGate[], parent: string, context: ExportTransformContext): XmlElement[] {
  return gates
    .filter((gate) => gate.parent === parent)
    .sort((left, right) => left.id.localeCompare(right.id))
    .flatMap((gate) => {
      if (gate.type === "quadrant") {
        return gate.quadrants.map((population) => ({
          "@_name": population.name || population.id,
          "@_owningGroup": "Samples",
          "@_expanded": "1",
          Gate: {
            "@_gating:id": population.id,
            ...(gate.parent === "root" ? {} : { "@_gating:parent_id": gate.parent }),
            "gating:RectangleGate": {
              "@_eventsInside": "1",
              "@_userDefined": "1",
              "gating:dimension": [
                dimension(
                  context,
                  gate.sample,
                  gate.x,
                  population.x === "+" ? gate.xThreshold : undefined,
                  population.x === "-" ? gate.xThreshold : undefined,
                ),
                dimension(
                  context,
                  gate.sample,
                  gate.y,
                  population.y === "+" ? gate.yThreshold : undefined,
                  population.y === "-" ? gate.yThreshold : undefined,
                ),
              ],
            },
          },
          Subpopulations: {
            Population: buildGateTree(gates, population.id, context),
          },
        }));
      }
      return {
        "@_name": gateName(gate),
        "@_owningGroup": "Samples",
        "@_expanded": "1",
        Gate: {
          "@_gating:id": gate.id,
          ...(gate.parent === "root" ? {} : { "@_gating:parent_id": gate.parent }),
          ...gateBody(gate, context),
        },
        Subpopulations: {
          Population: buildGateTree(gates, gate.id, context),
        },
      };
    });
}

function sampleElement(workspacePath: string, workspace: FlowcytoWorkspace, sample: FlowcytoSample, metadata: SampleMetadata, context: ExportTransformContext, sampleId: number): XmlElement {
  const gates = workspace.gates.filter((gate) => gate.sample === sample.id);
  const rootGates = buildGateTree(gates, "root", context);
  // Use $FIL keyword (the name the cytometer wrote) as the SampleNode name, matching FlowJo's
  // convention. Falls back to the disk filename if $FIL is absent.
  const nodeName = (metadata.keywords["$FIL"] ?? "").trim() || sampleName(sample);
  return {
    DataSet: {
      "@_uri": fileUri(resolveSamplePath(workspacePath, sample.path)),
      "@_sampleID": String(sampleId),
    },
    Transformations: sampleTransformations(metadata, context),
    Keywords: sampleKeywords(metadata),
    SampleNode: {
      "@_name": nodeName,
      "@_owningGroup": "",
      "@_expanded": "1",
      "@_sortPriority": "10",
      ...(metadata.eventCount === null ? {} : { "@_count": String(metadata.eventCount) }),
      "@_sampleID": String(sampleId),
      Subpopulations: {
        Population: rootGates,
      },
    },
  };
}

function allSamplesGroup(sampleCount: number): XmlElement {
  return {
    GroupNode: {
      "@_name": "All Samples",
      "@_annotation": "",
      "@_owningGroup": "All Samples",
      "@_expanded": "1",
      "@_sortPriority": "10",
      "@_count": "-1",
      Group: {
        "@_name": "All Samples",
        "@_live": "1",
        "@_role": "ws.group.dlog.test",
        "@_key": "",
        "@_synchronized": "0",
        Criteria: {},
        SampleRefs: {
          SampleRef: Array.from({ length: sampleCount }, (_, index) => ({ "@_sampleID": String(index + 1) })),
        },
        Keywords: {},
      },
    },
  };
}

function buildFlowJoXml(workspacePath: string, workspace: FlowcytoWorkspace, metadataBySample: Map<string, SampleMetadata>): string {
  const context = buildTransformContext(workspace, metadataBySample);
  const cytometers = {
    Cytometer: {
      "@_name": "Flowcyto",
      "@_linearRescale": "1",
    },
  };
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
      "@_flowJoVersion": "10.10.0",
      "@_curGroup": "All Samples",
      "@_xmlns:gating": "http://www.isac-net.org/std/Gating-ML/v2.0/gating",
      "@_xmlns:data-type": "http://www.isac-net.org/std/Gating-ML/v2.0/datatypes",
      "@_xmlns:transforms": "http://www.isac-net.org/std/Gating-ML/v2.0/transformations",
      Cytometers: cytometers,
      Groups: allSamplesGroup(workspace.samples.length),
      SampleList: {
        Sample: workspace.samples.map((sample, index) => {
          const metadata = metadataBySample.get(sample.id);
          if (!metadata) throw new FlowcytoError("missing_sample_metadata", `Metadata for sample ${sample.id} is unavailable.`, "/samples");
          return sampleElement(workspacePath, workspace, sample, metadata, context, index + 1);
        }),
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
  const metadataBySample = new Map<string, SampleMetadata>();
  for (const sample of workspace.samples) {
    metadataBySample.set(sample.id, await readFcsMetadata(resolveSamplePath(workspacePath, sample.path), sample.id));
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, buildFlowJoXml(workspacePath, workspace, metadataBySample), "utf8");
  const warnings = input.compensationId
    ? ["Compensation matrix export is not implemented in this initial FlowJo export path."]
    : [];
  if (workspace.views.length > 0) {
    warnings.push("Saved Flowcyto views contribute transform metadata, but FlowJo LayoutEditor layouts are not exported.");
  }
  return {
    ok: true,
    wspPath: outputPath,
    bundlePath: null,
    samplesExported: workspace.samples.length,
    gatesExported: workspace.gates.length,
    compensationExported: false,
    warnings,
  };
}
