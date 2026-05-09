import { promises as fs } from "node:fs";
import path from "node:path";

import { readFcsMetadata } from "./fcs.js";
import {
  FlowcytoError,
  type FlowcytoSample,
  type FlowcytoWorkspace,
  type SampleMetadata,
  type ValidationError,
  type ValidationResult,
  type WorkspaceGate,
  type WorkspaceSummary,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validationError(pathValue: string, code: string, message: string, details?: Record<string, unknown>): ValidationError {
  return details ? { path: pathValue, code, message, details } : { path: pathValue, code, message };
}

export function resolveWorkspaceRoot(workspacePath: string): string {
  return path.dirname(path.resolve(workspacePath));
}

export function resolveSamplePath(workspacePath: string, samplePath: string): string {
  return path.isAbsolute(samplePath) ? samplePath : path.resolve(resolveWorkspaceRoot(workspacePath), samplePath);
}

function samplePathForWorkspace(rootDir: string, samplePath: string): string {
  const resolvedSamplePath = path.resolve(samplePath);
  const relativeSamplePath = path.relative(rootDir, resolvedSamplePath);
  if (relativeSamplePath && !relativeSamplePath.startsWith("..") && !path.isAbsolute(relativeSamplePath)) {
    return relativeSamplePath;
  }
  return resolvedSamplePath;
}

export async function readWorkspace(workspacePath: string): Promise<FlowcytoWorkspace> {
  const raw = await fs.readFile(workspacePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FlowcytoError("invalid_workspace_json", message, "/");
  }
  if (!isRecord(parsed)) {
    throw new FlowcytoError("invalid_workspace_json", "Workspace JSON must be an object.");
  }
  return parsed as FlowcytoWorkspace;
}

export async function openWorkspace(workspacePath: string): Promise<WorkspaceSummary> {
  const workspace = await readWorkspace(workspacePath);
  return {
    workspacePath: path.resolve(workspacePath),
    rootDir: resolveWorkspaceRoot(workspacePath),
    sampleCount: Array.isArray(workspace.samples) ? workspace.samples.length : 0,
    gateCount: Array.isArray(workspace.gates) ? workspace.gates.length : 0,
    viewCount: Array.isArray(workspace.views) ? workspace.views.length : 0,
    samples: Array.isArray(workspace.samples) ? workspace.samples : [],
  };
}

export async function initWorkspace(params: {
  rootDir: string;
  samplePath: string;
  sampleId?: string;
  overwrite?: boolean;
}): Promise<{ workspacePath: string; workspace: FlowcytoWorkspace }> {
  const rootDir = path.resolve(params.rootDir);
  await fs.mkdir(rootDir, { recursive: true });
  const workspacePath = path.join(rootDir, "flowcyto.workspace.json");
  if (!params.overwrite) {
    try {
      await fs.access(workspacePath);
      throw new FlowcytoError("workspace_exists", `Workspace already exists: ${workspacePath}`);
    } catch (error) {
      if (error instanceof FlowcytoError) throw error;
    }
  }

  const samplePath = samplePathForWorkspace(rootDir, params.samplePath);
  const sampleId = params.sampleId ?? path.basename(samplePath, path.extname(samplePath)).replace(/[^A-Za-z0-9._-]+/g, "_");
  const workspace: FlowcytoWorkspace = {
    version: 1,
    revision: 0,
    samples: [{ id: sampleId, path: samplePath }],
    views: [],
    gates: [],
  };

  await atomicWriteJson(workspacePath, workspace);
  return { workspacePath, workspace };
}

async function sampleMetadataMap(workspacePath: string, workspace: FlowcytoWorkspace): Promise<Map<string, SampleMetadata>> {
  const map = new Map<string, SampleMetadata>();
  for (const sample of workspace.samples) {
    try {
      map.set(sample.id, await readFcsMetadata(resolveSamplePath(workspacePath, sample.path), sample.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new FlowcytoError("sample_metadata_failed", `Unable to read metadata for sample ${sample.id}: ${message}`, `/samples/${workspace.samples.indexOf(sample)}/path`);
    }
  }
  return map;
}

export async function getSampleMetadata(workspacePath: string, sampleId: string): Promise<SampleMetadata> {
  const workspace = await readWorkspace(workspacePath);
  const sample = workspace.samples.find((entry) => entry.id === sampleId);
  if (!sample) throw new FlowcytoError("unknown_sample", `Sample ${sampleId} is not present.`, "/samples");
  return readFcsMetadata(resolveSamplePath(workspacePath, sample.path), sample.id);
}

export async function listSamples(workspacePath: string): Promise<FlowcytoSample[]> {
  const workspace = await readWorkspace(workspacePath);
  return workspace.samples;
}

function validateShape(workspace: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!isRecord(workspace)) return [validationError("/", "invalid_workspace", "Workspace must be a JSON object.")];
  if (workspace.version !== 1) errors.push(validationError("/version", "invalid_version", "Workspace version must be 1."));
  if (!Number.isInteger(workspace.revision) || Number(workspace.revision) < 0) {
    errors.push(validationError("/revision", "invalid_revision", "Workspace revision must be a non-negative integer."));
  }
  for (const key of ["samples", "views", "gates"]) {
    if (!Array.isArray(workspace[key])) errors.push(validationError(`/${key}`, "invalid_array", `${key} must be an array.`));
  }
  return errors;
}

function validateGateShape(gate: unknown, index: number): WorkspaceGate | null {
  if (!isRecord(gate)) return null;
  const type = gate.type;
  if (type !== "polygon" && type !== "rect" && type !== "range") return null;
  return gate as WorkspaceGate;
}

export async function validateWorkspaceObject(workspacePath: string, workspace: unknown): Promise<ValidationResult> {
  const errors = validateShape(workspace);
  if (errors.length > 0 || !isRecord(workspace)) return { ok: errors.length === 0, errors };

  const candidate = workspace as FlowcytoWorkspace;
  const samples = Array.isArray(candidate.samples) ? candidate.samples : [];
  const views = Array.isArray(candidate.views) ? candidate.views : [];
  const gates = Array.isArray(candidate.gates) ? candidate.gates : [];
  const sampleIds = new Set<string>();
  const gateIds = new Set<string>();

  samples.forEach((sample, index) => {
    if (!isRecord(sample)) {
      errors.push(validationError(`/samples/${index}`, "invalid_sample", "Sample must be an object."));
      return;
    }
    const id = asString(sample.id);
    const samplePath = asString(sample.path);
    if (!id) errors.push(validationError(`/samples/${index}/id`, "missing_sample_id", "Sample id is required."));
    if (!samplePath) errors.push(validationError(`/samples/${index}/path`, "missing_sample_path", "Sample path is required."));
    if (id && sampleIds.has(id)) errors.push(validationError(`/samples/${index}/id`, "duplicate_sample_id", `Duplicate sample id ${id}.`));
    if (id) sampleIds.add(id);
  });

  const metadataBySample = new Map<string, SampleMetadata>();
  if (errors.length === 0) {
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      try {
        metadataBySample.set(sample.id, await readFcsMetadata(resolveSamplePath(workspacePath, sample.path), sample.id));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(validationError(`/samples/${index}/path`, "sample_metadata_failed", message));
      }
    }
  }

  gates.forEach((rawGate, index) => {
    const gate = validateGateShape(rawGate, index);
    if (!gate) {
      errors.push(validationError(`/gates/${index}`, "invalid_gate", "Gate must be a polygon, rect, or range gate object."));
      return;
    }
    if (!asString(gate.id)) errors.push(validationError(`/gates/${index}/id`, "missing_gate_id", "Gate id is required."));
    if (gateIds.has(gate.id)) errors.push(validationError(`/gates/${index}/id`, "duplicate_gate_id", `Duplicate gate id ${gate.id}.`));
    gateIds.add(gate.id);
    if (!sampleIds.has(gate.sample)) errors.push(validationError(`/gates/${index}/sample`, "unknown_sample", `Sample ${gate.sample} is not present.`));
    if (gate.parent !== "root" && !gates.some((entry) => isRecord(entry) && entry.id === gate.parent)) {
      errors.push(validationError(`/gates/${index}/parent`, "unknown_parent_gate", `Parent gate ${gate.parent} is not present.`));
    }

    const metadata = metadataBySample.get(gate.sample);
    const parameters = new Set(metadata?.parameters.map((parameter) => parameter.name) ?? []);
    if (gate.type === "polygon") {
      if (!parameters.has(gate.x)) errors.push(validationError(`/gates/${index}/x`, "unknown_parameter", `Parameter ${gate.x} is not present in sample ${gate.sample}.`));
      if (!parameters.has(gate.y)) errors.push(validationError(`/gates/${index}/y`, "unknown_parameter", `Parameter ${gate.y} is not present in sample ${gate.sample}.`));
      if (!Array.isArray(gate.vertices) || gate.vertices.length < 3) {
        errors.push(validationError(`/gates/${index}/vertices`, "invalid_polygon_vertices", "Polygon gates require at least three vertices."));
      }
    }
    if (gate.type === "rect") {
      if (!parameters.has(gate.x)) errors.push(validationError(`/gates/${index}/x`, "unknown_parameter", `Parameter ${gate.x} is not present in sample ${gate.sample}.`));
      if (!parameters.has(gate.y)) errors.push(validationError(`/gates/${index}/y`, "unknown_parameter", `Parameter ${gate.y} is not present in sample ${gate.sample}.`));
      if (!isFiniteNumber(gate.xMin) || !isFiniteNumber(gate.xMax) || gate.xMax <= gate.xMin) {
        errors.push(validationError(`/gates/${index}/xMax`, "invalid_rect_bounds", "Rect gate xMax must be greater than xMin."));
      }
      if (!isFiniteNumber(gate.yMin) || !isFiniteNumber(gate.yMax) || gate.yMax <= gate.yMin) {
        errors.push(validationError(`/gates/${index}/yMax`, "invalid_rect_bounds", "Rect gate yMax must be greater than yMin."));
      }
    }
    if (gate.type === "range") {
      if (!parameters.has(gate.x)) errors.push(validationError(`/gates/${index}/x`, "unknown_parameter", `Parameter ${gate.x} is not present in sample ${gate.sample}.`));
      if (!isFiniteNumber(gate.min) || !isFiniteNumber(gate.max) || gate.max <= gate.min) {
        errors.push(validationError(`/gates/${index}/max`, "invalid_range_bounds", "Range gate max must be greater than min."));
      }
    }
  });

  for (const gate of gates) {
    if (!isRecord(gate) || !asString(gate.id)) continue;
    const seen = new Set<string>();
    let cursor: Record<string, unknown> | undefined = gate;
    while (cursor && asString(cursor.parent) && cursor.parent !== "root") {
      const cursorId = asString(cursor.id);
      const cursorParent = asString(cursor.parent);
      if (!cursorId || !cursorParent) break;
      if (seen.has(cursorId)) {
        errors.push(validationError(`/gates/${gates.indexOf(gate)}/parent`, "gate_cycle", `Gate ${gate.id as string} participates in a parent cycle.`));
        break;
      }
      seen.add(cursorId);
      const next = gates.find((entry) => isRecord(entry) && entry.id === cursorParent);
      cursor = isRecord(next) ? next : undefined;
    }
  }

  views.forEach((view, index) => {
    if (!isRecord(view)) {
      errors.push(validationError(`/views/${index}`, "invalid_view", "View must be an object."));
      return;
    }
    const sample = asString(view.sample);
    if (!sample || !sampleIds.has(sample)) errors.push(validationError(`/views/${index}/sample`, "unknown_sample", `Sample ${String(view.sample)} is not present.`));
    const parent = asString(view.parent);
    if (!parent) errors.push(validationError(`/views/${index}/parent`, "missing_parent", "View parent is required."));
    if (parent && parent !== "root" && !gateIds.has(parent)) {
      errors.push(validationError(`/views/${index}/parent`, "unknown_parent_gate", `Parent gate ${parent} is not present.`));
    }
    const metadata = sample ? metadataBySample.get(sample) : undefined;
    const parameters = new Set(metadata?.parameters.map((parameter) => parameter.name) ?? []);
    const x = asString(view.x);
    const y = asString(view.y);
    if (!x || !parameters.has(x)) errors.push(validationError(`/views/${index}/x`, "unknown_parameter", `Parameter ${String(view.x)} is not present.`));
    if (!y || !parameters.has(y)) errors.push(validationError(`/views/${index}/y`, "unknown_parameter", `Parameter ${String(view.y)} is not present.`));
  });

  return { ok: errors.length === 0, errors };
}

export async function validateWorkspace(workspacePath: string): Promise<ValidationResult> {
  try {
    const workspace = await readWorkspace(workspacePath);
    return validateWorkspaceObject(workspacePath, workspace);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      errors: [validationError("/", "invalid_workspace_json", message)],
    };
  }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const target = path.resolve(filePath);
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  const handle = await fs.open(temp, "w");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temp, target);
}

export async function writeWorkspace(params: {
  workspacePath: string;
  workspace: FlowcytoWorkspace;
  expectedRevision?: number;
}): Promise<ValidationResult & { revision?: number }> {
  const current = await readWorkspace(params.workspacePath);
  if (params.expectedRevision !== undefined && current.revision !== params.expectedRevision) {
    return {
      ok: false,
      errors: [
        validationError(
          "/revision",
          "stale_revision",
          `Workspace revision is ${current.revision} but write was based on revision ${params.expectedRevision}.`,
          { currentRevision: current.revision, expectedRevision: params.expectedRevision },
        ),
      ],
    };
  }
  const next: FlowcytoWorkspace = {
    ...params.workspace,
    version: 1,
    revision: current.revision + 1,
  };
  const validation = await validateWorkspaceObject(params.workspacePath, next);
  if (!validation.ok) return validation;
  await atomicWriteJson(params.workspacePath, next);
  return { ok: true, errors: [], revision: next.revision };
}
