import {
  FlowcytoError,
  type EvaluableGate,
  type FlowcytoWorkspace,
  type QuadrantGate,
  type QuadrantPopulation,
  type WorkspaceGate,
} from "./types.js";

export type QuadrantPopulationMatch = {
  gate: QuadrantGate;
  population: QuadrantPopulation;
};

export function quadrantPopulationMatch(
  workspace: FlowcytoWorkspace,
  populationId: string,
): QuadrantPopulationMatch | undefined {
  for (const gate of workspace.gates) {
    if (gate.type !== "quadrant") continue;
    const population = gate.quadrants.find((entry) => entry.id === populationId);
    if (population) return { gate, population };
  }
  return undefined;
}

export function quadrantRegionGate(match: QuadrantPopulationMatch): EvaluableGate {
  return {
    id: match.population.id,
    name: match.population.name,
    sample: match.gate.sample,
    parent: match.gate.parent,
    enabled: match.gate.enabled,
    type: "quadrant_region",
    quadrantGateId: match.gate.id,
    x: match.gate.x,
    y: match.gate.y,
    xThreshold: match.gate.xThreshold,
    yThreshold: match.gate.yThreshold,
    xSign: match.population.x,
    ySign: match.population.y,
  };
}

export function populationParentId(workspace: FlowcytoWorkspace, populationId: string): string | undefined {
  const gate = workspace.gates.find((entry) => entry.id === populationId);
  if (gate) return gate.type === "quadrant" ? undefined : gate.parent;
  return quadrantPopulationMatch(workspace, populationId)?.gate.parent;
}

export function resolveParentGateChain(
  workspace: FlowcytoWorkspace,
  input: { sampleId: string; parent: string; path?: string },
): EvaluableGate[] {
  if (input.parent === "root") return [];
  const byId = new Map(workspace.gates.map((gate) => [gate.id, gate]));
  const chain: EvaluableGate[] = [];
  const seen = new Set<string>();
  let cursor = input.parent;
  while (cursor !== "root") {
    if (seen.has(cursor)) {
      throw new FlowcytoError("parent_ancestry_broken", `Parent gate ancestry contains a cycle at ${cursor}.`, input.path ?? "/parent_gate_id");
    }
    seen.add(cursor);
    const storedGate: WorkspaceGate | undefined = byId.get(cursor);
    const quadrantMatch = storedGate ? undefined : quadrantPopulationMatch(workspace, cursor);
    if (storedGate?.type === "quadrant") {
      throw new FlowcytoError(
        "quadrant_container_not_population",
        `Quadrant gate ${cursor} is a coupled container. Use one of its quadrant population ids as the parent.`,
        input.path ?? "/parent_gate_id",
      );
    }
    const gate = storedGate ?? (quadrantMatch ? quadrantRegionGate(quadrantMatch) : undefined);
    if (!gate) {
      throw new FlowcytoError("unknown_parent_gate", `Parent gate ${cursor} is not present.`, input.path ?? "/parent_gate_id");
    }
    if (gate.sample !== input.sampleId) {
      throw new FlowcytoError(
        "parent_ancestry_broken",
        `Parent gate ${cursor} belongs to sample ${gate.sample}, not ${input.sampleId}.`,
        input.path ?? "/parent_gate_id",
      );
    }
    chain.push(gate);
    cursor = gate.parent;
  }
  return chain.reverse();
}
