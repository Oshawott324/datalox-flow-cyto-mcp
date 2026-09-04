import { promises as fs } from "node:fs";
import path from "node:path";

import { XMLParser } from "fast-xml-parser";

import { readFcsMetadata } from "./fcs.js";
import { validateWorkspaceObject, writeWorkspace } from "./workspace.js";
import { FlowcytoError, type FlowcytoSample, type FlowcytoWorkspace, type SampleMetadata, type WorkspaceGate } from "./types.js";

type XmlNode = Record<string, unknown>;
type ImportedGateBase = {
  id: string;
  name?: string;
  sample: string;
  parent: string;
};
type ChannelResolver = (channel: string) => string;
type CoordinateConverter = (channel: string, value: number, gateName: string) => number;
type FlowJoTransform = {
  kind: "linear" | "log" | "biex";
  gain?: number;
};
type FlowJoTransformContext = {
  linearRescale: number;
  transformsByChannel: Map<string, FlowJoTransform>;
  unsupportedWarnings: Set<string>;
};

export type ImportFlowJoWorkspaceInput = {
  wspPath: string;
  workspaceDir: string;
  sampleNames?: string[];
  sampleIds?: string[];
  sampleIdMap?: Record<string, string>;
  samplePathMap?: Record<string, string>;
  overwriteSamples?: boolean;
  overwriteGates?: boolean;
};

export type ImportFlowJoWorkspaceResult = {
  ok: true;
  workspacePath: string;
  samplesImported: number;
  gatesImported: number;
  compensationsImported: number;
  warnings: string[];
};

function asRecord(value: unknown): XmlNode | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as XmlNode : null;
}

