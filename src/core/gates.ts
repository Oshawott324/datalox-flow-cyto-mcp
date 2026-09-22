import { FlowcytoError, type FlowcytoWorkspace, type ValidationResult, type WorkspaceGate } from "./types.js";
import { readWorkspace, writeWorkspace } from "./workspace.js";

function gateError(path: string, code: string, message: string): ValidationResult {
  return {
    ok: false,
    errors: [{ path, code, message }],
  };
}

function requireExpectedRevision(expectedRevision: number | undefined): number {
  if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision)) {
    throw new FlowcytoError(
      "missing_expected_revision",
      "Gate edits require expectedRevision so UI and agent writes cannot silently overwrite each other.",
      "/revision",
    );
  }
  return expectedRevision;
}

function sanitizeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "id";
}

function propagatedGateId(sourceGateId: string, sampleId: string): string {
  return `${sanitizeIdPart(sourceGateId)}__${sanitizeIdPart(sampleId)}`;
}

function cloneGateForSample(gate: WorkspaceGate, sampleId: string, idMap: Map<string, string>): WorkspaceGate {
  const id = idMap.get(gate.id) ?? propagatedGateId(gate.id, sampleId);
  const parent = gate.parent === "root" ? "root" : idMap.get(gate.parent) ?? propagatedGateId(gate.parent, sampleId);
  if (gate.type === "quadrant") {
    return {
      ...gate,
      id,
      sample: sampleId,
      parent,
      quadrants: gate.quadrants.map((population) => ({
        ...population,
        id: idMap.get(population.id) ?? propagatedGateId(population.id, sampleId),
      })),
    };
  }
  return { ...gate, id, sample: sampleId, parent };
}

export async function upsertGate(params: {
  workspacePath: string;
  gate: WorkspaceGate;
  expectedRevision: number;
}): Promise<ValidationResult & { revision?: number; gate?: WorkspaceGate; gateCount?: number; workspacePath?: string }> {
  const expectedRevision = requireExpectedRevision(params.expectedRevision);
  const workspace = await readWorkspace(params.workspacePath);
  const next: FlowcytoWorkspace = {
    ...workspace,
    gates: [...workspace.gates],
  };
  const existingIndex = next.gates.findIndex((gate) => gate.id === params.gate.id);
  if (existingIndex === -1) {
    next.gates.push(params.gate);
  } else {
    next.gates[existingIndex] = params.gate;
  }
  const result = await writeWorkspace({ workspacePath: params.workspacePath, workspace: next, expectedRevision });
  return result.ok ? { ...result, gate: params.gate, gateCount: next.gates.length, workspacePath: params.workspacePath } : result;
}

export async function upsertGates(params: {
  workspacePath: string;
  gates: WorkspaceGate[];
  expectedRevision: number;
}): Promise<ValidationResult & { revision?: number; gates?: WorkspaceGate[]; gateCount?: number; workspacePath?: string }> {
  const expectedRevision = requireExpectedRevision(params.expectedRevision);
  const workspace = await readWorkspace(params.workspacePath);
  const next: FlowcytoWorkspace = {
    ...workspace,
    gates: [...workspace.gates],
  };
  for (const gate of params.gates) {
    const existingIndex = next.gates.findIndex((entry) => entry.id === gate.id);
    if (existingIndex === -1) {
      next.gates.push(gate);
    } else {
      next.gates[existingIndex] = gate;
    }
  }
  const result = await writeWorkspace({ workspacePath: params.workspacePath, workspace: next, expectedRevision });
  return result.ok ? { ...result, gates: params.gates, gateCount: next.gates.length, workspacePath: params.workspacePath } : result;
}

