import path from "node:path";

import { alignCompensationMatrix, applyCompensationColumns } from "./compensation.js";
import { gateContainsEvent, readFcsColumns, readFcsMetadata } from "./fcs.js";
import { resolveParentGateChain } from "./gate-model.js";
import { resolveParameterName } from "./parameter-names.js";
import {
  FlowcytoError,
  type AppliedCompensation,
  type AxisScale,
  type CompensationMatrix,
} from "./types.js";
import { readWorkspace, resolveSamplePath } from "./workspace.js";

/**
 * Exact, unsampled access to the events of a population.
 *
 * Previews are sized for drawing: they cap point counts and stride-sample large
 * files. The functions here are for measurement instead. Every one of them reads
 * all events of the sample, applies the requested compensation, applies the
 * full gate chain of `parent`, and only then summarises or pages the result.
 */

export const MAX_EVENT_PAGE = 50_000;
/**
 * Values (events x channels) one page may carry. A page is returned as a single
 * MCP message, and MCP clients cap message size (10 MB in the reference SDK), so
 * wide pages have to be shorter.
 */
export const MAX_PAGE_VALUES = 100_000;
export const MAX_HISTOGRAM_BINS = 1024;
const DEFAULT_ARCSINH_COFACTOR = 150;
const BIEX_WIDTH = 4.5;

export type PopulationEventsInput = {
  workspacePath: string;
  sampleId: string;
  channels: string[];
  parent?: string;
  compensationId?: string;
};

export type PopulationEvents = {
  workspacePath: string;
  revision: number;
  sampleId: string;
  parent: string;
  /** Requested channels, as canonical parameter names. */
  channels: string[];
  totalEvents: number;
  /** Zero-based positions in the FCS DATA segment of the events in the population. */
  eventIndexes: number[];
  /** One row per population event, one value per requested channel. */
  rows: number[][];
  compensation?: AppliedCompensation;
};

function resolveCompensation(
  compensations: CompensationMatrix[] | undefined,
  sampleId: string,
  compensationId?: string,
): CompensationMatrix | undefined {
  if (!compensationId) return undefined;
  const matrix = (compensations ?? []).find((entry) => entry.id === compensationId);
  if (!matrix) {
    throw new FlowcytoError("unknown_compensation", `Compensation ${compensationId} is not present.`, "/compensation_id");
  }
  if (matrix.sample !== undefined && matrix.sample !== sampleId) {
    throw new FlowcytoError(
      "compensation_sample_mismatch",
      `Compensation ${compensationId} belongs to sample ${matrix.sample}, not ${sampleId}.`,
      "/compensation_id",
    );
  }
  return matrix;
}

