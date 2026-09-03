import { promises as fs } from "node:fs";
import path from "node:path";

import { XMLParser } from "fast-xml-parser";

import { readFcsMetadata } from "./fcs.js";
import { validateWorkspaceObject, writeWorkspace } from "./workspace.js";
import { FlowcytoError, type FlowcytoSample, type FlowcytoWorkspace, type WorkspaceGate } from "./types.js";

type XmlNode = Record<string, unknown>;
type ImportedGateBase = {
  id: string;
  name?: string;
  sample: string;
  parent: string;
};

export type ImportFlowJoWorkspaceInput = {
  wspPath: string;
  workspaceDir: string;
  sampleIdMap?: Record<string, string>;
  samplePathMap?: Record<string, string>;
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

function parameterName(dimension: XmlNode | null): string | undefined {
  const parameter = asRecord(dimension?.parameter);
  return stringAttr(parameter, "name");
}

function parsePolygonGate(node: XmlNode, base: ImportedGateBase): WorkspaceGate | null {
  const dimensions = arrayOf(node.dimension).map(asRecord).filter((entry): entry is XmlNode => entry !== null);
  const x = parameterName(dimensions[0] ?? null);
  const y = parameterName(dimensions[1] ?? null);
  const vertices = arrayOf(node.vertex).map(asRecord).map((vertex) => {
    const coordinates = arrayOf(vertex?.coordinate).map(asRecord);
    const xValue = numberAttr(coordinates[0] ?? null, "value");
    const yValue = numberAttr(coordinates[1] ?? null, "value");
    return xValue === undefined || yValue === undefined ? null : [xValue, yValue] as [number, number];
  }).filter((vertex): vertex is [number, number] => vertex !== null);
  if (!x || !y || vertices.length < 3) return null;
  return { ...base, type: "polygon", x, y, vertices };
}

function parseRectangleGate(node: XmlNode, base: ImportedGateBase): WorkspaceGate | null {
  const dimensions = arrayOf(node.dimension).map(asRecord).filter((entry): entry is XmlNode => entry !== null);
  const xDimension = dimensions[0] ?? null;
  const yDimension = dimensions[1] ?? null;
  const x = parameterName(xDimension);
  const y = parameterName(yDimension);
  const xMin = numberAttr(xDimension, "min");
  const xMax = numberAttr(xDimension, "max");
  const yMin = numberAttr(yDimension, "min");
  const yMax = numberAttr(yDimension, "max");
  if (!x || !y || xMin === undefined || xMax === undefined || yMin === undefined || yMax === undefined) return null;
  return { ...base, type: "rect", x, y, xMin, xMax, yMin, yMax };
}

function parseRangeGate(node: XmlNode, base: ImportedGateBase): WorkspaceGate | null {
  const dimension = asRecord(arrayOf(node.dimension)[0]);
  const x = parameterName(dimension);
  const min = numberAttr(dimension, "min");
  const max = numberAttr(dimension, "max");
  if (!x || min === undefined || max === undefined) return null;
  return { ...base, type: "range", x, min, max };
}

function parseGateWrapper(wrapper: XmlNode, sampleId: string, parentId: string, warnings: string[]): WorkspaceGate | null {
  const polygon = asRecord(wrapper.PolygonGate);
  const rectangle = asRecord(wrapper.RectangleGate);
  const range = asRecord(wrapper.RangeGate) ?? asRecord(wrapper.IntervalGate);
  const unsupported = ["EllipsoidGate", "QuadrantGate", "BooleanGate"].find((key) => wrapper[key] !== undefined);
  const gateNode = polygon ?? rectangle ?? range;
  const name = stringAttr(wrapper, "name") ?? stringAttr(gateNode, "name");
  const id = stringAttr(gateNode, "id") ?? stringAttr(wrapper, "id") ?? sanitizeId(name ?? "gate", "gate");
  const base = {
    id: sanitizeId(id, "flowjo_gate"),
    name,
    sample: sampleId,
    parent: parentId,
  };
  if (polygon) return parsePolygonGate(polygon, base);
  if (rectangle) return parseRectangleGate(rectangle, base);
  if (range) return parseRangeGate(range, base);
  if (unsupported) warnings.push(`${unsupported} skipped for gate ${name ?? id}.`);
  return null;
}

function collectGateWrappers(subpopulations: unknown): XmlNode[] {
  const root = asRecord(subpopulations);
  if (!root) return [];
  return arrayOf(root.Gate).map(asRecord).filter((entry): entry is XmlNode => entry !== null);
}

function appendNestedGates(wrappers: XmlNode[], sampleId: string, parentId: string, gates: WorkspaceGate[], warnings: string[]): void {
  for (const wrapper of wrappers) {
    const gate = parseGateWrapper(wrapper, sampleId, parentId, warnings);
    const nextParent = gate?.id ?? parentId;
    if (gate) gates.push(gate);
    appendNestedGates(collectGateWrappers(wrapper.Subpopulations), sampleId, nextParent, gates, warnings);
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
    const samplePath = resolveSamplePath(input, sampleName, dataUri);
    await readFcsMetadata(samplePath, sampleId);
    samples.push({ id: sampleId, path: pathForWorkspace(rootDir, samplePath) });
    appendNestedGates(collectGateWrappers(sampleNode?.Subpopulations), sampleId, "root", gates, warnings);
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
    samples: mergeById(current.samples, imported.samples, true),
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
