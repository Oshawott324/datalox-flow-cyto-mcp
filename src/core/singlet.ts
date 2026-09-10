import path from "node:path";

import { readFcsColumns, readFcsMetadata } from "./fcs.js";
import {
  FlowcytoError,
  type WorkspaceGate,
} from "./types.js";
import { readWorkspace, resolveSamplePath } from "./workspace.js";

export type SuggestSingletGateInput = {
  workspacePath: string;
  sampleId: string;
  parent?: string;
  x?: string;
  y?: string;
  k?: number;
};

export type SuggestSingletGateResult = {
  ok: true;
  workspacePath: string;
  sampleId: string;
  parent: string;
  gate: WorkspaceGate;
  metrics: {
    eventsUsed: number;
    slope: number;
    madDistance: number;
    keptFractionEstimate: number;
  };
  nextAction: {
    tool: "upsert_gate";
    arguments: {
      workspace_path: string;
      expected_revision: number;
      gate: WorkspaceGate;
    };
  };
};

function percentile(values: number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function median(values: number[]): number {
  return percentile(values, 0.5);
}

function mad(values: number[]): number {
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

function normalizeChannel(value: string): string {
  return value.toLowerCase().replace(/[\s_-]/g, "");
}

function channelMatches(value: string, kind: "fsc" | "ssc", suffix: "a" | "h"): boolean {
  const normalized = normalizeChannel(value);
  if (!normalized.includes(kind)) return false;
  return normalized.endsWith(suffix) || normalized.includes(`/10${suffix}`);
}

function chooseSingletAxes(channels: string[], x?: string, y?: string): { x: string; y: string } {
  if (x && y) return { x, y };
  const fscA = channels.find((channel) => channelMatches(channel, "fsc", "a"));
  const fscH = channels.find((channel) => channelMatches(channel, "fsc", "h"));
  if (fscA && fscH) return { x: fscA, y: fscH };
  const sscA = channels.find((channel) => channelMatches(channel, "ssc", "a"));
  const sscH = channels.find((channel) => channelMatches(channel, "ssc", "h"));
  if (sscA && sscH) return { x: sscA, y: sscH };
  throw new FlowcytoError("missing_singlet_axes", "Could not find area/height channel pair for singlet gating. Pass x and y explicitly.", "/channels");
}

function gateId(sampleId: string, parent: string, x: string, y: string): string {
  return `suggested_singlets_${sampleId}_${parent}_${x}_${y}`.replace(/[^A-Za-z0-9._-]+/g, "_");
}

export async function suggestSingletGate(input: SuggestSingletGateInput): Promise<SuggestSingletGateResult> {
  const workspace = await readWorkspace(input.workspacePath);
  const sample = workspace.samples.find((entry) => entry.id === input.sampleId);
  if (!sample) throw new FlowcytoError("unknown_sample", `Sample ${input.sampleId} is not present.`, "/sample_id");
  const samplePath = resolveSamplePath(input.workspacePath, sample.path);
  const allChannels = (await readFcsMetadata(samplePath, input.sampleId)).parameters.map((parameter) => parameter.name);
  const axes = chooseSingletAxes(allChannels, input.x, input.y);
  const columns = await readFcsColumns({ path: samplePath, channels: [axes.x, axes.y] });
  const pairs = columns.values
    .map((row): [number, number] => [row[0], row[1]])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pairs.length === 0) throw new FlowcytoError("empty_singlet_data", "No finite events are available for singlet gate suggestion.", "/channels");

  const xs = pairs.map(([x]) => x);
  const ratios = pairs.filter(([x]) => Math.abs(x) > 1e-12).map(([x, y]) => y / x);
  const slope = ratios.length > 0 ? median(ratios) : 1;
  const invNorm = 1 / Math.sqrt(1 + slope * slope);
  const distances = pairs.map(([x, y]) => (y - slope * x) * invNorm);
  const madDistance = mad(distances);
  const deltaY = (Math.max(1e-12, input.k ?? 3) * madDistance) / invNorm;
  const xMin = percentile(xs, 0.01);
  const xMax = percentile(xs, 0.95);
  const vertices: Array<[number, number]> = [
    [xMin, slope * xMin - deltaY],
    [xMax, slope * xMax - deltaY],
    [xMax, slope * xMax + deltaY],
    [xMin, slope * xMin + deltaY],
  ];
  const within = pairs.filter(([x, y]) => x >= xMin && x <= xMax && y >= slope * x - deltaY && y <= slope * x + deltaY).length;
  const gate: WorkspaceGate = {
    id: gateId(input.sampleId, input.parent ?? "root", axes.x, axes.y),
    name: `Suggested Singlets (${axes.x}/${axes.y})`,
    sample: input.sampleId,
    parent: input.parent ?? "root",
    type: "polygon",
    x: axes.x,
    y: axes.y,
    vertices,
  };
  return {
    ok: true,
    workspacePath: path.resolve(input.workspacePath),
    sampleId: input.sampleId,
    parent: input.parent ?? "root",
    gate,
    metrics: {
      eventsUsed: pairs.length,
      slope,
      madDistance,
      keptFractionEstimate: within / pairs.length,
    },
    nextAction: {
      tool: "upsert_gate",
      arguments: {
        workspace_path: path.resolve(input.workspacePath),
        expected_revision: workspace.revision,
        gate,
      },
    },
  };
}