export async function readPopulationEvents(input: PopulationEventsInput): Promise<PopulationEvents> {
  const workspace = await readWorkspace(input.workspacePath);
  const sample = workspace.samples.find((entry) => entry.id === input.sampleId);
  if (!sample) throw new FlowcytoError("unknown_sample", `Sample ${input.sampleId} is not present.`, "/sample_id");
  if (input.channels.length === 0) {
    throw new FlowcytoError("missing_channels", "At least one channel is required.", "/channels");
  }
  const parent = input.parent ?? "root";
  const chain = resolveParentGateChain(workspace, { sampleId: input.sampleId, parent });
  const samplePath = resolveSamplePath(input.workspacePath, sample.path);
  const metadata = await readFcsMetadata(samplePath, input.sampleId);
  const channels = input.channels.map((channel, index) =>
    resolveParameterName(metadata.parameters, channel, `/channels/${index}`, input.sampleId));

  const needed = new Set<string>(channels);
  for (const gate of chain) {
    needed.add(gate.x);
    if (gate.type !== "range") needed.add(gate.y);
  }
  const compensation = resolveCompensation(workspace.compensations, input.sampleId, input.compensationId);
  let aligned: CompensationMatrix | undefined;
  let warnings: string[] = [];
  if (compensation) {
    const result = alignCompensationMatrix(compensation, metadata.parameters.map((parameter) => ({
      name: parameter.name,
      detector: parameter.detector,
      marker: parameter.marker,
    })));
    aligned = result.compensation;
    warnings = result.warnings;
    aligned.channels.forEach((name) => needed.add(name));
  }

  const neededList = [...needed];
  const columns = await readFcsColumns({ path: samplePath, channels: neededList });
  let values = columns.values;
  let applied: AppliedCompensation | undefined;
  if (aligned) {
    const result = applyCompensationColumns({ values, channels: neededList, compensation: aligned });
    values = result.values;
    applied = { ...result.compensation, ...(warnings.length > 0 ? { warnings } : {}) };
  }

  const positions = channels.map((channel) => neededList.indexOf(channel));
  const eventIndexes: number[] = [];
  const rows: number[][] = [];
  values.forEach((row, eventIndex) => {
    if (chain.length > 0) {
      const byName = new Map(neededList.map((name, position) => [name, row[position] as number]));
      if (!chain.every((gate) => gateContainsEvent(gate, byName))) return;
    }
    eventIndexes.push(eventIndex);
    rows.push(positions.map((position) => row[position] as number));
  });

  return {
    workspacePath: path.resolve(input.workspacePath),
    revision: workspace.revision,
    sampleId: input.sampleId,
    parent,
    channels,
    totalEvents: columns.totalEvents,
    eventIndexes,
    rows,
    ...(applied ? { compensation: applied } : {}),
  };
}

// --------------------------------------------------------------------- paging

export async function getPopulationEvents(input: PopulationEventsInput & { offset?: number; limit?: number }) {
  const offset = input.offset ?? 0;
  const maxLimit = Math.max(1, Math.min(MAX_EVENT_PAGE, Math.floor(MAX_PAGE_VALUES / Math.max(1, input.channels.length))));
  const limit = input.limit ?? Math.min(10_000, maxLimit);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new FlowcytoError("invalid_offset", "offset must be a non-negative integer.", "/offset");
  }
  if (!Number.isInteger(limit) || limit <= 0 || limit > maxLimit) {
    throw new FlowcytoError(
      "invalid_limit",
      `limit must be an integer between 1 and ${maxLimit} when ${input.channels.length} channel(s) are requested (a page carries at most ${MAX_PAGE_VALUES} values).`,
      "/limit",
    );
  }
  const events = await readPopulationEvents(input);
  const end = Math.min(events.eventIndexes.length, offset + limit);
  return {
    ok: true as const,
    workspacePath: events.workspacePath,
    revision: events.revision,
    sampleId: events.sampleId,
    parent: events.parent,
    channels: events.channels,
    totalEvents: events.totalEvents,
    populationEvents: events.eventIndexes.length,
    offset,
    returnedEvents: Math.max(0, end - offset),
    maxLimit,
    nextOffset: end < events.eventIndexes.length ? end : null,
    ...(events.compensation ? { compensation: events.compensation } : {}),
    eventIndexes: events.eventIndexes.slice(offset, end),
    rows: events.rows.slice(offset, end),
  };
}

// ----------------------------------------------------------------- statistics

function sortedFinite(values: number[]): Float64Array {
  return Float64Array.from(values.filter((value) => Number.isFinite(value))).sort();
}

/** Linear-interpolated percentile of an ascending array. */
export function percentileOfSorted(sorted: Float64Array, percentile: number): number | null {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * percentile / 100;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] as number;
  const high = sorted[upper] as number;
  return low + (high - low) * (position - lower);
}

const DEFAULT_PERCENTILES = [1, 5, 25, 50, 75, 95, 99];

