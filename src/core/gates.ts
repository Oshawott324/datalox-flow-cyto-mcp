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
