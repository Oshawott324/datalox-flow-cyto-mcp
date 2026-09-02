import { promises as fs } from "node:fs";
import path from "node:path";

import {
  compensationDiagnosticsForWorkspace,
  detectCompensationStatus,
  extractSpilloverMatrices,
} from "./compensation.js";
import { readFcsMetadata } from "./fcs.js";
import {
  type CompensationDiagnostics,
  type CompensationMatrix,
  type CompensationStatus,
  FlowcytoError,
  type FlowcytoSample,
  type FlowcytoWorkspace,
  type SampleParameter,
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

export type OpenFcsRecommendedView = {
  x: string;
  y: string;
  intent: "main_population" | "marker_pair";
  parent: "root";
  scale: { x: "linear"; y: "linear" };
};

export type OpenFcsArtifactResult = {
  ok: true;
  workspacePath: string;
  sampleId: string;
  sourcePath: string;
  sourceKind: "fcs" | "workspace";
  workspaceCreated: boolean;
  sampleAdded: boolean;
  revision: number;
  channels: SampleParameter[];
  recommendedViews: OpenFcsRecommendedView[];
  compensationSummary: {
    available: boolean;
    count: number;
    defaultApplied: false;
    suggestedCompensationId?: string;
  };
  compensationStatus: CompensationStatus;
  compensationDiagnostics: CompensationDiagnostics;
};

function sampleIdFromPath(samplePath: string): string {
  const base = path.basename(samplePath, path.extname(samplePath)).replace(/[^A-Za-z0-9._-]+/g, "_");
  return base.length > 0 ? base : "sample_001";
}

function uniqueSampleId(workspace: FlowcytoWorkspace, preferred: string): string {
  const used = new Set(workspace.samples.map((sample) => sample.id));
  if (!used.has(preferred)) return preferred;
  for (let index = 2; ; index += 1) {
    const candidate = `${preferred}_${index}`;
    if (!used.has(candidate)) return candidate;
  }
}

function sampleForResolvedPath(workspacePath: string, workspace: FlowcytoWorkspace, samplePath: string): FlowcytoSample | undefined {
  const resolvedSamplePath = path.resolve(samplePath);
  return workspace.samples.find((sample) => path.resolve(resolveSamplePath(workspacePath, sample.path)) === resolvedSamplePath);
}

function channelNamed(parameters: SampleParameter[], names: string[]): SampleParameter | undefined {
  const lowerNames = new Set(names.map((name) => name.toLowerCase()));
  return parameters.find((parameter) => lowerNames.has(parameter.name.toLowerCase()));
}

function channelWithPrefix(parameters: SampleParameter[], prefix: string): SampleParameter | undefined {
  const lowerPrefix = prefix.toLowerCase();
  return parameters.find((parameter) => parameter.name.toLowerCase().startsWith(lowerPrefix));
}

function channelWithPrefixAndArea(parameters: SampleParameter[], prefix: string): SampleParameter | undefined {
  const lowerPrefix = prefix.toLowerCase();
  return parameters.find((parameter) => {
    const name = parameter.name.toLowerCase();
    return name.startsWith(lowerPrefix) && (name.endsWith("-a") || name.includes("-a "));
  });
}

function recommendedViewsForMetadata(metadata: SampleMetadata): OpenFcsRecommendedView[] {
  const parameters = metadata.parameters;
  const fsc = channelNamed(parameters, ["FSC-A"]) ?? channelWithPrefixAndArea(parameters, "FSC") ?? channelWithPrefix(parameters, "FSC") ?? parameters[0];
  const ssc = channelNamed(parameters, ["SSC-A"]) ?? channelWithPrefixAndArea(parameters, "SSC") ?? channelWithPrefix(parameters, "SSC") ?? parameters.find((parameter) => parameter.name !== fsc?.name);
  const views: OpenFcsRecommendedView[] = [];
  if (fsc && ssc) {
    views.push({
      x: fsc.name,
      y: ssc.name,
      intent: "main_population",
      parent: "root",
      scale: { x: "linear", y: "linear" },
    });
  }

  const markerParameters = parameters.filter((parameter) =>
    parameter.marker
    && parameter.name !== fsc?.name
    && parameter.name !== ssc?.name
    && !parameter.name.toLowerCase().startsWith("time"),
  );
  if (markerParameters.length >= 2) {
    views.push({
      x: markerParameters[0].name,
      y: markerParameters[1].name,
      intent: "marker_pair",
      parent: "root",
      scale: { x: "linear", y: "linear" },
    });
  }
  return views;
}

function compactChannels(metadata: SampleMetadata): SampleParameter[] {
  return metadata.parameters.map((parameter) => ({
    name: parameter.name,
    index: parameter.index,
    ...(parameter.detector ? { detector: parameter.detector } : {}),
    ...(parameter.marker ? { marker: parameter.marker } : {}),
    ...(parameter.range !== undefined ? { range: parameter.range } : {}),
  }));
}

function sameMatrix(left: CompensationMatrix, right: CompensationMatrix): boolean {
  return left.id === right.id
    && left.sample === right.sample
    && left.keyword === right.keyword
    && JSON.stringify(left.channels) === JSON.stringify(right.channels)
    && JSON.stringify(left.matrix) === JSON.stringify(right.matrix);
}

function mergeCompensations(workspace: FlowcytoWorkspace, nextCompensations: CompensationMatrix[]): CompensationMatrix[] {
  const byId = new Map((workspace.compensations ?? []).map((matrix) => [matrix.id, matrix]));
  nextCompensations.forEach((matrix) => byId.set(matrix.id, matrix));
  return Array.from(byId.values()).sort((left, right) => left.id.localeCompare(right.id));
}

function compensationSummary(status: CompensationStatus, count: number): OpenFcsArtifactResult["compensationSummary"] {
  return {
    available: count > 0,
    count,
    defaultApplied: false,
    ...(status.suggestedCompensationId ? { suggestedCompensationId: status.suggestedCompensationId } : {}),
  };
}

async function compensationContextForMetadata(input: {
  workspace: FlowcytoWorkspace;
  sampleId: string;
  metadata: SampleMetadata;
}): Promise<{
  compensations: CompensationMatrix[];
  status: CompensationStatus;
  diagnostics: CompensationDiagnostics;
}> {
  const availableChannels = input.metadata.parameters.map((parameter) => parameter.name);
  const extracted = extractSpilloverMatrices({
    keywords: input.metadata.keywords,
    sampleId: input.sampleId,
    availableChannels,
  });
  const existing = input.workspace.compensations ?? [];
  const compensations = mergeCompensations(input.workspace, extracted.compensations);
  const sampleCompensations = compensations.filter((matrix) => matrix.sample === input.sampleId || matrix.sample === undefined);
  const status = detectCompensationStatus({
    keywords: input.metadata.keywords,
    channels: availableChannels,
    compensations: sampleCompensations,
  });
  const diagnostics = extracted.compensations.length > 0
    ? {
      ...extracted.diagnostics,
      matrixChannels: extracted.compensations[0].channels,
    }
    : compensationDiagnosticsForWorkspace({
      workspaceCompensations: existing,
      sampleId: input.sampleId,
      availableChannels,
    });
  return { compensations, status, diagnostics };
}

function workspaceNeedsCompensationUpdate(input: {
  workspace: FlowcytoWorkspace;
  compensations: CompensationMatrix[];
  sampleId: string;
  status: CompensationStatus;
}): boolean {
  const current = input.workspace.compensations ?? [];
  if (current.length !== input.compensations.length) return true;
  for (const matrix of input.compensations) {
    const existing = current.find((entry) => entry.id === matrix.id);
    if (!existing || !sameMatrix(existing, matrix)) return true;
  }
  const currentStatus = input.workspace.compensationStatus?.[input.sampleId];
  if (
    input.compensations.length === 0
    && currentStatus === undefined
    && !input.status.embeddedMatrixFound
    && !input.status.detectedAsPreCompensated
  ) {
    return false;
  }
  return JSON.stringify(currentStatus ?? null) !== JSON.stringify(input.status);
}

async function writeCompensationContext(input: {
  workspacePath: string;
  workspace: FlowcytoWorkspace;
  sampleId: string;
  compensations: CompensationMatrix[];
  status: CompensationStatus;
}): Promise<FlowcytoWorkspace> {
  if (!workspaceNeedsCompensationUpdate(input)) return input.workspace;
  const next: FlowcytoWorkspace = {
    ...input.workspace,
    compensations: input.compensations,
    compensationStatus: {
      ...(input.workspace.compensationStatus ?? {}),
      [input.sampleId]: input.status,
    },
  };
  const write = await writeWorkspace({ workspacePath: input.workspacePath, workspace: next, expectedRevision: input.workspace.revision });
  if (!write.ok) {
    throw new FlowcytoError("workspace_compensation_update_failed", "Unable to update workspace compensation metadata.", "/compensations");
  }
  return readWorkspace(input.workspacePath);
}

async function openWorkspaceArtifact(workspacePath: string, requestedSampleId?: string): Promise<OpenFcsArtifactResult> {
  const resolvedWorkspacePath = path.resolve(workspacePath);
  let workspace = await readWorkspace(resolvedWorkspacePath);
  const sample = requestedSampleId
    ? workspace.samples.find((entry) => entry.id === requestedSampleId)
    : workspace.samples[0];
  if (!sample) {
    throw new FlowcytoError(
      requestedSampleId ? "unknown_sample" : "workspace_has_no_samples",
      requestedSampleId ? `Sample ${requestedSampleId} is not present.` : "Workspace has no samples.",
      "/samples",
    );
  }
  const metadata = await getSampleMetadata(resolvedWorkspacePath, sample.id);
  const context = await compensationContextForMetadata({ workspace, sampleId: sample.id, metadata });
  workspace = await writeCompensationContext({
    workspacePath: resolvedWorkspacePath,
    workspace,
    sampleId: sample.id,
    compensations: context.compensations,
    status: context.status,
  });
  return {
    ok: true,
    workspacePath: resolvedWorkspacePath,
    sampleId: sample.id,
    sourcePath: resolvedWorkspacePath,
    sourceKind: "workspace",
    workspaceCreated: false,
    sampleAdded: false,
    revision: workspace.revision,
    channels: compactChannels(metadata),
    recommendedViews: recommendedViewsForMetadata(metadata),
    compensationSummary: compensationSummary(context.status, context.compensations.filter((matrix) => matrix.sample === sample.id || matrix.sample === undefined).length),
    compensationStatus: context.status,
    compensationDiagnostics: context.diagnostics,
  };
}

async function openFcsFileArtifact(params: {
  path: string;
  workspaceDir?: string;
  sampleId?: string;
}): Promise<OpenFcsArtifactResult> {
  const sourcePath = path.resolve(params.path);
  const rootDir = path.resolve(params.workspaceDir ?? path.dirname(sourcePath));
  const workspacePath = path.join(rootDir, "flowcyto.workspace.json");
  const relativeSamplePath = samplePathForWorkspace(rootDir, sourcePath);
  let workspace: FlowcytoWorkspace;
  let workspaceCreated = false;
  let sampleAdded = false;
  try {
    workspace = await readWorkspace(workspacePath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (!(nodeError && nodeError.code === "ENOENT")) throw error;
    const initialized = await initWorkspace({
      rootDir,
      samplePath: sourcePath,
      sampleId: params.sampleId ?? sampleIdFromPath(sourcePath),
    });
    workspace = initialized.workspace;
    workspaceCreated = true;
  }

  const existingByPath = sampleForResolvedPath(workspacePath, workspace, sourcePath);
  if (params.sampleId) {
    const existingById = workspace.samples.find((sample) => sample.id === params.sampleId);
    if (existingById && path.resolve(resolveSamplePath(workspacePath, existingById.path)) !== sourcePath) {
      throw new FlowcytoError("sample_id_conflict", `Sample id ${params.sampleId} already points at another file.`, "/sample_id");
    }
  }

  let sampleId = existingByPath?.id;
  if (!sampleId) {
    sampleId = uniqueSampleId(workspace, params.sampleId ?? sampleIdFromPath(sourcePath));
    const next: FlowcytoWorkspace = {
      ...workspace,
      samples: [
        ...workspace.samples,
        { id: sampleId, path: relativeSamplePath },
      ],
    };
    const write = await writeWorkspace({ workspacePath, workspace: next, expectedRevision: workspace.revision });
    if (!write.ok || write.revision === undefined) {
      throw new FlowcytoError("workspace_sample_add_failed", "Unable to add FCS sample to workspace.", "/samples");
    }
    workspace = await readWorkspace(workspacePath);
    sampleAdded = true;
  }

  const metadata = await getSampleMetadata(workspacePath, sampleId);
  const context = await compensationContextForMetadata({ workspace, sampleId, metadata });
  workspace = await writeCompensationContext({
    workspacePath,
    workspace,
    sampleId,
    compensations: context.compensations,
    status: context.status,
  });
  return {
    ok: true,
    workspacePath,
    sampleId,
    sourcePath,
    sourceKind: "fcs",
    workspaceCreated,
    sampleAdded,
    revision: workspace.revision,
    channels: compactChannels(metadata),
    recommendedViews: recommendedViewsForMetadata(metadata),
    compensationSummary: compensationSummary(context.status, context.compensations.filter((matrix) => matrix.sample === sampleId || matrix.sample === undefined).length),
    compensationStatus: context.status,
    compensationDiagnostics: context.diagnostics,
  };
}

export async function openFcsArtifact(params: {
  path: string;
  workspaceDir?: string;
  sampleId?: string;
}): Promise<OpenFcsArtifactResult> {
  const inputPath = path.resolve(params.path);
  const extension = path.extname(inputPath).toLowerCase();
  if (extension === ".fcs") {
    return openFcsFileArtifact({ path: inputPath, workspaceDir: params.workspaceDir, sampleId: params.sampleId });
  }
  if (path.basename(inputPath) === "flowcyto.workspace.json") {
    return openWorkspaceArtifact(inputPath, params.sampleId);
  }
  throw new FlowcytoError(
    "unsupported_open_fcs_path",
    "open_fcs accepts .fcs files or flowcyto.workspace.json workspace files.",
    "/path",
  );
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

function validateCompensationShape(matrix: unknown, index: number): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!isRecord(matrix)) {
    errors.push(validationError(`/compensations/${index}`, "invalid_compensation", "Compensation must be an object."));
    return errors;
  }
  const id = asString(matrix.id);
  if (!id) errors.push(validationError(`/compensations/${index}/id`, "missing_compensation_id", "Compensation id is required."));
  const source = asString(matrix.source);
  if (source !== "fcs_keyword" && source !== "controls" && source !== "manual") {
    errors.push(validationError(`/compensations/${index}/source`, "invalid_compensation_source", "Compensation source must be fcs_keyword, controls, or manual."));
  }
  const channels = Array.isArray(matrix.channels) ? matrix.channels : [];
  if (channels.length === 0 || channels.some((channel) => typeof channel !== "string" || channel.length === 0)) {
    errors.push(validationError(`/compensations/${index}/channels`, "invalid_compensation_channels", "Compensation channels must be non-empty strings."));
  }
  const values = Array.isArray(matrix.matrix) ? matrix.matrix : [];
  if (channels.length !== values.length) {
    errors.push(validationError(`/compensations/${index}/matrix`, "invalid_compensation_matrix", "Compensation matrix row count must match channels length."));
  }
  values.forEach((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== channels.length || row.some((value) => !isFiniteNumber(value))) {
      errors.push(validationError(`/compensations/${index}/matrix/${rowIndex}`, "invalid_compensation_matrix", "Compensation matrix rows must match channels length and contain finite numbers."));
    }
  });
  return errors;
}

