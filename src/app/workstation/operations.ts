import { randomBytes } from "node:crypto";

import {
  FlowcytoError,
  type AxisSetting,
  type CompensationMatrix,
  type FlowcytoWorkspace,
  type WorkspaceGate,
  type WorkspaceGroup,
  type WorkspaceGroupRole,
} from "../../core/index.js";

/**
 * Every change the workstation makes to a workspace is one of these operations.
 * Each one is a pure function from a workspace to the next workspace, so the
 * server can apply it, write the result once and journal it as one revision.
 */
export type WorkstationOperation =
  | { op: "gate.save"; gate: WorkspaceGate }
  | { op: "gate.delete"; gateId: string }
  | { op: "gates.restore"; gates: WorkspaceGate[] }
  | { op: "population.rename"; populationId: string; name: string }
  | { op: "population.copy"; sampleId: string; populationId: string; targetSamples: string[] }
  | { op: "compensation.save"; compensation: CompensationMatrix }
  | { op: "compensation.delete"; compensationId: string }
  | { op: "compensation.apply"; compensationId: string | null; samples: string[] }
  | { op: "group.create"; name: string; samples: string[]; role?: WorkspaceGroupRole }
  | { op: "group.update"; groupId: string; name?: string; samples?: string[]; role?: WorkspaceGroupRole }
  | { op: "group.delete"; groupId: string }
  | { op: "axis.set"; parameter: string; setting: AxisSetting | null };

export type OperationResult = {
  workspace: FlowcytoWorkspace;
  /** What the operation did, for the caller and the journal. */
  detail: Record<string, unknown>;
};

export function newId(prefix: string): string {
  const slug = prefix.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "id";
  return `${slug}_${randomBytes(4).toString("hex")}`;
}

function fail(code: string, message: string, path = "/"): never {
  throw new FlowcytoError(code, message, path);
}

/** The gate that defines a population: the gate itself, or the quadrant gate holding a quadrant population. */
export function gateOfPopulation(workspace: FlowcytoWorkspace, populationId: string): WorkspaceGate | undefined {
  return workspace.gates.find((gate) => gate.id === populationId
    || (gate.type === "quadrant" && gate.quadrants.some((population) => population.id === populationId)));
}

function populationIdsOf(gate: WorkspaceGate): string[] {
  return gate.type === "quadrant" ? gate.quadrants.map((population) => population.id) : [gate.id];
}

/** The gate and every gate below any population it defines. */
export function gateSubtree(workspace: FlowcytoWorkspace, gate: WorkspaceGate): WorkspaceGate[] {
  const out: WorkspaceGate[] = [gate];
  const parents = new Set(populationIdsOf(gate));
  for (let added = true; added;) {
    added = false;
    for (const candidate of workspace.gates) {
      if (out.includes(candidate) || !parents.has(candidate.parent)) continue;
      out.push(candidate);
      populationIdsOf(candidate).forEach((id) => parents.add(id));
      added = true;
    }
  }
  return out;
}

/** Gates from the top of the tree down to the gate that defines `populationId`, inclusive. */
function ancestorGates(workspace: FlowcytoWorkspace, populationId: string): WorkspaceGate[] {
  const chain: WorkspaceGate[] = [];
  let cursor = populationId;
  while (cursor !== "root") {
    const gate = gateOfPopulation(workspace, cursor);
    if (!gate || chain.includes(gate)) fail("unknown_population", `Population ${cursor} is not present.`);
    chain.unshift(gate);
    cursor = gate.parent;
  }
  return chain;
}

function populationName(workspace: FlowcytoWorkspace, populationId: string): string {
  const gate = gateOfPopulation(workspace, populationId);
  if (!gate) return populationId;
  if (gate.type === "quadrant") return gate.quadrants.find((entry) => entry.id === populationId)?.name ?? populationId;
  return gate.name ?? gate.id;
}

/** Names from the top of the tree down to a population: how FlowJo matches populations across samples. */
export function populationNamePath(workspace: FlowcytoWorkspace, populationId: string): string[] {
  const names: string[] = [];
  let cursor = populationId;
  const seen = new Set<string>();
  while (cursor !== "root" && !seen.has(cursor)) {
    seen.add(cursor);
    names.unshift(populationName(workspace, cursor));
    cursor = gateOfPopulation(workspace, cursor)?.parent ?? "root";
  }
  return names;
}

/** A gate's identity inside its sample: its parent's name path plus its own name (or its quadrant names). */
function gateKey(workspace: FlowcytoWorkspace, gate: WorkspaceGate): string {
  const parentPath = gate.parent === "root" ? [] : populationNamePath(workspace, gate.parent);
  const own = gate.type === "quadrant"
    ? `quadrant:${gate.quadrants.map((population) => population.name ?? population.id).sort().join("|")}`
    : `gate:${gate.name ?? gate.id}`;
  return JSON.stringify([...parentPath, own]);
}