export async function getPopulationStats(input: PopulationEventsInput & { percentiles?: number[] }) {
  const percentiles = input.percentiles ?? DEFAULT_PERCENTILES;
  if (percentiles.some((value) => !Number.isFinite(value) || value < 0 || value > 100)) {
    throw new FlowcytoError("invalid_percentile", "percentiles must lie between 0 and 100.", "/percentiles");
  }
  const events = await readPopulationEvents(input);
  const channels = events.channels.map((channel, position) => {
    const sorted = sortedFinite(events.rows.map((row) => row[position] as number));
    const median = percentileOfSorted(sorted, 50);
    const deviations = median === null ? new Float64Array() : Float64Array.from(sorted, (value) => Math.abs(value - median)).sort();
    const mad = percentileOfSorted(deviations, 50);
    let sum = 0;
    for (const value of sorted) sum += value;
    return {
      channel,
      count: sorted.length,
      min: sorted.length > 0 ? sorted[0] as number : null,
      max: sorted.length > 0 ? sorted[sorted.length - 1] as number : null,
      mean: sorted.length > 0 ? sum / sorted.length : null,
      median,
      /** Median absolute deviation scaled to a standard deviation for normal data. */
      robustSd: mad === null ? null : 1.4826 * mad,
      percentiles: Object.fromEntries(percentiles.map((value) => [String(value), percentileOfSorted(sorted, value)])),
    };
  });
  return {
    ok: true as const,
    workspacePath: events.workspacePath,
    revision: events.revision,
    sampleId: events.sampleId,
    parent: events.parent,
    totalEvents: events.totalEvents,
    populationEvents: events.eventIndexes.length,
    percentOfTotal: events.totalEvents > 0 ? events.eventIndexes.length / events.totalEvents * 100 : 0,
    ...(events.compensation ? { compensation: events.compensation } : {}),
    channels,
  };
}

// ------------------------------------------------------------------ histogram

function forward(value: number, scale: AxisScale, cofactor: number): number {
  if (scale === "arcsinh") return Math.asinh(value / cofactor);
  if (scale === "log") return value > 0 ? Math.log10(value) : Number.NaN;
  if (scale === "biex") {
    const normalized = value / cofactor;
    return Math.sign(normalized) * Math.log10(1 + Math.abs(normalized) * BIEX_WIDTH) / Math.log10(1 + BIEX_WIDTH);
  }
  return value;
}

function inverse(value: number, scale: AxisScale, cofactor: number): number {
  if (scale === "arcsinh") return Math.sinh(value) * cofactor;
  if (scale === "log") return 10 ** value;
  if (scale === "biex") {
    const magnitude = ((1 + BIEX_WIDTH) ** Math.abs(value) - 1) / BIEX_WIDTH;
    return Math.sign(value) * magnitude * cofactor;
  }
  return value;
}

