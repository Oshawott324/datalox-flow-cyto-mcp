import path from "node:path";

import { alignCompensationMatrix, applyCompensationColumns } from "./compensation.js";
import { pointInPolygon, pointInRect, readFcsColumns, readFcsMetadata } from "./fcs.js";
import { quadrantRegionGate } from "./gate-model.js";
import { FlowcytoError, type AppliedCompensation, type CompensationMatrix, type EvaluableGate, type FlowcytoWorkspace, type WorkspaceGate } from "./types.js";
import { readWorkspace, resolveSamplePath } from "./workspace.js";

export type PopulationGraphNode = {
  gateId: string;
  name: string;
  type: "root" | WorkspaceGate["type"];
  parent: string | null;
  count: number;
  percentOfParent: number;
  percentOfRoot: number;
  children: PopulationGraphNode[];
};

export type PopulationGraphResult = {
  ok: true;
  workspacePath: string;
  revision: number;
  sampleId: string;
  compensation?: AppliedCompensation;
  root: PopulationGraphNode;
};

function gateChannels(gate: WorkspaceGate): string[] {
  if (gate.type === "range") return [gate.x];
  return [gate.x, gate.y];
}

function contains(gate: EvaluableGate, values: Map<string, number>): boolean {
  if (gate.type === "range") {
    const value = values.get(gate.x);
    return value !== undefined && value >= gate.min && value <= gate.max;
  }
  const x = values.get(gate.x);
  const y = values.get(gate.y);
  if (x === undefined || y === undefined) return false;
  if (gate.type === "rect") return pointInRect(x, y, gate);
  if (gate.type === "quadrant_region") {
    const xMatches = gate.xSign === "+" ? x >= gate.xThreshold : x < gate.xThreshold;
    const yMatches = gate.ySign === "+" ? y >= gate.yThreshold : y < gate.yThreshold;
    return xMatches && yMatches;
  }
  return pointInPolygon(x, y, gate.vertices);
}

function pct(count: number, denominator: number): number {
  return denominator > 0 ? count / denominator * 100 : 0;
}

function resolveCompensation(workspace: FlowcytoWorkspace, compensationId?: string): CompensationMatrix | undefined {
  if (!compensationId) return undefined;
  const compensation = (workspace.compensations ?? []).find((entry) => entry.id === compensationId);
  if (!compensation) {
    throw new FlowcytoError("unknown_compensation", `Compensation ${compensationId} is not present.`, "/compensation_id");
  }
  return compensation;
}

export async function getPopulationGraph(input: {
  workspacePath: string;
  sampleId: string;
  compensationId?: string;
}): Promise<PopulationGraphResult> {
  const workspace = await readWorkspace(input.workspacePath);
  const sample = workspace.samples.find((entry) => entry.id === input.sampleId);
  if (!sample) throw new FlowcytoError("unknown_sample", `Sample ${input.sampleId} is not present.`, "/sample_id");
  const samplePath = resolveSamplePath(input.workspacePath, sample.path);
  const sampleGates = workspace.gates.filter((gate) => gate.sample === input.sampleId && gate.enabled !== false);
  const gateChannelList = [...new Set(sampleGates.flatMap(gateChannels))];
  const metadata = await readFcsMetadata(samplePath, input.sampleId);
  const compensation = resolveCompensation(workspace, input.compensationId);
  let channels = gateChannelList;
  let alignedCompensation: CompensationMatrix | undefined;
  let compensationWarnings: string[] = [];
  if (compensation) {
    const aligned = alignCompensationMatrix(compensation, metadata.parameters.map((parameter) => ({
      name: parameter.name,
      detector: parameter.detector,
      marker: parameter.marker,
    })));
    alignedCompensation = aligned.compensation;
    compensationWarnings = aligned.warnings;
    channels = [...new Set([...gateChannelList, ...alignedCompensation.channels])];
  }
  const columns = channels.length > 0
    ? await readFcsColumns({ path: samplePath, channels })
    : { channels: [], values: [], totalEvents: metadata.eventCount ?? 0 };
  let values = columns.values;
  let appliedCompensation: AppliedCompensation | undefined;
  if (alignedCompensation && channels.length > 0) {
    const applied = applyCompensationColumns({
      values,
      channels,
      compensation: alignedCompensation,
    });
    values = applied.values;
    appliedCompensation = {
      ...applied.compensation,
      ...(compensationWarnings.length > 0 ? { warnings: compensationWarnings } : {}),
    };
  }
  const totalEvents = columns.totalEvents;
  const events = values.map((row) => new Map(channels.map((channel, index) => [channel, row[index]])));
  const rootEventIndexes = Array.from({ length: totalEvents }, (_, index) => index);
  const childrenByParent = new Map<string, WorkspaceGate[]>();
  for (const gate of sampleGates) {
    const children = childrenByParent.get(gate.parent) ?? [];
    children.push(gate);
    childrenByParent.set(gate.parent, children);
  }
  childrenByParent.forEach((children) => children.sort((left, right) => (left.name || left.id).localeCompare(right.name || right.id)));

  const build = (parentId: string, parentIndexes: number[], rootCount: number): PopulationGraphNode[] =>
    (childrenByParent.get(parentId) ?? []).flatMap((gate) => {
      if (gate.type === "quadrant") {
        return gate.quadrants.map((population) => {
          const region = quadrantRegionGate({ gate, population });
          const indexes = parentIndexes.filter((eventIndex) => contains(region, events[eventIndex] ?? new Map()));
          return {
            gateId: population.id,
            name: population.name || population.id,
            type: "quadrant" as const,
            parent: parentId === "root" ? "root" : parentId,
            count: indexes.length,
            percentOfParent: pct(indexes.length, parentIndexes.length),
            percentOfRoot: pct(indexes.length, rootCount),
            children: build(population.id, indexes, rootCount),
          };
        });
      }
      const indexes = parentIndexes.filter((eventIndex) => contains(gate, events[eventIndex] ?? new Map()));
      const node: PopulationGraphNode = {
        gateId: gate.id,
        name: gate.name || gate.id,
        type: gate.type,
        parent: parentId === "root" ? "root" : parentId,
        count: indexes.length,
        percentOfParent: pct(indexes.length, parentIndexes.length),
        percentOfRoot: pct(indexes.length, rootCount),
        children: [],
      };
      node.children = build(gate.id, indexes, rootCount);
      return [node];
    });

  const root: PopulationGraphNode = {
    gateId: "root",
    name: "Root",
    type: "root",
    parent: null,
    count: totalEvents,
    percentOfParent: 100,
    percentOfRoot: 100,
    children: build("root", rootEventIndexes, totalEvents),
  };
  return {
    ok: true,
    workspacePath: path.resolve(input.workspacePath),
    revision: workspace.revision,
    sampleId: input.sampleId,
    ...(appliedCompensation ? { compensation: appliedCompensation } : {}),
    root,
  };
}