function copyPopulation(
  workspace: FlowcytoWorkspace,
  input: { sampleId: string; populationId: string; targetSamples: string[] },
): OperationResult {
  const source = gateOfPopulation(workspace, input.populationId);
  if (!source || source.sample !== input.sampleId) {
    fail("unknown_population", `Population ${input.populationId} is not in sample ${input.sampleId}.`, "/populationId");
  }
  const sampleIds = new Set(workspace.samples.map((sample) => sample.id));
  const targets = [...new Set(input.targetSamples)].filter((id) => id !== input.sampleId);
  const missing = targets.filter((id) => !sampleIds.has(id));
  if (missing.length > 0) fail("unknown_sample", `Sample(s) not present: ${missing.join(", ")}.`, "/targetSamples");

  // Gates above the population are matched by name path and created only where missing;
  // the population and everything below it replace any same-named gates in the target.
  const ancestors = ancestorGates(workspace, input.populationId).slice(0, -1);
  const subtree = gateSubtree(workspace, source);
  const sourceGates = [...ancestors, ...subtree];
  let next: FlowcytoWorkspace = { ...workspace, gates: [...workspace.gates] };
  let created = 0;
  let replaced = 0;
  for (const target of targets) {
    const idMap = new Map<string, string>();
    for (const gate of sourceGates) {
      const key = gateKey(workspace, gate);
      const existing = next.gates.find((candidate) => candidate.sample === target && gateKey(next, candidate) === key);
      const isAncestor = ancestors.includes(gate);
      const parent = gate.parent === "root" ? "root" : idMap.get(gate.parent);
      if (!parent) fail("copy_parent_missing", `Parent of ${gate.name ?? gate.id} could not be placed in ${target}.`);
      if (existing && isAncestor) {
        populationIdsOf(gate).forEach((id, index) => idMap.set(id, populationIdsOf(existing)[index] ?? id));
        if (existing.type === "quadrant" && gate.type === "quadrant") {
          for (const population of gate.quadrants) {
            const match = existing.quadrants.find((entry) => (entry.name ?? entry.id) === (population.name ?? population.id));
            if (match) idMap.set(population.id, match.id);
          }
        }
        continue;
      }
      const id = existing && existing.type === gate.type ? existing.id : newId(gate.name ?? gate.type);
      idMap.set(gate.id, id);
      let copy: WorkspaceGate;
      if (gate.type === "quadrant") {
        const quadrants = gate.quadrants.map((population) => {
          const match = existing?.type === "quadrant"
            ? existing.quadrants.find((entry) => (entry.name ?? entry.id) === (population.name ?? population.id))
            : undefined;
          const populationId = match?.id ?? newId(population.name ?? "quadrant");
          idMap.set(population.id, populationId);
          return { ...population, id: populationId };
        });
        copy = { ...gate, id, sample: target, parent, quadrants };
      } else {
        copy = { ...gate, id, sample: target, parent };
      }
      if (existing) {
        next.gates = next.gates.map((candidate) => (candidate === existing ? copy : candidate));
        replaced += 1;
      } else {
        next.gates.push(copy);
        created += 1;
      }
      next = { ...next };
    }
  }
  return { workspace: next, detail: { sampleId: input.sampleId, populationId: input.populationId, targets, created, replaced } };
}

function requireSamples(workspace: FlowcytoWorkspace, samples: string[], path: string): void {
  const known = new Set(workspace.samples.map((sample) => sample.id));
  const missing = samples.filter((id) => !known.has(id));
  if (missing.length > 0) fail("unknown_sample", `Sample(s) not present: ${missing.join(", ")}.`, path);
}