export async function getChannelHistogram(input: {
  workspacePath: string;
  sampleId: string;
  channel: string;
  parent?: string;
  compensationId?: string;
  scale?: AxisScale;
  bins?: number;
  /** Range in raw (untransformed) units. Defaults to the population's own range. */
  min?: number;
  max?: number;
  /** Scale parameter of the arcsinh and biex transforms, in raw units. */
  cofactor?: number;
}) {
  const scale = input.scale ?? "linear";
  if (!["linear", "log", "arcsinh", "biex"].includes(scale)) {
    throw new FlowcytoError("invalid_scale", "scale must be linear, log, arcsinh or biex.", "/scale");
  }
  const bins = input.bins ?? 64;
  if (!Number.isInteger(bins) || bins <= 0 || bins > MAX_HISTOGRAM_BINS) {
    throw new FlowcytoError("invalid_bins", `bins must be an integer between 1 and ${MAX_HISTOGRAM_BINS}.`, "/bins");
  }
  const cofactor = input.cofactor ?? DEFAULT_ARCSINH_COFACTOR;
  if (!Number.isFinite(cofactor) || cofactor <= 0) {
    throw new FlowcytoError("invalid_cofactor", "cofactor must be a positive number.", "/cofactor");
  }
  const events = await readPopulationEvents({
    workspacePath: input.workspacePath,
    sampleId: input.sampleId,
    channels: [input.channel],
    parent: input.parent,
    compensationId: input.compensationId,
  });
  const transformed = events.rows.map((row) => forward(row[0] as number, scale, cofactor));
  const representable = transformed.filter((value) => Number.isFinite(value));
  let observedLow = Number.POSITIVE_INFINITY;
  let observedHigh = Number.NEGATIVE_INFINITY;
  for (const value of representable) {
    if (value < observedLow) observedLow = value;
    if (value > observedHigh) observedHigh = value;
  }
  if (representable.length === 0) {
    observedLow = 0;
    observedHigh = 1;
  }
  const low = input.min === undefined ? observedLow : forward(input.min, scale, cofactor);
  let high = input.max === undefined ? observedHigh : forward(input.max, scale, cofactor);
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    throw new FlowcytoError("invalid_range", "min and max must be representable on the chosen scale.", "/min");
  }
  if (high <= low) high = low + 1;

  const counts = new Array<number>(bins).fill(0);
  let belowRange = 0;
  let aboveRange = 0;
  const width = (high - low) / bins;
  for (const value of representable) {
    if (value < low) belowRange += 1;
    else if (value > high) aboveRange += 1;
    else counts[Math.min(bins - 1, Math.floor((value - low) / width))]! += 1;
  }
  const transformedEdges = Array.from({ length: bins + 1 }, (_, index) => low + width * index);
  return {
    ok: true as const,
    workspacePath: events.workspacePath,
    revision: events.revision,
    sampleId: events.sampleId,
    parent: events.parent,
    channel: events.channels[0],
    scale,
    ...(scale === "arcsinh" || scale === "biex" ? { cofactor } : {}),
    totalEvents: events.totalEvents,
    populationEvents: events.eventIndexes.length,
    ...(events.compensation ? { compensation: events.compensation } : {}),
    bins,
    /** Bin edges in raw units: counts[i] covers edges[i] up to edges[i + 1]. */
    edges: transformedEdges.map((edge) => inverse(edge, scale, cofactor)),
    transformedEdges,
    counts,
    belowRange,
    aboveRange,
    /** Events the scale cannot show, such as values at or below zero on a log scale. */
    notRepresentable: transformed.length - representable.length,
  };
}

// -------------------------------------------------------------------- density

export const MAX_DENSITY_BINS = 128;

type AxisRequest = { scale?: AxisScale; min?: number; max?: number; cofactor?: number };

function axisEdges(values: number[], axis: AxisRequest, bins: number, errorPath: string) {
  const scale = axis.scale ?? "linear";
  if (!["linear", "log", "arcsinh", "biex"].includes(scale)) {
    throw new FlowcytoError("invalid_scale", "scale must be linear, log, arcsinh or biex.", `${errorPath}/scale`);
  }
  const cofactor = axis.cofactor ?? DEFAULT_ARCSINH_COFACTOR;
  if (!Number.isFinite(cofactor) || cofactor <= 0) {
    throw new FlowcytoError("invalid_cofactor", "cofactor must be a positive number.", `${errorPath}/cofactor`);
  }
  const transformed = values.map((value) => forward(value, scale, cofactor));
  let observedLow = Number.POSITIVE_INFINITY;
  let observedHigh = Number.NEGATIVE_INFINITY;
  for (const value of transformed) {
    if (!Number.isFinite(value)) continue;
    if (value < observedLow) observedLow = value;
    if (value > observedHigh) observedHigh = value;
  }
  if (!Number.isFinite(observedLow)) {
    observedLow = 0;
    observedHigh = 1;
  }
  const low = axis.min === undefined ? observedLow : forward(axis.min, scale, cofactor);
  let high = axis.max === undefined ? observedHigh : forward(axis.max, scale, cofactor);
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    throw new FlowcytoError("invalid_range", "min and max must be representable on the chosen scale.", `${errorPath}/min`);
  }
  if (high <= low) high = low + 1;
  const width = (high - low) / bins;
  const transformedEdges = Array.from({ length: bins + 1 }, (_, index) => low + width * index);
  return {
    scale,
    cofactor,
    transformed,
    low,
    high,
    width,
    edges: transformedEdges.map((edge) => inverse(edge, scale, cofactor)),
  };
}

