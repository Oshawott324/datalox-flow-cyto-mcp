import { readPreviewColumns } from "./fcs.js";
import {
  FlowcytoError,
  type CompensationMatrix,
  type EventPreview,
  type PreviewFormat,
  type WorkspaceGate,
} from "./types.js";

export const POINT_PREVIEW_MAX_EVENTS = 50_000;
export const DEFAULT_BIN_WIDTH = 256;
export const DEFAULT_BIN_HEIGHT = 256;

export type BuildEventPreviewInput = {
  samplePath: string;
  sampleId: string;
  x: string;
  y: string;
  parent?: string;
  maxEvents: number;
  format: PreviewFormat;
  binWidth?: number;
  binHeight?: number;
  parentGateChain?: WorkspaceGate[];
  compensation?: CompensationMatrix;
};

function concreteFormat(format: PreviewFormat, maxEvents: number): "points" | "bins" {
  if (format === "points" && maxEvents > POINT_PREVIEW_MAX_EVENTS) {
    throw new FlowcytoError(
      "point_preview_too_large",
      `Point previews are capped at ${POINT_PREVIEW_MAX_EVENTS} events. Request format=bins for larger render previews.`,
      "/max_events",
    );
  }
  if (format === "bins") return "bins";
  if (maxEvents > POINT_PREVIEW_MAX_EVENTS) return "bins";
  return "points";
}

function finiteBounds(values: Float32Array | Float64Array): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (min === max) {
    const pad = Math.max(1, Math.abs(min) * 0.01);
    return { min: min - pad, max: max + pad };
  }
  return { min, max };
}

function buildBins(input: {
  xs: Float32Array | Float64Array;
  ys: Float32Array | Float64Array;
  width: number;
  height: number;
}): EventPreview["bins"] {
  const xBounds = finiteBounds(input.xs);
  const yBounds = finiteBounds(input.ys);
  const counts = new Uint32Array(input.width * input.height);
  const xSpan = xBounds.max - xBounds.min;
  const ySpan = yBounds.max - yBounds.min;

  for (let index = 0; index < input.xs.length; index += 1) {
    const x = input.xs[index];
    const y = input.ys[index];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const xBin = Math.min(input.width - 1, Math.max(0, Math.floor(((x - xBounds.min) / xSpan) * input.width)));
    const yBin = Math.min(input.height - 1, Math.max(0, Math.floor(((y - yBounds.min) / ySpan) * input.height)));
    counts[yBin * input.width + xBin] += 1;
  }

  return {
    xMin: xBounds.min,
    xMax: xBounds.max,
    yMin: yBounds.min,
    yMax: yBounds.max,
    width: input.width,
    height: input.height,
    counts: Array.from(counts),
  };
}

export async function buildEventPreview(input: BuildEventPreviewInput): Promise<EventPreview> {
  const format = concreteFormat(input.format, input.maxEvents);
  const columns = await readPreviewColumns({
    path: input.samplePath,
    x: input.x,
    y: input.y,
    maxEvents: input.maxEvents,
    parentGateChain: input.parentGateChain,
    compensation: input.compensation,
  });

  if (format === "bins") {
    return {
      sampleId: input.sampleId,
      x: input.x,
      y: input.y,
      parent: input.parent ?? "root",
      format,
      scale: { x: "linear", y: "linear" },
      totalEvents: columns.totalEvents,
      filteredEvents: columns.filteredEvents,
      sampledEvents: columns.x.length,
      ...(columns.compensation ? { compensation: columns.compensation } : {}),
      bins: buildBins({
        xs: columns.x,
        ys: columns.y,
        width: input.binWidth ?? DEFAULT_BIN_WIDTH,
        height: input.binHeight ?? DEFAULT_BIN_HEIGHT,
      }),
    };
  }

  const points: Array<[number, number]> = [];
  for (let index = 0; index < columns.x.length; index += 1) {
    points.push([columns.x[index], columns.y[index]]);
  }
  return {
    sampleId: input.sampleId,
    x: input.x,
    y: input.y,
    parent: input.parent ?? "root",
    format,
    scale: { x: "linear", y: "linear" },
    totalEvents: columns.totalEvents,
    filteredEvents: columns.filteredEvents,
    sampledEvents: points.length,
    ...(columns.compensation ? { compensation: columns.compensation } : {}),
    points,
  };
}
