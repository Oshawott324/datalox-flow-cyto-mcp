import { resolveAvailableCompensationChannel, type AvailableCompensationChannel } from "./compensation.js";
import { readFcsColumns, readFcsMetadata } from "./fcs.js";
import { FlowcytoError, type CompensationMatrix } from "./types.js";

export type CompensationControlMapping = {
  path: string;
  channel: string;
};

export type EventSelection = {
  type: "primary_channel_top_percentile";
  percentile: number;
};

export type EstimateCompensationFromControlsInput = {
  id?: string;
  name?: string;
  sample?: string;
  channels?: string[];
  controls: CompensationControlMapping[];
  unstainedPath?: string;
  maxEvents?: number;
  eventSelection?: EventSelection;
};

export type EstimateCompensationFromControlsResult = {
  ok: true;
  compensation: CompensationMatrix;
  diagnostics: {
    method: "median_ratio";
    channels: string[];
    requestedChannels?: string[];
    controls: Array<{ path: string; channel: string; totalEvents: number; sampledEvents: number; selectedEvents?: number }>;
    unstained?: { path: string; totalEvents: number; sampledEvents: number };
    eventSelection?: EventSelection;
  };
};

type ResolvedControlInput = {
  channels: string[];
  requestedChannels: string[];
  controls: CompensationControlMapping[];
};

function median(values: number[]): number {
  const finite = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (finite.length === 0) {
    throw new FlowcytoError("insufficient_control_events", "Control channel has no finite events.", "/controls");
  }
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 === 0 ? ((finite[middle - 1] ?? 0) + (finite[middle] ?? 0)) / 2 : finite[middle] ?? 0;
}

function defaultCompensationId(channels: string[]): string {
  const slug = channels.join("_").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return `controls_median_${slug || "matrix"}`;
}

function selectTopRows(rows: number[][], primaryIndex: number, unstainedPrimary: number, percentile: number): { selected: number[][]; count: number } {
  const n = Math.max(1, Math.ceil(rows.length * (1 - percentile / 100)));
  const ranked = rows
    .map((row, i) => ({ i, corrected: (row[primaryIndex] ?? 0) - unstainedPrimary }))
    .sort((a, b) => b.corrected - a.corrected);
  const selected = ranked.slice(0, n).map(({ i }) => rows[i] as number[]);
  return { selected, count: n };
}

function assertControlMappings(input: EstimateCompensationFromControlsInput, channels: string[]): void {
  if (input.controls.length === 0) {
    throw new FlowcytoError("missing_compensation_controls", "At least one single-stain control is required.", "/controls");
  }
  if (input.eventSelection) {
    const p = input.eventSelection.percentile;
    if (!Number.isFinite(p) || p <= 0 || p >= 100) {
      throw new FlowcytoError("invalid_event_selection", "event_selection.percentile must be greater than 0 and less than 100.", "/event_selection");
    }
  }
  const channelSet = new Set(channels);
  if (channelSet.size !== channels.length) {
    throw new FlowcytoError("duplicate_compensation_channel", "Compensation channels must be unique.", "/channels");
  }
  const controlsByChannel = new Map<string, CompensationControlMapping>();
  for (const control of input.controls) {
    if (!control.path || !control.channel) {
      throw new FlowcytoError("invalid_compensation_control", "Each control requires path and channel.", "/controls");
    }
    if (!channelSet.has(control.channel)) {
      throw new FlowcytoError("unknown_compensation_control_channel", `Control channel ${control.channel} is not in channels.`, "/controls");
    }
    if (controlsByChannel.has(control.channel)) {
      throw new FlowcytoError("duplicate_compensation_control", `Duplicate control for channel ${control.channel}.`, "/controls");
    }
    controlsByChannel.set(control.channel, control);
  }
  const missing = channels.filter((channel) => !controlsByChannel.has(channel));
  if (missing.length > 0) {
    throw new FlowcytoError("missing_compensation_control", `Missing single-stain control for channel ${missing.join(", ")}.`, "/controls");
  }
}

function availableCompensationChannelsFromMetadata(parameters: Awaited<ReturnType<typeof readFcsMetadata>>["parameters"]): AvailableCompensationChannel[] {
  return parameters.map((parameter) => ({
    name: parameter.name,
    ...(parameter.detector ? { detector: parameter.detector } : {}),
    ...(parameter.marker ? { marker: parameter.marker } : {}),
  }));
}