/**
 * Two-dimensional histogram of a population over all of its events. The exact
 * counterpart of a bins preview: counts[row][column] has the y bin as row and
 * the x bin as column, with edges in raw units.
 */
export async function getPopulationDensity(input: {
  workspacePath: string;
  sampleId: string;
  x: string;
  y: string;
  parent?: string;
  compensationId?: string;
  bins?: number;
  xAxis?: AxisRequest;
  yAxis?: AxisRequest;
}) {
  const bins = input.bins ?? 32;
  if (!Number.isInteger(bins) || bins <= 0 || bins > MAX_DENSITY_BINS) {
    throw new FlowcytoError("invalid_bins", `bins must be an integer between 1 and ${MAX_DENSITY_BINS}.`, "/bins");
  }
  const events = await readPopulationEvents({
    workspacePath: input.workspacePath,
    sampleId: input.sampleId,
    channels: [input.x, input.y],
    parent: input.parent,
    compensationId: input.compensationId,
  });
  const xAxis = axisEdges(events.rows.map((row) => row[0] as number), input.xAxis ?? {}, bins, "/x_axis");
  const yAxis = axisEdges(events.rows.map((row) => row[1] as number), input.yAxis ?? {}, bins, "/y_axis");
  const counts = Array.from({ length: bins }, () => new Array<number>(bins).fill(0));
  let outside = 0;
  let notRepresentable = 0;
  for (let index = 0; index < events.rows.length; index += 1) {
    const tx = xAxis.transformed[index] as number;
    const ty = yAxis.transformed[index] as number;
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
      notRepresentable += 1;
    } else if (tx < xAxis.low || tx > xAxis.high || ty < yAxis.low || ty > yAxis.high) {
      outside += 1;
    } else {
      const column = Math.min(bins - 1, Math.floor((tx - xAxis.low) / xAxis.width));
      const row = Math.min(bins - 1, Math.floor((ty - yAxis.low) / yAxis.width));
      counts[row]![column]! += 1;
    }
  }
  return {
    ok: true as const,
    workspacePath: events.workspacePath,
    revision: events.revision,
    sampleId: events.sampleId,
    parent: events.parent,
    x: events.channels[0],
    y: events.channels[1],
    scale: { x: xAxis.scale, y: yAxis.scale },
    totalEvents: events.totalEvents,
    populationEvents: events.eventIndexes.length,
    ...(events.compensation ? { compensation: events.compensation } : {}),
    bins,
    /** Bin edges in raw units. counts[row][column]: row is the y bin, column the x bin. */
    xEdges: xAxis.edges,
    yEdges: yAxis.edges,
    counts,
    outsideRange: outside,
    notRepresentable,
  };
}

// --------------------------------------------------- compensation from gates

export type GatedControl = {
  /** Workspace sample holding the single-stain control. */
  sampleId: string;
  /** The control's own detector, by parameter name or detector id. */
  channel: string;
  /** Gate whose population is the stained cells. */
  positiveGateId: string;
  /** Gate whose population is the matching unstained cells. */
  negativeGateId: string;
  /** Sample the negative gate lives in, when it is not the control itself. */
  negativeSampleId?: string;
};

function gatedControlId(channels: string[]): string {
  const slug = channels.join("_").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return `controls_gated_${slug || "matrix"}`;
}