export async function propagateGates(params: {
  workspacePath: string;
  sourceGateIds: string[];
  targetSampleIds: string[];
  expectedRevision: number;
}): Promise<ValidationResult & {
  revision?: number;
  gates?: WorkspaceGate[];
  gateCount?: number;
  propagatedCount?: number;
  workspacePath?: string;
}> {
  const expectedRevision = requireExpectedRevision(params.expectedRevision);
  const workspace = await readWorkspace(params.workspacePath);
  const sourceGateIds = [...new Set(params.sourceGateIds)];
  const targetSampleIds = [...new Set(params.targetSampleIds)];
  if (sourceGateIds.length === 0) return gateError("/source_gate_ids", "missing_source_gates", "At least one source gate id is required.");
  if (targetSampleIds.length === 0) return gateError("/target_sample_ids", "missing_target_samples", "At least one target sample id is required.");

  const gatesById = new Map(workspace.gates.map((gate) => [gate.id, gate]));
  const missingGates = sourceGateIds.filter((id) => !gatesById.has(id));
  if (missingGates.length > 0) return gateError("/source_gate_ids", "unknown_gate", `Source gate(s) not found: ${missingGates.join(", ")}.`);

  const sampleIds = new Set(workspace.samples.map((sample) => sample.id));
  const missingSamples = targetSampleIds.filter((id) => !sampleIds.has(id));
  if (missingSamples.length > 0) return gateError("/target_sample_ids", "unknown_sample", `Target sample(s) not found: ${missingSamples.join(", ")}.`);

  const sourceGates = sourceGateIds.map((id) => gatesById.get(id) as WorkspaceGate);
  const selectedSourceIds = new Set(sourceGateIds);
  for (const gate of sourceGates) {
    if (gate.type === "quadrant") {
      for (const population of gate.quadrants) selectedSourceIds.add(population.id);
    }
  }
  const sourceSamples = new Set(sourceGates.map((gate) => gate.sample));
  const sourceSamplesInTargets = targetSampleIds.filter((sampleId) => sourceSamples.has(sampleId));
  if (sourceSamplesInTargets.length > 0) {
    return gateError(
      "/target_sample_ids",
      "source_sample_target",
      `Target samples already contain source gates: ${sourceSamplesInTargets.join(", ")}.`,
    );
  }

  const missingParents = sourceGates
    .filter((gate) => gate.parent !== "root" && !selectedSourceIds.has(gate.parent))
    .map((gate) => `${gate.id}->${gate.parent}`);
  if (missingParents.length > 0) {
    return gateError(
      "/source_gate_ids",
      "missing_source_parent_gate",
      `Propagating child gates requires their selected parents too: ${missingParents.join(", ")}.`,
    );
  }

  const propagated: WorkspaceGate[] = [];
  for (const sampleId of targetSampleIds) {
    const sourcePopulationIds = sourceGates.flatMap((gate) => [
      gate.id,
      ...(gate.type === "quadrant" ? gate.quadrants.map((population) => population.id) : []),
    ]);
    const idMap = new Map(sourcePopulationIds.map((id) => [id, propagatedGateId(id, sampleId)]));
    for (const gate of sourceGates) propagated.push(cloneGateForSample(gate, sampleId, idMap));
  }

  const next: FlowcytoWorkspace = {
    ...workspace,
    gates: [...workspace.gates],
  };
  for (const gate of propagated) {
    const existingIndex = next.gates.findIndex((entry) => entry.id === gate.id);
    if (existingIndex === -1) next.gates.push(gate);
    else next.gates[existingIndex] = gate;
  }

  const result = await writeWorkspace({ workspacePath: params.workspacePath, workspace: next, expectedRevision });
  return result.ok ? {
    ...result,
    gates: propagated,
    gateCount: next.gates.length,
    propagatedCount: propagated.length,
    workspacePath: params.workspacePath,
  } : result;
}

export async function deleteGate(params: {
  workspacePath: string;
  gateId: string;
  expectedRevision: number;
}): Promise<ValidationResult & { revision?: number; gateCount?: number; gateId?: string; workspacePath?: string }> {
  const expectedRevision = requireExpectedRevision(params.expectedRevision);
  const workspace = await readWorkspace(params.workspacePath);
  const existingIndex = workspace.gates.findIndex((gate) => gate.id === params.gateId);
  if (existingIndex === -1) {
    return gateError("/gates", "unknown_gate", `Gate ${params.gateId} is not present.`);
  }
  const next: FlowcytoWorkspace = {
    ...workspace,
    gates: workspace.gates.filter((gate) => gate.id !== params.gateId),
  };
  const result = await writeWorkspace({ workspacePath: params.workspacePath, workspace: next, expectedRevision });
  return result.ok ? { ...result, gateCount: next.gates.length, gateId: params.gateId, workspacePath: params.workspacePath } : result;
}
