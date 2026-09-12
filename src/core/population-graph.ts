import path from "node:path";

import { pointInPolygon, pointInRect, readFcsColumns, readFcsMetadata } from "./fcs.js";
import { FlowcytoError, type WorkspaceGate } from "./types.js";
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
  root: PopulationGraphNode;
};

function gateChannels(gate: WorkspaceGate): string[] {
  if (gate.type === "range") return [gate.x];
  return [gate.x, gate.y];
}

function contains(gate: WorkspaceGate, values: Map<string, number>): boolean {
  if (gate.type === "range") {
    const value = values.get(gate.x);
    return value !== undefined && value >= gate.min && value <= gate.max;
  }
  const x = values.get(gate.x);
  const y = values.get(gate.y);
  if (x === undefined || y === undefined) return false;
  if (gate.type === "rect") return pointInRect(x, y, gate);
  return pointInPolygon(x, y, gate.vertices);
}

function pct(count: number, denominator: number): number {
  return denominator > 0 ? count / denominator * 100 : 0;
}

export async function getPopulationGraph(input: {
  workspacePath: string;
  sampleId: string;
}): Promise<PopulationGraphResult> {
  const workspace = await readWorkspace(input.workspacePath);
  const sample = workspace.samples.find((entry) => entry.id === input.sampleId);
  if (!sample) throw new FlowcytoError("unknown_sample", `Sample ${input.sampleId} is not present.`, "/sample_id");
  const sampleGates = workspace.gates.filter((gate) => gate.sample === input.sampleId && gate.enabled !== false);
  const channels = [...new Set(sampleGates.flatMap(gateChannels))];
  const columns = channels.length > 0
    ? await readFcsColumns({ path: resolveSamplePath(input.workspacePath, sample.path), channels })
    : { channels: [], values: [], totalEvents: 0 };
  const totalEvents = channels.length > 0
    ? columns.totalEvents
    : (await readFcsMetadata(resolveSamplePath(input.workspacePath, sample.path), input.sampleId)).eventCount ?? 0;
  const events = columns.values.map((row) => new Map(channels.map((channel, index) => [channel, row[index]])));
  const rootEventIndexes = Array.from({ length: totalEvents }, (_, index) => index);
  const childrenByParent = new Map<string, WorkspaceGate[]>();
  for (const gate of sampleGates) {
    const children = childrenByParent.get(gate.parent) ?? [];
    children.push(gate);
    childrenByParent.set(gate.parent, children);
  }
  childrenByParent.forEach((children) => children.sort((left, right) => (left.name || left.id).localeCompare(right.name || right.id)));

  const build = (parentId: string, parentIndexes: number[], rootCount: number): PopulationGraphNode[] =>
    (childrenByParent.get(parentId) ?? []).map((gate) => {
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
      return node;
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
    root,
  };
}