export async function validateWorkspaceObject(workspacePath: string, workspace: unknown): Promise<ValidationResult> {
  const errors = validateShape(workspace);
  if (errors.length > 0 || !isRecord(workspace)) return { ok: errors.length === 0, errors };

  const candidate = workspace as FlowcytoWorkspace;
  const samples = Array.isArray(candidate.samples) ? candidate.samples : [];
  const views = Array.isArray(candidate.views) ? candidate.views : [];
  const gates = Array.isArray(candidate.gates) ? candidate.gates : [];
  const compensations = Array.isArray(candidate.compensations) ? candidate.compensations : [];
  const sampleIds = new Set<string>();
  const gateIds = new Set<string>();
  const compensationIds = new Set<string>();

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

  if (candidate.compensations !== undefined && !Array.isArray(candidate.compensations)) {
    errors.push(validationError("/compensations", "invalid_array", "compensations must be an array when present."));
  }
  compensations.forEach((matrix, index) => {
    errors.push(...validateCompensationShape(matrix, index));
    if (!isRecord(matrix)) return;
    const id = asString(matrix.id);
    if (id && compensationIds.has(id)) errors.push(validationError(`/compensations/${index}/id`, "duplicate_compensation_id", `Duplicate compensation id ${id}.`));
    if (id) compensationIds.add(id);
    const sample = asString(matrix.sample);
    if (sample && !sampleIds.has(sample)) {
      errors.push(validationError(`/compensations/${index}/sample`, "unknown_sample", `Sample ${sample} is not present.`));
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

export async function upsertCompensationMatrix(params: {
  workspacePath: string;
  compensation: CompensationMatrix;
  expectedRevision: number;
}): Promise<{ ok: true; workspacePath: string; revision: number; compensation: CompensationMatrix }> {
  const workspace = await readWorkspace(params.workspacePath);
  const next: FlowcytoWorkspace = {
    ...workspace,
    compensations: mergeCompensations(workspace, [params.compensation]),
  };
  const write = await writeWorkspace({
    workspacePath: params.workspacePath,
    workspace: next,
    expectedRevision: params.expectedRevision,
  });
  if (!write.ok) {
    const first = write.errors[0];
    throw new FlowcytoError(first?.code ?? "workspace_compensation_update_failed", first?.message ?? "Unable to upsert compensation matrix.", first?.path ?? "/compensations");
  }
  return {
    ok: true,
    workspacePath: params.workspacePath,
    revision: write.revision ?? workspace.revision + 1,
    compensation: params.compensation,
  };
}