/**
 * Spillover from gated single-stain controls: for each control, the median of
 * the positive population minus the median of the negative population in every
 * detector, divided by the same difference in the control's own detector.
 *
 * Unlike estimateCompensationFromControls, which takes medians over whole files
 * or over the brightest events, this uses the populations the caller gated. It
 * is the method to use for cell controls, where stained cells are a minority
 * and autofluorescence differs between cell types. Choosing the two populations
 * is the caller's job; this function only does the arithmetic.
 */
export async function estimateCompensationFromGatedControls(input: {
  workspacePath: string;
  controls: GatedControl[];
  id?: string;
  name?: string;
}) {
  if (input.controls.length === 0) {
    throw new FlowcytoError("missing_compensation_controls", "At least one single-stain control is required.", "/controls");
  }
  const workspace = await readWorkspace(input.workspacePath);
  const resolved: Array<GatedControl & { channelName: string }> = [];
  for (const [index, control] of input.controls.entries()) {
    const sample = workspace.samples.find((entry) => entry.id === control.sampleId);
    if (!sample) {
      throw new FlowcytoError("unknown_sample", `Sample ${control.sampleId} is not present.`, `/controls/${index}/sample_id`);
    }
    const metadata = await readFcsMetadata(resolveSamplePath(input.workspacePath, sample.path), control.sampleId);
    resolved.push({
      ...control,
      channelName: resolveParameterName(metadata.parameters, control.channel, `/controls/${index}/channel`, control.sampleId),
    });
  }
  const channels = resolved.map((control) => control.channelName);
  if (new Set(channels).size !== channels.length) {
    throw new FlowcytoError("duplicate_compensation_control", "Each channel may have only one control.", "/controls");
  }

  const medians = (rows: number[][]): number[] =>
    channels.map((_, position) => percentileOfSorted(sortedFinite(rows.map((row) => row[position] as number)), 50) ?? Number.NaN);

  const matrix: number[][] = [];
  const diagnostics = [];
  for (const [index, control] of resolved.entries()) {
    const positive = await readPopulationEvents({
      workspacePath: input.workspacePath, sampleId: control.sampleId, channels, parent: control.positiveGateId,
    });
    const negative = await readPopulationEvents({
      workspacePath: input.workspacePath, sampleId: control.negativeSampleId ?? control.sampleId, channels, parent: control.negativeGateId,
    });
    if (positive.rows.length === 0 || negative.rows.length === 0) {
      throw new FlowcytoError(
        "insufficient_control_events",
        `Control ${control.channelName} has ${positive.rows.length} positive and ${negative.rows.length} negative events.`,
        `/controls/${index}`,
      );
    }
    const positiveMedians = medians(positive.rows);
    const negativeMedians = medians(negative.rows);
    const own = (positiveMedians[index] as number) - (negativeMedians[index] as number);
    if (!Number.isFinite(own) || own <= 0) {
      throw new FlowcytoError(
        "insufficient_control_signal",
        `Control ${control.channelName}: the positive population is not brighter than the negative one in its own detector.`,
        `/controls/${index}`,
      );
    }
    matrix.push(channels.map((_, detector) =>
      detector === index ? 1 : ((positiveMedians[detector] as number) - (negativeMedians[detector] as number)) / own));
    diagnostics.push({
      sampleId: control.sampleId,
      channel: control.channelName,
      positiveGateId: control.positiveGateId,
      negativeGateId: control.negativeGateId,
      ...(control.negativeSampleId ? { negativeSampleId: control.negativeSampleId } : {}),
      positiveEvents: positive.rows.length,
      negativeEvents: negative.rows.length,
      positiveMedians,
      negativeMedians,
    });
  }

  return {
    ok: true as const,
    compensation: {
      id: input.id ?? gatedControlId(channels),
      name: input.name ?? "Control-derived compensation from gated populations",
      source: "controls" as const,
      channels,
      // Row = source fluorochrome, column = destination detector, as everywhere else.
      matrix,
    },
    diagnostics: {
      method: "gated_median_difference" as const,
      channels,
      controls: diagnostics,
    },
  };
}
