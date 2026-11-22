import { promises as fs } from "node:fs";
import path from "node:path";

import {
  compensationDiagnosticsForWorkspace,
  detectCompensationStatus,
  extractSpilloverMatrices,
  normalizeDetectorToken,
} from "./compensation.js";
import { readFcsMetadata } from "./fcs.js";
import {
  type CompensationDiagnostics,
  type CompensationMatrix,
  type CompensationStatus,
  FlowcytoError,
  type FlowcytoSample,
  type FlowcytoView,
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
  if (type !== "polygon" && type !== "rect" && type !== "range" && type !== "quadrant") return null;
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
  if (source !== "fcs_keyword" && source !== "controls" && source !== "manual" && source !== "flowjo_wsp") {
    errors.push(validationError(`/compensations/${index}/source`, "invalid_compensation_source", "Compensation source must be fcs_keyword, controls, manual, or flowjo_wsp."));
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

const AXIS_SCALES = new Set(["linear", "log", "arcsinh", "biex"]);
const LAYOUT_KINDS = new Set(["gating_strategy", "comparison", "freeform"]);
const LAYOUT_PLOT_TYPES = new Set(["pseudocolor", "dot", "contour", "histogram"]);
const PANEL_UNRESOLVED_REASONS = new Set([
  "ambiguous_path", "unknown_path", "unknown_sample", "unknown_parameter",
  "unsupported_name", "unsupported_feature",
]);

function validateAxisBounds(bounds: unknown, basePath: string): ValidationError[] {
  if (!isRecord(bounds)) {
    return [validationError(basePath, "invalid_axis_bounds", "Axis bounds must be an object with min and max.")];
  }
  if (!isFiniteNumber(bounds.min) || !isFiniteNumber(bounds.max) || Number(bounds.max) <= Number(bounds.min)) {
    return [validationError(basePath, "invalid_axis_bounds", "Axis bounds max must be a finite number greater than min.")];
  }
  return [];
}

const TRANSFORM_KEYS = ["cofactor", "maxRange", "pos", "neg", "width", "length"] as const;
// A shared AxisScale name is not sufficient for these: parameters change the mapping.
const PARAMETERIZED_SCALES = new Set(["biex", "arcsinh"]);

function validateAxisTransform(transform: unknown, basePath: string): ValidationError[] {
  if (transform === undefined) return [];
  if (!isRecord(transform)) {
    return [validationError(basePath, "invalid_axis_transform", "Axis transform must be an object of numeric parameters.")];
  }
  const errors: ValidationError[] = [];
  for (const key of TRANSFORM_KEYS) {
    if (transform[key] !== undefined && !isFiniteNumber(transform[key])) {
      errors.push(validationError(`${basePath}/${key}`, "invalid_axis_transform", `Axis transform ${key} must be a finite number.`));
    }
  }
  return errors;
}

/** Canonical comparison key for a transform; null when no parameter is stated. */
function transformSignature(transform: unknown): string | null {
  if (!isRecord(transform)) return null;
  const parts = TRANSFORM_KEYS
    .filter((key) => isFiniteNumber(transform[key]))
    .map((key) => `${key}=${Number(transform[key])}`);
  return parts.length === 0 ? null : parts.join(",");
}

/**
 * The divisor converts an FCS value into the domain the transform parameters
 * are stated in, so a zero, negative or non-finite one does not mean "no
 * conversion": it makes every mapped coordinate meaningless. Rejected here
 * rather than defended against at render time.
 */
function validateAxisInputDivisor(divisor: unknown, basePath: string): ValidationError[] {
  if (divisor === undefined) return [];
  if (!isFiniteNumber(divisor) || Number(divisor) <= 0) {
    return [validationError(basePath, "invalid_axis_input_divisor", "Axis inputDivisor must be a positive finite number.")];
  }
  return [];
}

type BoundsGroupSpec = { channel: string; scale: string; transform: string | null; inputDivisor: number };

// Structural only: scale and transform are compared here because that is pure data.
// Channel identity needs FCS parameter metadata and is checked in
// validateLayoutChannels, so a detector name and its marker alias are not
// rejected before metadata has had a chance to reconcile them.
function validatePanelAxis(
  axis: unknown,
  basePath: string,
  groups: Map<string, BoundsGroupSpec>,
  panelResolved: boolean,
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!isRecord(axis)) {
    return [validationError(basePath, "invalid_panel_axis", "Panel axis must be an object.")];
  }
  // An unresolved panel may have no readable channel; inventing one would assert a
  // parameter the source file did not supply.
  if (!asString(axis.channel) && panelResolved) {
    errors.push(validationError(`${basePath}/channel`, "missing_panel_axis_channel", "A resolved panel axis requires a channel."));
  }
  const scale = axis.scale === undefined ? undefined : asString(axis.scale);
  if (axis.scale !== undefined && (!scale || !AXIS_SCALES.has(scale))) {
    errors.push(validationError(`${basePath}/scale`, "invalid_axis_scale", "Axis scale must be linear, log, arcsinh, or biex."));
  }
  errors.push(...validateAxisTransform(axis.transform, `${basePath}/transform`));
  errors.push(...validateAxisInputDivisor(axis.inputDivisor, `${basePath}/inputDivisor`));
  if (axis.bounds !== undefined) errors.push(...validateAxisBounds(axis.bounds, `${basePath}/bounds`));

  const groupId = axis.boundsGroup === undefined ? undefined : asString(axis.boundsGroup);
  if (axis.boundsGroup !== undefined && !groupId) {
    errors.push(validationError(`${basePath}/boundsGroup`, "invalid_bounds_group_ref", "Axis boundsGroup must be a string id."));
  }
  if (!groupId) return errors;
  const group = groups.get(groupId);
  if (!group) {
    errors.push(validationError(`${basePath}/boundsGroup`, "unknown_bounds_group", `Bounds group ${groupId} is not defined on this layout.`));
    return errors;
  }
  if (scale !== undefined && scale !== group.scale) {
    errors.push(validationError(
      `${basePath}/scale`,
      "bounds_group_scale_mismatch",
      `Axis scale ${scale} does not match bounds group ${groupId} scale ${group.scale}.`,
    ));
    return errors;
  }
  // Bounds are stated in display units, so members must also agree on the input
  // domain: the same display number under two divisors is two different data
  // values, which is exactly what sharing an axis is supposed to prevent.
  const axisDivisor = isFiniteNumber(axis.inputDivisor) ? Number(axis.inputDivisor) : 1;
  if (axisDivisor !== group.inputDivisor) {
    errors.push(validationError(
      `${basePath}/inputDivisor`,
      "bounds_group_input_divisor_mismatch",
      `Axis inputDivisor ${axisDivisor} does not match bounds group ${groupId} inputDivisor ${group.inputDivisor}.`,
    ));
    return errors;
  }
  if (PARAMETERIZED_SCALES.has(group.scale)) {
    const axisTransform = transformSignature(axis.transform);
    if (group.transform === null || axisTransform === null) {
      errors.push(validationError(
        `${basePath}/transform`,
        "missing_axis_transform",
        `Bounds group ${groupId} uses ${group.scale}, so the group and every member axis must state transform parameters; a matching scale name alone does not establish that two transforms are the same.`,
      ));
    } else if (axisTransform !== group.transform) {
      errors.push(validationError(
        `${basePath}/transform`,
        "bounds_group_transform_mismatch",
        `Axis transform (${axisTransform}) does not match bounds group ${groupId} transform (${group.transform}).`,
      ));
    }
  }
  return errors;
}

/** Exact parameter name first, then detector and marker aliases. */
function resolveParameterName(metadata: SampleMetadata | undefined, channel: string): string | null {
  if (!metadata) return null;
  const token = normalizeDetectorToken(channel);
  for (const parameter of metadata.parameters) {
    if (normalizeDetectorToken(parameter.name) === token) return parameter.name;
  }
  for (const parameter of metadata.parameters) {
    if (parameter.detector && normalizeDetectorToken(parameter.detector) === token) return parameter.name;
    if (parameter.marker && normalizeDetectorToken(parameter.marker) === token) return parameter.name;
  }
  return null;
}

// Metadata-aware pass. Resolves each axis channel in every sample the panel
// actually plots, then checks bounds-group membership on resolved identity rather
// than on string equality. Skipped entirely when metadata could not be loaded, in
// which case sample_metadata_failed already blocks the write.
function validateLayoutChannels(
  layouts: unknown[],
  metadataBySample: Map<string, SampleMetadata>,
): ValidationError[] {
  if (metadataBySample.size === 0) return [];
  const errors: ValidationError[] = [];
  layouts.forEach((layout, layoutIndex) => {
    if (!isRecord(layout) || !Array.isArray(layout.panels)) return;
    const groupChannels = new Map<string, string>();
    for (const group of Array.isArray(layout.boundsGroups) ? layout.boundsGroups : []) {
      if (!isRecord(group)) continue;
      const id = asString(group.id);
      const channel = asString(group.channel);
      if (id && channel) groupChannels.set(id, channel);
    }
    layout.panels.forEach((panel, panelIndex) => {
      if (!isRecord(panel) || !Array.isArray(panel.sources)) return;
      const samples = panel.sources
        .filter(isRecord)
        .map((source) => asString(source.sample))
        .filter((sample): sample is string => Boolean(sample));
      const base = `/layouts/${layoutIndex}/panels/${panelIndex}`;
      for (const key of ["x", "y"] as const) {
        const axis = panel[key];
        if (!isRecord(axis)) continue;
        const channel = asString(axis.channel);
        if (!channel) continue;
        const groupId = asString(axis.boundsGroup);
        const groupChannel = groupId ? groupChannels.get(groupId) : undefined;
        for (const sample of samples) {
          const metadata = metadataBySample.get(sample);
          if (!metadata) continue;
          const resolved = resolveParameterName(metadata, channel);
          if (!resolved) {
            errors.push(validationError(
              `${base}/${key}/channel`,
              "unknown_parameter",
              `Parameter ${channel} is not present in sample ${sample}.`,
            ));
            continue;
          }
          if (!groupChannel) continue;
          const groupResolved = resolveParameterName(metadata, groupChannel);
          if (!groupResolved) {
            errors.push(validationError(
              `${base}/${key}/boundsGroup`,
              "unknown_parameter",
              `Bounds group ${groupId} channel ${groupChannel} is not present in sample ${sample}.`,
            ));
          } else if (groupResolved !== resolved) {
            errors.push(validationError(
              `${base}/${key}/channel`,
              "bounds_group_channel_mismatch",
              `Axis channel ${channel} resolves to ${resolved} in sample ${sample}, but bounds group ${groupId} channel ${groupChannel} resolves to ${groupResolved}.`,
            ));
          }
        }
      }
    });
  });
  return errors;
}

const PANEL_BLOCKER_REASONS = new Set(["unresolved_compensation", "unresolved_transform"]);

function validatePanelStatus(status: unknown, basePath: string): ValidationError[] {
  if (!isRecord(status)) {
    return [validationError(basePath, "missing_panel_status", "Panel status is required and must be an object.")];
  }
  const state = asString(status.state);
  if (state === "resolved") return [];
  if (state === "partial") {
    const blockers = Array.isArray(status.blockers) ? status.blockers : null;
    if (!blockers || blockers.length === 0) {
      return [validationError(
        `${basePath}/blockers`,
        "missing_panel_blockers",
        "A partial panel requires at least one blocker explaining why it cannot be rendered faithfully.",
      )];
    }
    return blockers.flatMap((blocker, blockerIndex) => {
      const blockerPath = `${basePath}/blockers/${blockerIndex}`;
      if (!isRecord(blocker)) {
        return [validationError(blockerPath, "invalid_panel_blocker", "Panel blocker must be an object.")];
      }
      const reason = asString(blocker.reason);
      const errors: ValidationError[] = [];
      if (!reason || !PANEL_BLOCKER_REASONS.has(reason)) {
        errors.push(validationError(
          `${blockerPath}/reason`,
          "invalid_panel_blocker_reason",
          `Panel blocker reason must be one of ${[...PANEL_BLOCKER_REASONS].join(", ")}.`,
        ));
      }
      if (!asString(blocker.detail)) {
        errors.push(validationError(`${blockerPath}/detail`, "missing_panel_blocker_detail", "Panel blocker requires a detail message."));
      }
      return errors;
    });
  }
  if (state !== "unresolved") {
    return [validationError(`${basePath}/state`, "invalid_panel_status", "Panel status state must be resolved, partial, or unresolved.")];
  }
  const errors: ValidationError[] = [];
  const reason = asString(status.reason);
  if (!reason || !PANEL_UNRESOLVED_REASONS.has(reason)) {
    errors.push(validationError(
      `${basePath}/reason`,
      "invalid_panel_status_reason",
      `Unresolved panel reason must be one of ${[...PANEL_UNRESOLVED_REASONS].join(", ")}.`,
    ));
  }
  if (!asString(status.detail)) {
    errors.push(validationError(`${basePath}/detail`, "missing_panel_status_detail", "Unresolved panel status requires a detail message."));
  }
  if (status.candidates !== undefined
    && (!Array.isArray(status.candidates) || status.candidates.some((entry) => typeof entry !== "string"))) {
    errors.push(validationError(`${basePath}/candidates`, "invalid_panel_status_candidates", "Panel status candidates must be an array of gate ids."));
  }
  return errors;
}

function validateLayoutShape(
  layout: unknown,
  index: number,
  context: { sampleIds: Set<string>; populationIds: Set<string>; gateIds: Set<string>; compensationIds: Set<string> },
): ValidationError[] {
  const base = `/layouts/${index}`;
  if (!isRecord(layout)) return [validationError(base, "invalid_layout", "Layout must be an object.")];
  const errors: ValidationError[] = [];

  if (!asString(layout.id)) errors.push(validationError(`${base}/id`, "missing_layout_id", "Layout id is required."));
  if (!asString(layout.name)) errors.push(validationError(`${base}/name`, "missing_layout_name", "Layout name is required."));
  const kind = asString(layout.kind);
  if (!kind || !LAYOUT_KINDS.has(kind)) {
    errors.push(validationError(`${base}/kind`, "invalid_layout_kind", "Layout kind must be gating_strategy, comparison, or freeform."));
  }
  const canvas = layout.canvas;
  if (!isRecord(canvas) || !isFiniteNumber(canvas.width) || !isFiniteNumber(canvas.height)
    || Number(canvas.width) <= 0 || Number(canvas.height) <= 0) {
    errors.push(validationError(`${base}/canvas`, "invalid_layout_canvas", "Layout canvas requires positive finite width and height."));
  }

  const groups = new Map<string, BoundsGroupSpec>();
  if (layout.boundsGroups !== undefined && !Array.isArray(layout.boundsGroups)) {
    errors.push(validationError(`${base}/boundsGroups`, "invalid_array", "boundsGroups must be an array when present."));
  }
  const boundsGroups = Array.isArray(layout.boundsGroups) ? layout.boundsGroups : [];
  boundsGroups.forEach((group, groupIndex) => {
    const groupPath = `${base}/boundsGroups/${groupIndex}`;
    if (!isRecord(group)) {
      errors.push(validationError(groupPath, "invalid_bounds_group", "Bounds group must be an object."));
      return;
    }
    const id = asString(group.id);
    const channel = asString(group.channel);
    const scale = asString(group.scale);
    if (!id) errors.push(validationError(`${groupPath}/id`, "missing_bounds_group_id", "Bounds group id is required."));
    if (id && groups.has(id)) errors.push(validationError(`${groupPath}/id`, "duplicate_bounds_group_id", `Duplicate bounds group id ${id}.`));
    if (!channel) errors.push(validationError(`${groupPath}/channel`, "missing_bounds_group_channel", "Bounds group channel is required."));
    if (!scale || !AXIS_SCALES.has(scale)) {
      errors.push(validationError(`${groupPath}/scale`, "invalid_axis_scale", "Bounds group scale must be linear, log, arcsinh, or biex."));
    }
    errors.push(...validateAxisTransform(group.transform, `${groupPath}/transform`));
    errors.push(...validateAxisInputDivisor(group.inputDivisor, `${groupPath}/inputDivisor`));
    errors.push(...validateAxisBounds(group.bounds, `${groupPath}/bounds`));
    if (scale && PARAMETERIZED_SCALES.has(scale) && transformSignature(group.transform) === null) {
      errors.push(validationError(
        `${groupPath}/transform`,
        "missing_axis_transform",
        `Bounds group ${id ?? groupIndex} uses ${scale}, so it must state transform parameters; a scale name alone does not identify a transform.`,
      ));
    }
    if (id && channel && scale) {
      groups.set(id, {
        channel,
        scale,
        transform: transformSignature(group.transform),
        inputDivisor: isFiniteNumber(group.inputDivisor) ? Number(group.inputDivisor) : 1,
      });
    }
  });

  if (!Array.isArray(layout.panels)) {
    errors.push(validationError(`${base}/panels`, "invalid_array", "Layout panels must be an array."));
    return errors;
  }

  const panelIds = new Set<string>();
  layout.panels.forEach((panel, panelIndex) => {
    const panelPath = `${base}/panels/${panelIndex}`;
    if (!isRecord(panel)) {
      errors.push(validationError(panelPath, "invalid_layout_panel", "Layout panel must be an object."));
      return;
    }
    const panelId = asString(panel.id);
    if (!panelId) errors.push(validationError(`${panelPath}/id`, "missing_panel_id", "Panel id is required."));
    if (panelId && panelIds.has(panelId)) {
      errors.push(validationError(`${panelPath}/id`, "duplicate_panel_id", `Duplicate panel id ${panelId}.`));
    }
    if (panelId) panelIds.add(panelId);

    // An unresolved panel is allowed to carry no sources and no size, since a
    // source requires a known sample and population, and a size that is absent
    // from the source file may not be invented to fill the gap.
    const panelResolved = !(isRecord(panel.status) && asString(panel.status.state) === "unresolved");
    const position = panel.position;
    if (!isRecord(position) || !isFiniteNumber(position.x) || !isFiniteNumber(position.y)
      || !isFiniteNumber(position.width) || !isFiniteNumber(position.height)
      || Number(position.width) < 0 || Number(position.height) < 0
      || (panelResolved && (Number(position.width) <= 0 || Number(position.height) <= 0))) {
      errors.push(validationError(
        `${panelPath}/position`,
        "invalid_panel_position",
        "Panel position requires finite x and y and non-negative width and height; a resolved panel requires both to be positive.",
      ));
    }
    if (!Array.isArray(panel.sources) || (panel.sources.length === 0 && panelResolved)) {
      errors.push(validationError(`${panelPath}/sources`, "missing_panel_sources", "A resolved panel requires at least one source."));
    } else {
      panel.sources.forEach((source, sourceIndex) => {
        const sourcePath = `${panelPath}/sources/${sourceIndex}`;
        if (!isRecord(source)) {
          errors.push(validationError(sourcePath, "invalid_panel_source", "Panel source must be an object."));
          return;
        }
        const sample = asString(source.sample);
        if (!sample) {
          errors.push(validationError(`${sourcePath}/sample`, "missing_sample_id", "Panel source sample is required."));
        } else if (!context.sampleIds.has(sample)) {
          errors.push(validationError(`${sourcePath}/sample`, "unknown_sample", `Sample ${sample} is not present.`));
        }
        const parent = asString(source.parent);
        if (!parent) {
          errors.push(validationError(`${sourcePath}/parent`, "missing_parent_gate", "Panel source parent is required; use \"root\" for the ungated population."));
        } else if (parent !== "root" && !context.populationIds.has(parent)) {
          errors.push(validationError(`${sourcePath}/parent`, "unknown_parent_gate", `Parent population ${parent} is not present.`));
        }
        const gate = source.gate === undefined ? undefined : asString(source.gate);
        if (source.gate !== undefined && (!gate || !context.gateIds.has(gate))) {
          errors.push(validationError(`${sourcePath}/gate`, "unknown_gate", `Gate ${String(source.gate)} is not present.`));
        }
        const compensationId = source.compensationId === undefined ? undefined : asString(source.compensationId);
        if (source.compensationId !== undefined && (!compensationId || !context.compensationIds.has(compensationId))) {
          errors.push(validationError(`${sourcePath}/compensationId`, "unknown_compensation_id", `Compensation ${String(source.compensationId)} is not present.`));
        }
        if (source.unresolvedCompensation !== undefined) {
          const unresolved = isRecord(source.unresolvedCompensation) ? source.unresolvedCompensation : null;
          if (!unresolved || !asString(unresolved.reference) || !asString(unresolved.detail)) {
            errors.push(validationError(
              `${sourcePath}/unresolvedCompensation`,
              "invalid_unresolved_compensation",
              "unresolvedCompensation requires a reference and a detail describing why it could not be bound.",
            ));
          }
          if (source.compensationId !== undefined) {
            errors.push(validationError(
              `${sourcePath}/unresolvedCompensation`,
              "conflicting_compensation_state",
              "A source cannot both resolve a compensationId and carry an unresolved compensation reference.",
            ));
          }
        }
      });
    }

    errors.push(...validatePanelAxis(panel.x, `${panelPath}/x`, groups, panelResolved));
    if (panel.y !== undefined) errors.push(...validatePanelAxis(panel.y, `${panelPath}/y`, groups, panelResolved));

    const plotType = panel.plotType === undefined ? undefined : asString(panel.plotType);
    if (panel.plotType !== undefined && (!plotType || !LAYOUT_PLOT_TYPES.has(plotType))) {
      errors.push(validationError(`${panelPath}/plotType`, "invalid_plot_type", "Panel plotType must be pseudocolor, dot, contour, or histogram."));
    }
    if (plotType === "histogram" && panel.y !== undefined) {
      errors.push(validationError(`${panelPath}/y`, "histogram_with_y_axis", "A histogram panel must not define a y axis."));
    }

    errors.push(...validatePanelStatus(panel.status, `${panelPath}/status`));
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
  const parentPopulationIds = new Set<string>();
  const quadrantPopulationParent = new Map<string, string>();
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
      errors.push(validationError(`/gates/${index}`, "invalid_gate", "Gate must be a polygon, rect, range, or quadrant gate object."));
      return;
    }
    if (!asString(gate.id)) errors.push(validationError(`/gates/${index}/id`, "missing_gate_id", "Gate id is required."));
    if (gateIds.has(gate.id)) errors.push(validationError(`/gates/${index}/id`, "duplicate_gate_id", `Duplicate gate id ${gate.id}.`));
    gateIds.add(gate.id);
    if (gate.type !== "quadrant") parentPopulationIds.add(gate.id);
    if (gate.type === "quadrant" && Array.isArray(gate.quadrants)) {
      gate.quadrants.forEach((population, populationIndex) => {
        const id = isRecord(population) ? asString(population.id) : null;
        if (!id) return;
        if (gateIds.has(id)) {
          errors.push(validationError(`/gates/${index}/quadrants/${populationIndex}/id`, "duplicate_gate_id", `Duplicate gate or quadrant population id ${id}.`));
        }
        gateIds.add(id);
        parentPopulationIds.add(id);
        quadrantPopulationParent.set(id, gate.parent);
      });
    }
  });

  gates.forEach((rawGate, index) => {
    const gate = validateGateShape(rawGate, index);
    if (!gate) return;
    if (!sampleIds.has(gate.sample)) errors.push(validationError(`/gates/${index}/sample`, "unknown_sample", `Sample ${gate.sample} is not present.`));
    if (gate.parent !== "root" && !parentPopulationIds.has(gate.parent)) {
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
    if (gate.type === "quadrant") {
      if (!parameters.has(gate.x)) errors.push(validationError(`/gates/${index}/x`, "unknown_parameter", `Parameter ${gate.x} is not present in sample ${gate.sample}.`));
      if (!parameters.has(gate.y)) errors.push(validationError(`/gates/${index}/y`, "unknown_parameter", `Parameter ${gate.y} is not present in sample ${gate.sample}.`));
      if (!isFiniteNumber(gate.xThreshold)) {
        errors.push(validationError(`/gates/${index}/xThreshold`, "invalid_quadrant_threshold", "Quadrant xThreshold must be finite."));
      }
      if (!isFiniteNumber(gate.yThreshold)) {
        errors.push(validationError(`/gates/${index}/yThreshold`, "invalid_quadrant_threshold", "Quadrant yThreshold must be finite."));
      }
      if (!Array.isArray(gate.quadrants) || gate.quadrants.length !== 4) {
        errors.push(validationError(`/gates/${index}/quadrants`, "invalid_quadrant_populations", "Quadrant gates require exactly four populations."));
      } else {
        const positions = new Set<string>();
        gate.quadrants.forEach((population, populationIndex) => {
          if (!isRecord(population)) {
            errors.push(validationError(`/gates/${index}/quadrants/${populationIndex}`, "invalid_quadrant_population", "Quadrant population must be an object."));
            return;
          }
          const id = asString(population.id);
          if (!id) errors.push(validationError(`/gates/${index}/quadrants/${populationIndex}/id`, "missing_gate_id", "Quadrant population id is required."));
          const xSign = asString(population.x);
          const ySign = asString(population.y);
          if ((xSign !== "-" && xSign !== "+") || (ySign !== "-" && ySign !== "+")) {
            errors.push(validationError(`/gates/${index}/quadrants/${populationIndex}`, "invalid_quadrant_position", "Quadrant population x and y must each be '-' or '+'."));
            return;
          }
          const position = `${xSign}${ySign}`;
          if (positions.has(position)) {
            errors.push(validationError(`/gates/${index}/quadrants/${populationIndex}`, "duplicate_quadrant_position", `Quadrant position ${position} is duplicated.`));
          }
          positions.add(position);
        });
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

  if (candidate.layouts !== undefined && !Array.isArray(candidate.layouts)) {
    errors.push(validationError("/layouts", "invalid_array", "layouts must be an array when present."));
  }
  const layouts = Array.isArray(candidate.layouts) ? candidate.layouts : [];
  const layoutIds = new Set<string>();
  layouts.forEach((layout, index) => {
    errors.push(...validateLayoutShape(layout, index, {
      sampleIds,
      populationIds: parentPopulationIds,
      gateIds,
      compensationIds,
    }));
    if (!isRecord(layout)) return;
    const id = asString(layout.id);
    if (id && layoutIds.has(id)) errors.push(validationError(`/layouts/${index}/id`, "duplicate_layout_id", `Duplicate layout id ${id}.`));
    if (id) layoutIds.add(id);
  });
  errors.push(...validateLayoutChannels(layouts, metadataBySample));

  const storedGateById = new Map(gates.filter(isRecord).map((gate) => [asString(gate.id), gate]));
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
      const next = storedGateById.get(cursorParent);
      if (next && next.type === "quadrant") break;
      if (next) {
        cursor = next;
        continue;
      }
      const quadrantParent = quadrantPopulationParent.get(cursorParent);
      cursor = quadrantParent ? { id: cursorParent, parent: quadrantParent } : undefined;
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
    if (parent && parent !== "root" && !parentPopulationIds.has(parent)) {
      errors.push(validationError(`/views/${index}/parent`, "unknown_parent_gate", `Parent gate ${parent} is not present.`));
    }
    const metadata = sample ? metadataBySample.get(sample) : undefined;
    const parameters = new Set(metadata?.parameters.map((parameter) => parameter.name) ?? []);
    const x = asString(view.x);
    const y = asString(view.y);
    if (!x || !parameters.has(x)) errors.push(validationError(`/views/${index}/x`, "unknown_parameter", `Parameter ${String(view.x)} is not present.`));
    if (!y || !parameters.has(y)) errors.push(validationError(`/views/${index}/y`, "unknown_parameter", `Parameter ${String(view.y)} is not present.`));
    const scale = isRecord(view.scale) ? view.scale : null;
    const validScales = new Set(["linear", "log", "arcsinh", "biex"]);
    if (!scale || !validScales.has(String(scale.x))) errors.push(validationError(`/views/${index}/scale/x`, "invalid_scale", `Scale ${String(scale?.x)} is not supported.`));
    if (!scale || !validScales.has(String(scale.y))) errors.push(validationError(`/views/${index}/scale/y`, "invalid_scale", `Scale ${String(scale?.y)} is not supported.`));
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
  await renameWithTransientRetry(temp, target);
}

function isTransientRenameError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.code === "EPERM" || error.code === "EACCES";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameWithTransientRetry(source: string, target: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      if (process.platform !== "win32" || !isTransientRenameError(error)) throw error;
      await delay(15 * (attempt + 1));
    }
  }
  throw lastError;
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

export async function upsertView(params: {
  workspacePath: string;
  view: FlowcytoView;
  expectedRevision: number;
}): Promise<ValidationResult & { revision?: number; view?: FlowcytoView }> {
  const workspace = await readWorkspace(params.workspacePath);
  const views = workspace.views.filter((view) => view.id !== params.view.id);
  const result = await writeWorkspace({
    workspacePath: params.workspacePath,
    expectedRevision: params.expectedRevision,
    workspace: { ...workspace, views: [...views, params.view] },
  });
  return result.ok ? { ...result, view: params.view } : result;
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