export function applyOperation(workspace: FlowcytoWorkspace, operation: WorkstationOperation): OperationResult {
  switch (operation.op) {
    case "gate.save": {
      const gate = operation.gate;
      if (!gate || typeof gate.id !== "string" || !gate.id) fail("missing_gate", "A gate with an id is required.", "/gate");
      const exists = workspace.gates.some((entry) => entry.id === gate.id);
      const gates = exists ? workspace.gates.map((entry) => (entry.id === gate.id ? gate : entry)) : [...workspace.gates, gate];
      return { workspace: { ...workspace, gates }, detail: { gateId: gate.id, sampleId: gate.sample, type: gate.type, created: !exists } };
    }
    case "gate.delete": {
      const gate = workspace.gates.find((entry) => entry.id === operation.gateId);
      if (!gate) fail("unknown_gate", `Gate ${operation.gateId} is not present.`, "/gateId");
      const removed = gateSubtree(workspace, gate);
      return {
        workspace: { ...workspace, gates: workspace.gates.filter((entry) => !removed.includes(entry)) },
        detail: { gateId: gate.id, sampleId: gate.sample, removed },
      };
    }
    case "gates.restore": {
      const ids = new Set(operation.gates.map((gate) => gate.id));
      return {
        workspace: { ...workspace, gates: [...workspace.gates.filter((gate) => !ids.has(gate.id)), ...operation.gates] },
        detail: { gateIds: [...ids] },
      };
    }
    case "population.rename": {
      const name = operation.name.trim();
      if (!name) fail("missing_name", "A name is required.", "/name");
      const gate = gateOfPopulation(workspace, operation.populationId);
      if (!gate) fail("unknown_population", `Population ${operation.populationId} is not present.`, "/populationId");
      const renamed: WorkspaceGate = gate.type === "quadrant" && gate.id !== operation.populationId
        ? { ...gate, quadrants: gate.quadrants.map((entry) => (entry.id === operation.populationId ? { ...entry, name } : entry)) }
        : { ...gate, name };
      return {
        workspace: { ...workspace, gates: workspace.gates.map((entry) => (entry === gate ? renamed : entry)) },
        detail: { populationId: operation.populationId, name },
      };
    }
    case "population.copy":
      return copyPopulation(workspace, operation);
    case "compensation.save": {
      const matrix = operation.compensation;
      if (!matrix?.id) fail("missing_compensation_id", "A compensation id is required.", "/compensation/id");
      const existing = (workspace.compensations ?? []).find((entry) => entry.id === matrix.id);
      if (existing?.source === "fcs_keyword") {
        fail("acquisition_matrix_read_only", "The acquisition matrix stored in the FCS file cannot be changed. Edit a copy instead.", "/compensation/id");
      }
      const size = matrix.channels.length;
      if (size === 0 || matrix.matrix.length !== size || matrix.matrix.some((row) => row.length !== size || row.some((value) => !Number.isFinite(value)))) {
        fail("invalid_compensation_matrix", "The matrix must be square, one row and column per parameter, with a number in every cell.", "/compensation/matrix");
      }
      const compensations = [...(workspace.compensations ?? []).filter((entry) => entry.id !== matrix.id), matrix];
      return { workspace: { ...workspace, compensations }, detail: { compensationId: matrix.id, created: !existing } };
    }
    case "compensation.delete": {
      const existing = (workspace.compensations ?? []).find((entry) => entry.id === operation.compensationId);
      if (!existing) fail("unknown_compensation", `Compensation ${operation.compensationId} is not present.`, "/compensationId");
      if (existing.source === "fcs_keyword") fail("acquisition_matrix_read_only", "The acquisition matrix cannot be deleted.", "/compensationId");
      const sampleCompensation = Object.fromEntries(Object.entries(workspace.sampleCompensation ?? {})
        .filter(([, id]) => id !== operation.compensationId));
      return {
        workspace: { ...workspace, compensations: (workspace.compensations ?? []).filter((entry) => entry !== existing), sampleCompensation },
        detail: { compensationId: operation.compensationId },
      };
    }
    case "compensation.apply": {
      requireSamples(workspace, operation.samples, "/samples");
      const sampleCompensation = { ...(workspace.sampleCompensation ?? {}) };
      for (const sample of operation.samples) {
        if (operation.compensationId === null) delete sampleCompensation[sample];
        else sampleCompensation[sample] = operation.compensationId;
      }
      return { workspace: { ...workspace, sampleCompensation }, detail: { compensationId: operation.compensationId, samples: operation.samples } };
    }
    case "group.create": {
      const name = operation.name.trim();
      if (!name) fail("missing_group_name", "A group name is required.", "/name");
      requireSamples(workspace, operation.samples, "/samples");
      const group: WorkspaceGroup = { id: newId(name), name, role: operation.role ?? "test", samples: [...new Set(operation.samples)] };
      return { workspace: { ...workspace, groups: [...(workspace.groups ?? []), group] }, detail: { groupId: group.id, name } };
    }
    case "group.update": {
      const group = (workspace.groups ?? []).find((entry) => entry.id === operation.groupId);
      if (!group) fail("unknown_group", `Group ${operation.groupId} is not present.`, "/groupId");
      if (operation.samples) requireSamples(workspace, operation.samples, "/samples");
      const updated: WorkspaceGroup = {
        ...group,
        ...(operation.name !== undefined ? { name: operation.name.trim() || group.name } : {}),
        ...(operation.role !== undefined ? { role: operation.role } : {}),
        ...(operation.samples !== undefined ? { samples: [...new Set(operation.samples)] } : {}),
      };
      return {
        workspace: { ...workspace, groups: (workspace.groups ?? []).map((entry) => (entry === group ? updated : entry)) },
        detail: { groupId: group.id },
      };
    }
    case "group.delete": {
      if (!(workspace.groups ?? []).some((entry) => entry.id === operation.groupId)) {
        fail("unknown_group", `Group ${operation.groupId} is not present.`, "/groupId");
      }
      return {
        workspace: { ...workspace, groups: (workspace.groups ?? []).filter((entry) => entry.id !== operation.groupId) },
        detail: { groupId: operation.groupId },
      };
    }
    case "axis.set": {
      const axes = { ...(workspace.axes ?? {}) };
      if (operation.setting === null) delete axes[operation.parameter];
      else axes[operation.parameter] = operation.setting;
      return { workspace: { ...workspace, axes }, detail: { parameter: operation.parameter } };
    }
    default:
      return fail("unknown_operation", `Unknown operation ${(operation as { op?: unknown }).op}.`, "/op");
  }
}