async function resolveControlInput(input: EstimateCompensationFromControlsInput): Promise<ResolvedControlInput> {
  if (input.controls.length === 0) {
    throw new FlowcytoError("missing_compensation_controls", "At least one single-stain control is required.", "/controls");
  }
  const referencePath = input.unstainedPath ?? input.controls[0]?.path;
  if (!referencePath) {
    throw new FlowcytoError("missing_compensation_controls", "At least one single-stain control is required.", "/controls");
  }
  const metadata = await readFcsMetadata(referencePath);
  const availableChannels = availableCompensationChannelsFromMetadata(metadata.parameters);
  const requestedChannels = input.channels ?? input.controls.map((control) => control.channel);
  const resolve = (channel: string, pathValue: string): string => {
    const resolved = resolveAvailableCompensationChannel(channel, availableChannels);
    if (!resolved) {
      if (pathValue.startsWith("/controls/")) {
        throw new FlowcytoError("unknown_compensation_control_channel", `Control channel ${channel} is not present.`, pathValue);
      }
      throw new FlowcytoError("unknown_parameter", `Parameter ${channel} is not present.`, pathValue);
    }
    return resolved;
  };
  return {
    requestedChannels,
    channels: requestedChannels.map((channel) => resolve(channel, "/channels")),
    controls: input.controls.map((control, index) => ({
      ...control,
      channel: resolve(control.channel, `/controls/${index}/channel`),
    })),
  };
}

export async function estimateCompensationFromControls(input: EstimateCompensationFromControlsInput): Promise<EstimateCompensationFromControlsResult> {
  const resolvedInput = await resolveControlInput(input);
  const channels = resolvedInput.channels;
  assertControlMappings({ ...input, controls: resolvedInput.controls }, channels);

  const unstained = input.unstainedPath
    ? await readFcsColumns({ path: input.unstainedPath, channels, maxEvents: input.maxEvents })
    : undefined;
  const unstainedMedians = unstained
    ? channels.map((_, index) => median(unstained.values.map((row) => row[index] ?? Number.NaN)))
    : channels.map(() => 0);

  const controlsByChannel = new Map(resolvedInput.controls.map((control) => [control.channel, control]));
  const controlDiagnostics: EstimateCompensationFromControlsResult["diagnostics"]["controls"] = [];
  // One row per single-stain control: row = source fluorochrome, column = destination
  // detector, matching CompensationMatrix.matrix and the FCS $SPILLOVER convention.
  const rows: number[][] = [];

  for (const fluorochromeChannel of channels) {
    const control = controlsByChannel.get(fluorochromeChannel);
    if (!control) {
      throw new FlowcytoError("missing_compensation_control", `Missing single-stain control for channel ${fluorochromeChannel}.`, "/controls");
    }
    const controlColumns = await readFcsColumns({ path: control.path, channels, maxEvents: input.maxEvents });
    let eventRows = controlColumns.values;
    let selectedEvents: number | undefined;
    if (input.eventSelection) {
      const primaryIndex = channels.indexOf(fluorochromeChannel);
      const { selected, count } = selectTopRows(
        controlColumns.values,
        primaryIndex,
        unstainedMedians[primaryIndex] ?? 0,
        input.eventSelection.percentile,
      );
      eventRows = selected;
      selectedEvents = count;
    }
    controlDiagnostics.push({
      path: control.path,
      channel: control.channel,
      totalEvents: controlColumns.totalEvents,
      sampledEvents: controlColumns.sampledEvents,
      ...(selectedEvents !== undefined ? { selectedEvents } : {}),
    });
    const medians = channels.map((_, index) => median(eventRows.map((row) => row[index] ?? Number.NaN)));
    const primaryIndex = channels.indexOf(fluorochromeChannel);
    const denominator = medians[primaryIndex] - unstainedMedians[primaryIndex];
    if (!Number.isFinite(denominator) || denominator <= 0) {
      throw new FlowcytoError("insufficient_control_signal", `Control ${fluorochromeChannel} is not brighter than unstained background.`, "/controls");
    }
    rows.push(medians.map((value, detectorIndex) => {
      if (detectorIndex === primaryIndex) return 1;
      return (value - unstainedMedians[detectorIndex]) / denominator;
    }));
  }

  const matrix = rows;
  return {
    ok: true,
    compensation: {
      id: input.id ?? defaultCompensationId(channels),
      ...(input.name ? { name: input.name } : { name: "Control-derived median compensation" }),
      source: "controls",
      ...(input.sample ? { sample: input.sample } : {}),
      channels,
      matrix,
    },
    diagnostics: {
      method: "median_ratio",
      channels,
      ...(resolvedInput.requestedChannels.some((channel, index) => channel !== channels[index])
        ? { requestedChannels: resolvedInput.requestedChannels }
        : {}),
      controls: controlDiagnostics,
      ...(unstained ? { unstained: { path: input.unstainedPath ?? "", totalEvents: unstained.totalEvents, sampledEvents: unstained.sampledEvents } } : {}),
      ...(input.eventSelection ? { eventSelection: input.eventSelection } : {}),
    },
  };
}
