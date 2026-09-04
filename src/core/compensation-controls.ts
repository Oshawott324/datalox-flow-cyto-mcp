import { readFcsColumns } from "./fcs.js";
import { FlowcytoError, type CompensationMatrix } from "./types.js";

export type CompensationControlMapping = {
  path: string;
  channel: string;
};

export type EstimateCompensationFromControlsInput = {
  id?: string;
  name?: string;
  sample?: string;
  channels?: string[];
  controls: CompensationControlMapping[];
  unstainedPath?: string;
  maxEvents?: number;
};

export type EstimateCompensationFromControlsResult = {
  ok: true;
  compensation: CompensationMatrix;
  diagnostics: {
    method: "median_ratio";
    channels: string[];
    controls: Array<{ path: string; channel: string; totalEvents: number; sampledEvents: number }>;
    unstained?: { path: string; totalEvents: number; sampledEvents: number };
  };
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

function assertControlMappings(input: EstimateCompensationFromControlsInput, channels: string[]): void {
  if (input.controls.length === 0) {
    throw new FlowcytoError("missing_compensation_controls", "At least one single-stain control is required.", "/controls");
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

export async function estimateCompensationFromControls(input: EstimateCompensationFromControlsInput): Promise<EstimateCompensationFromControlsResult> {
  const channels = input.channels ?? input.controls.map((control) => control.channel);
  assertControlMappings(input, channels);

  const unstained = input.unstainedPath
    ? await readFcsColumns({ path: input.unstainedPath, channels, maxEvents: input.maxEvents })
    : undefined;
  const unstainedMedians = unstained
    ? channels.map((_, index) => median(unstained.values.map((row) => row[index] ?? Number.NaN)))
    : channels.map(() => 0);

  const controlsByChannel = new Map(input.controls.map((control) => [control.channel, control]));
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
    controlDiagnostics.push({
      path: control.path,
      channel: control.channel,
      totalEvents: controlColumns.totalEvents,
      sampledEvents: controlColumns.sampledEvents,
    });
    const medians = channels.map((_, index) => median(controlColumns.values.map((row) => row[index] ?? Number.NaN)));
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
      controls: controlDiagnostics,
      ...(unstained ? { unstained: { path: input.unstainedPath ?? "", totalEvents: unstained.totalEvents, sampledEvents: unstained.sampledEvents } } : {}),
    },
  };
}