function arrayOf(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function stringAttr(node: XmlNode | null, key: string): string | undefined {
  const value = node?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberAttr(node: XmlNode | null, key: string): number | undefined {
  const value = node?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sanitizeId(value: string, fallback: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function fileNameFromUri(uri: string): string {
  const normalized = uri.replace(/^file:\/+/i, "").replaceAll("\\", "/");
  const decoded = decodeURIComponent(normalized);
  return path.basename(decoded) || "sample.fcs";
}

function resolveSamplePath(input: ImportFlowJoWorkspaceInput, sampleName: string, dataUri: string): string {
  const map = input.samplePathMap ?? {};
  const fileName = fileNameFromUri(dataUri);
  const mapped = map[sampleName] ?? map[fileName] ?? map[path.basename(fileName, path.extname(fileName))];
  if (mapped) return path.resolve(mapped);
  if (/^file:/i.test(dataUri)) {
    const withoutScheme = dataUri.replace(/^file:\/+/i, "");
    return path.resolve(decodeURIComponent(withoutScheme));
  }
  return path.resolve(path.dirname(input.wspPath), dataUri);
}

function sampleIdFor(input: ImportFlowJoWorkspaceInput, sampleName: string, dataUri: string, index: number): string {
  const fileName = fileNameFromUri(dataUri);
  const stem = path.basename(fileName, path.extname(fileName));
  const mapped = input.sampleIdMap?.[sampleName] ?? input.sampleIdMap?.[fileName] ?? input.sampleIdMap?.[stem];
  return sanitizeId(mapped ?? stem, `sample_${index + 1}`);
}

function shouldImportSample(input: ImportFlowJoWorkspaceInput, sampleName: string, sampleId: string): boolean {
  const hasNameFilter = input.sampleNames !== undefined && input.sampleNames.length > 0;
  const hasIdFilter = input.sampleIds !== undefined && input.sampleIds.length > 0;
  if (!hasNameFilter && !hasIdFilter) return true;
  return (input.sampleNames ?? []).includes(sampleName) || (input.sampleIds ?? []).includes(sampleId);
}

function parameterName(dimension: XmlNode | null, resolveChannel: ChannelResolver): string | undefined {
  const parameter = asRecord(dimension?.parameter) ?? asRecord(dimension?.["fcs-dimension"]);
  const name = stringAttr(parameter, "name");
  return name ? resolveChannel(name) : undefined;
}

function parsePolygonGate(node: XmlNode, base: ImportedGateBase, resolveChannel: ChannelResolver, convertCoordinate: CoordinateConverter): WorkspaceGate | null {
  const dimensions = arrayOf(node.dimension).map(asRecord).filter((entry): entry is XmlNode => entry !== null);
  const x = parameterName(dimensions[0] ?? null, resolveChannel);
  const y = parameterName(dimensions[1] ?? null, resolveChannel);
  const vertices = arrayOf(node.vertex).map(asRecord).map((vertex) => {
    const coordinates = arrayOf(vertex?.coordinate).map(asRecord);
    const xValue = numberAttr(coordinates[0] ?? null, "value");
    const yValue = numberAttr(coordinates[1] ?? null, "value");
    return xValue === undefined || yValue === undefined || !x || !y
      ? null
      : [convertCoordinate(x, xValue, base.name ?? base.id), convertCoordinate(y, yValue, base.name ?? base.id)] as [number, number];
  }).filter((vertex): vertex is [number, number] => vertex !== null);
  if (!x || !y || vertices.length < 3) return null;
  return { ...base, type: "polygon", x, y, vertices };
}

function parseRectangleGate(node: XmlNode, base: ImportedGateBase, resolveChannel: ChannelResolver, convertCoordinate: CoordinateConverter): WorkspaceGate | null {
  const dimensions = arrayOf(node.dimension).map(asRecord).filter((entry): entry is XmlNode => entry !== null);
  const xDimension = dimensions[0] ?? null;
  const yDimension = dimensions[1] ?? null;
  const x = parameterName(xDimension, resolveChannel);
  const y = parameterName(yDimension, resolveChannel);
  const xMin = numberAttr(xDimension, "min");
  const xMax = numberAttr(xDimension, "max");
  const yMin = numberAttr(yDimension, "min");
  const yMax = numberAttr(yDimension, "max");
  if (!x || !y || xMin === undefined || xMax === undefined || yMin === undefined || yMax === undefined) return null;
  const gateName = base.name ?? base.id;
  return {
    ...base,
    type: "rect",
    x,
    y,
    xMin: convertCoordinate(x, xMin, gateName),
    xMax: convertCoordinate(x, xMax, gateName),
    yMin: convertCoordinate(y, yMin, gateName),
    yMax: convertCoordinate(y, yMax, gateName),
  };
}

function parseRangeGate(node: XmlNode, base: ImportedGateBase, resolveChannel: ChannelResolver, convertCoordinate: CoordinateConverter): WorkspaceGate | null {
  const dimension = asRecord(arrayOf(node.dimension)[0]);
  const x = parameterName(dimension, resolveChannel);
  const min = numberAttr(dimension, "min");
  const max = numberAttr(dimension, "max");
  if (!x || min === undefined || max === undefined) return null;
  const gateName = base.name ?? base.id;
  return { ...base, type: "range", x, min: convertCoordinate(x, min, gateName), max: convertCoordinate(x, max, gateName) };
}

function parseGateWrapper(wrapper: XmlNode, sampleId: string, parentId: string, warnings: string[], resolveChannel: ChannelResolver, convertCoordinate: CoordinateConverter): WorkspaceGate | null {
  const flowJoGate = asRecord(wrapper.Gate);
  const geometryParent = flowJoGate ?? wrapper;
  const polygon = asRecord(geometryParent.PolygonGate);
  const rectangle = asRecord(geometryParent.RectangleGate);
  const range = asRecord(geometryParent.RangeGate) ?? asRecord(geometryParent.IntervalGate);
  const unsupported = ["EllipsoidGate", "QuadrantGate", "BooleanGate"].find((key) => geometryParent[key] !== undefined);
  const gateNode = polygon ?? rectangle ?? range;
  const name = stringAttr(wrapper, "name") ?? stringAttr(gateNode, "name");
  const id = stringAttr(gateNode, "id") ?? stringAttr(flowJoGate, "id") ?? stringAttr(wrapper, "id") ?? sanitizeId(name ?? "gate", "gate");
  const base = {
    id: sanitizeId(id, "flowjo_gate"),
    name,
    sample: sampleId,
    parent: parentId,
  };
  if (polygon) return parsePolygonGate(polygon, base, resolveChannel, convertCoordinate);
  if (rectangle) return parseRectangleGate(rectangle, base, resolveChannel, convertCoordinate);
  if (range) return parseRangeGate(range, base, resolveChannel, convertCoordinate);
  if (unsupported) warnings.push(`${unsupported} skipped for gate ${name ?? id}.`);
  return null;
}

function collectGateWrappers(subpopulations: unknown): XmlNode[] {
  const root = asRecord(subpopulations);
  if (!root) return [];
  return [
    ...arrayOf(root.Gate),
    ...arrayOf(root.Population),
  ].map(asRecord).filter((entry): entry is XmlNode => entry !== null);
}

function appendNestedGates(wrappers: XmlNode[], sampleId: string, parentId: string, gates: WorkspaceGate[], warnings: string[], resolveChannel: ChannelResolver, convertCoordinate: CoordinateConverter): void {
  for (const wrapper of wrappers) {
    const gate = parseGateWrapper(wrapper, sampleId, parentId, warnings, resolveChannel, convertCoordinate);
    const nextParent = gate?.id ?? parentId;
    if (gate) gates.push(gate);
    appendNestedGates(collectGateWrappers(wrapper.Subpopulations), sampleId, nextParent, gates, warnings, resolveChannel, convertCoordinate);
  }
}

function parseWorkspaceXml(xml: string): XmlNode {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    removeNSPrefix: true,
    parseAttributeValue: false,
    trimValues: true,
  });
  const parsed = parser.parse(xml);
  const workspace = asRecord(asRecord(parsed)?.Workspace);
  if (!workspace) throw new FlowcytoError("invalid_flowjo_workspace", "FlowJo .wsp does not contain a Workspace root.");
  return workspace;
}

async function existingOrEmptyWorkspace(workspacePath: string): Promise<{ exists: boolean; workspace: FlowcytoWorkspace }> {
  try {
    const raw = await fs.readFile(workspacePath, "utf8");
    return { exists: true, workspace: JSON.parse(raw) as FlowcytoWorkspace };
  } catch (error) {
    if (asRecord(error)?.code !== "ENOENT") throw error;
    return { exists: false, workspace: { version: 1, revision: 0, samples: [], views: [], gates: [] } };
  }
}

function pathForWorkspace(rootDir: string, samplePath: string): string {
  const resolved = path.resolve(samplePath);
  const relative = path.relative(rootDir, resolved);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : resolved;
}

function normalizedChannel(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, "");
}

function channelAliases(value: string): string[] {
  const values = [value];
  for (const prefix of ["FJComp-", "Comp-", "C_"]) {
    if (value.toLowerCase().startsWith(prefix.toLowerCase())) values.push(value.slice(prefix.length));
  }
  return values;
}

function channelResolver(metadata: SampleMetadata): ChannelResolver {
  const byToken = new Map<string, string>();
  for (const parameter of metadata.parameters) {
    for (const alias of channelAliases(parameter.name)) byToken.set(normalizedChannel(alias), parameter.name);
    if (parameter.detector) {
      for (const alias of channelAliases(parameter.detector)) byToken.set(normalizedChannel(alias), parameter.name);
    }
    if (parameter.marker) {
      for (const alias of channelAliases(parameter.marker)) byToken.set(normalizedChannel(alias), parameter.name);
    }
  }
  return (channel) => {
    for (const alias of channelAliases(channel)) {
      const resolved = byToken.get(normalizedChannel(alias));
      if (resolved) return resolved;
    }
    return channel;
  };
}

function transformParameterName(transformNode: XmlNode, resolveChannel: ChannelResolver): string | undefined {
  const parameter = asRecord(transformNode.parameter) ?? asRecord(transformNode["fcs-dimension"]);
  const name = stringAttr(parameter, "name");
  return name ? resolveChannel(name) : undefined;
}

function addTransforms(nodes: unknown, kind: FlowJoTransform["kind"], context: FlowJoTransformContext, resolveChannel: ChannelResolver): void {
  for (const node of arrayOf(nodes).map(asRecord).filter((entry): entry is XmlNode => entry !== null)) {
    const name = transformParameterName(node, resolveChannel);
    if (!name || context.transformsByChannel.has(name)) continue;
    context.transformsByChannel.set(name, { kind, gain: numberAttr(node, "gain") });
  }
}

function flowJoTransformContext(workspace: XmlNode, resolveChannel: ChannelResolver): FlowJoTransformContext {
  const context: FlowJoTransformContext = {
    linearRescale: 1,
    transformsByChannel: new Map(),
    unsupportedWarnings: new Set(),
  };
  const cytometer = asRecord(arrayOf(asRecord(workspace.Cytometers)?.Cytometer)[0]);
  if (!cytometer) return context;
  context.linearRescale = numberAttr(cytometer, "linearRescale") ?? 1;
  for (const matrixId of arrayOf(asRecord(cytometer.TransformStore)?.MatrixID).map(asRecord).filter((entry): entry is XmlNode => entry !== null)) {
    const transforms = asRecord(matrixId.Transforms);
    if (!transforms) continue;
    addTransforms(transforms.linear, "linear", context, resolveChannel);
    addTransforms(transforms.log, "log", context, resolveChannel);
    addTransforms(transforms.biex, "biex", context, resolveChannel);
  }
  return context;
}

function coordinateConverter(context: FlowJoTransformContext, warnings: string[]): CoordinateConverter {
  return (channel, value, gateName) => {
    const transform = context.transformsByChannel.get(channel);
    if (!transform) return value;
    if (transform.kind === "linear") return value * context.linearRescale / (transform.gain ?? 1);
    const warning = `FlowJo ${transform.kind} transform is not converted for gate ${gateName} channel ${channel}; coordinates imported as stored.`;
    if (!context.unsupportedWarnings.has(warning)) {
      context.unsupportedWarnings.add(warning);
      warnings.push(warning);
    }
    return value;
  };
}

async function readFlowJoSamples(input: ImportFlowJoWorkspaceInput, workspace: XmlNode): Promise<{ samples: FlowcytoSample[]; gates: WorkspaceGate[]; warnings: string[] }> {
  const sampleNodes = arrayOf(asRecord(workspace.SampleList)?.Sample).map(asRecord).filter((entry): entry is XmlNode => entry !== null);
  const warnings: string[] = [];
  const samples: FlowcytoSample[] = [];
  const gates: WorkspaceGate[] = [];
  const rootDir = path.resolve(input.workspaceDir);

  for (let index = 0; index < sampleNodes.length; index += 1) {
    const sample = sampleNodes[index] as XmlNode;
    const dataSet = asRecord(sample.DataSet);
    const sampleNode = asRecord(sample.SampleNode);
    const dataUri = stringAttr(dataSet, "uri") ?? "";
    const sampleName = stringAttr(sampleNode, "name") ?? fileNameFromUri(dataUri);
    const sampleId = sampleIdFor(input, sampleName, dataUri, index);
    if (!shouldImportSample(input, sampleName, sampleId)) continue;
    const samplePath = resolveSamplePath(input, sampleName, dataUri);
    const metadata = await readFcsMetadata(samplePath, sampleId);
    const resolveChannel = channelResolver(metadata);
    const transformContext = flowJoTransformContext(workspace, resolveChannel);
    samples.push({ id: sampleId, path: pathForWorkspace(rootDir, samplePath) });
    appendNestedGates(collectGateWrappers(sampleNode?.Subpopulations), sampleId, "root", gates, warnings, resolveChannel, coordinateConverter(transformContext, warnings));
  }
  if (samples.length === 0) {
    throw new FlowcytoError("flowjo_sample_filter_no_match", "No FlowJo samples matched sampleNames/sampleIds filter.", "/sampleNames");
  }
  return { samples, gates, warnings };
}

function mergeById<T extends { id: string }>(existing: T[], imported: T[], overwrite: boolean): T[] {
  const map = new Map(existing.map((entry) => [entry.id, entry]));
  for (const entry of imported) {
    if (overwrite || !map.has(entry.id)) map.set(entry.id, entry);
  }
  return Array.from(map.values());
}

function uniquifyGateIds(gates: WorkspaceGate[]): WorkspaceGate[] {
  const used = new Set<string>();
  const idMap = new Map<string, string>();
  return gates.map((gate) => {
    const original = gate.id;
    let next = original;
    for (let suffix = 2; used.has(next); suffix += 1) {
      next = `${original}_${suffix}`;
    }
    used.add(next);
    idMap.set(original, next);
    return {
      ...gate,
      id: next,
      parent: gate.parent === "root" ? "root" : idMap.get(gate.parent) ?? gate.parent,
    };
  });
}

export async function importFlowJoWorkspace(input: ImportFlowJoWorkspaceInput): Promise<ImportFlowJoWorkspaceResult> {
  const wspPath = path.resolve(input.wspPath);
  const workspaceDir = path.resolve(input.workspaceDir);
  await fs.mkdir(workspaceDir, { recursive: true });
  const workspacePath = path.join(workspaceDir, "flowcyto.workspace.json");
  const xml = await fs.readFile(wspPath, "utf8");
  const flowJoWorkspace = parseWorkspaceXml(xml);
  const imported = await readFlowJoSamples({ ...input, wspPath, workspaceDir }, flowJoWorkspace);
  const currentState = await existingOrEmptyWorkspace(workspacePath);
  const current = currentState.workspace;
  const importedGates = uniquifyGateIds(imported.gates);
  const next: FlowcytoWorkspace = {
    ...current,
    samples: mergeById(current.samples, imported.samples, input.overwriteSamples ?? false),
    gates: mergeById(current.gates, importedGates, input.overwriteGates ?? false),
  };
  const validation = await validateWorkspaceObject(workspacePath, next);
  if (!validation.ok) {
    const first = validation.errors[0];
    throw new FlowcytoError(first?.code ?? "flowjo_import_validation_failed", first?.message ?? "Imported FlowJo workspace is invalid.", first?.path);
  }
  if (currentState.exists) {
    const write = await writeWorkspace({ workspacePath, workspace: next, expectedRevision: current.revision });
    if (!write.ok) {
      const first = write.errors[0];
      throw new FlowcytoError(first?.code ?? "flowjo_import_write_failed", first?.message ?? "Unable to write imported FlowJo workspace.", first?.path);
    }
  } else {
    await fs.writeFile(workspacePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }
  return {
    ok: true,
    workspacePath,
    samplesImported: imported.samples.length,
    gatesImported: importedGates.length,
    compensationsImported: 0,
    warnings: imported.warnings,
  };
}
