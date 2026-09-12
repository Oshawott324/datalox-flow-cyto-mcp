import path from "node:path";

import { readPreviewColumns } from "./fcs.js";
import {
  FlowcytoError,
  type AppliedCompensation,
  type CompensationMatrix,
  type FlowcytoWorkspace,
  type WorkspaceGate,
} from "./types.js";
import { readWorkspace, resolveSamplePath } from "./workspace.js";

export type ApoptosisControlInput = {
  sampleId?: string;
  fcsPath?: string;
  parentGateId?: string;
};

export type ApoptosisThresholdMethod = "negative_control_percentile" | "manual";

export type PopulationSummary = {
  gateId: string;
  label: string;
  count: number;
  percentOfParent: number;
};

export type SuggestApoptosisQuadrantsInput = {
  workspacePath: string;
  sampleId: string;
  parentGateId?: string;
  annexinChannel: string;
  deathChannel: string;
  negativeControl?: ApoptosisControlInput;
  positiveControl?: ApoptosisControlInput;
  annexinSinglePositiveControl?: ApoptosisControlInput;
  deathSinglePositiveControl?: ApoptosisControlInput;
  compensationId?: string;
  thresholdMethod?: ApoptosisThresholdMethod;
  negativePercentile?: number;
  manualAnnexinThreshold?: number;
  manualDeathThreshold?: number;
};

export type SuggestApoptosisQuadrantsResult = {
  ok: true;
  workspacePath: string;
  sampleId: string;
  parent: string;
  axes: {
    x: string;
    y: string;
  };
  thresholds: {
    annexin: number;
    death: number;
    method: string;
    source: "negative_control" | "manual" | "exploratory";
    negativePercentile?: number;
  };
  bounds: {
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
  };
  gates: WorkspaceGate[];
  summary: {
    viable: PopulationSummary;
    earlyApoptotic: PopulationSummary;
    lateApoptoticDead: PopulationSummary;
    necroticOrMembraneDamaged: PopulationSummary;
  };
  diagnostics: {
    confidence: "control_anchored" | "manual_thresholds" | "exploratory";
    parentEvents: number;
    compensation: AppliedCompensation;
    controls: {
      negative?: { events: number };
      positive?: { events: number };
      annexinSinglePositive?: { events: number };
      deathSinglePositive?: { events: number };
    };
    warnings: string[];
  };
  nextAction: {
    tool: "upsert_gates";
    arguments: {
      workspace_path: string;
      expected_revision: number;
      gates: WorkspaceGate[];
    };
  };
};

type XYValues = {
  x: number[];
  y: number[];
  filteredEvents: number;
  compensation?: AppliedCompensation;
};

function gateChannels(gate: WorkspaceGate): string[] {
  if (gate.type === "range") return [gate.x];
  return [gate.x, gate.y];
}

function parentGateChain(workspace: FlowcytoWorkspace, input: { sampleId: string; parent: string }): WorkspaceGate[] {
  if (input.parent === "root") return [];
  const byId = new Map(workspace.gates.map((gate) => [gate.id, gate]));
  const chain: WorkspaceGate[] = [];
  const seen = new Set<string>();
  let cursor = input.parent;
  while (cursor !== "root") {
    if (seen.has(cursor)) {
      throw new FlowcytoError("parent_ancestry_broken", `Parent gate ancestry contains a cycle at ${cursor}.`, "/parent_gate_id");
    }
    seen.add(cursor);
    const gate = byId.get(cursor);
    if (!gate) throw new FlowcytoError("unknown_parent_gate", `Parent gate ${cursor} is not present.`, "/parent_gate_id");
    if (gate.sample !== input.sampleId) {
      throw new FlowcytoError(
        "parent_ancestry_broken",
        `Parent gate ${cursor} belongs to sample ${gate.sample}, not ${input.sampleId}.`,
        "/parent_gate_id",
      );
    }
    chain.push(gate);
    cursor = gate.parent;
  }
  return chain.reverse();
}

function resolveCompensation(workspace: FlowcytoWorkspace, compensationId?: string): CompensationMatrix | undefined {
  if (!compensationId) return undefined;
  const compensation = (workspace.compensations ?? []).find((entry) => entry.id === compensationId);
  if (!compensation) {
    throw new FlowcytoError("unknown_compensation", `Compensation ${compensationId} is not present.`, "/compensation_id");
  }
  return compensation;
}

function samplePath(workspacePath: string, workspace: FlowcytoWorkspace, sampleId: string): string {
  const sample = workspace.samples.find((entry) => entry.id === sampleId);
  if (!sample) throw new FlowcytoError("unknown_sample", `Sample ${sampleId} is not present.`, "/sample_id");
  return resolveSamplePath(workspacePath, sample.path);
}

function controlPath(workspacePath: string, workspace: FlowcytoWorkspace, control: ApoptosisControlInput): string {
  if (control.fcsPath) return path.resolve(control.fcsPath);
  if (control.sampleId) return samplePath(workspacePath, workspace, control.sampleId);
  throw new FlowcytoError("missing_control_path", "Control input must include sample_id or fcs_path.", "/negative_control");
}

async function readXY(input: {
  path: string;
  x: string;
  y: string;
  parentGateChain?: WorkspaceGate[];
  compensation?: CompensationMatrix;
}): Promise<XYValues> {
  const columns = await readPreviewColumns({
    path: input.path,
    x: input.x,
    y: input.y,
    parentGateChain: input.parentGateChain,
    compensation: input.compensation,
  });
  const x: number[] = [];
  const y: number[] = [];
  for (let index = 0; index < columns.x.length; index += 1) {
    const nextX = columns.x[index];
    const nextY = columns.y[index];
    if (Number.isFinite(nextX) && Number.isFinite(nextY)) {
      x.push(nextX);
      y.push(nextY);
    }
  }
  return {
    x,
    y,
    filteredEvents: columns.filteredEvents,
    compensation: columns.compensation,
  };
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower] ?? Number.NaN;
  const upperValue = sorted[upper] ?? Number.NaN;
  if (lower === upper) return lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "gate";
}

function finiteBounds(values: number[], threshold: number): { min: number; max: number } {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0 || !Number.isFinite(threshold)) {
    throw new FlowcytoError("empty_apoptosis_data", "No finite events are available for apoptosis quadrant bounds.", "/sample_id");
  }
  let min = Math.min(...finite, threshold);
  let max = Math.max(...finite, threshold);
  if (min === max) {
    const delta = Math.max(1, Math.abs(min) * 0.01);
    min -= delta;
    max += delta;
  }
  if (threshold <= min) min = threshold - Math.max(1, Math.abs(threshold) * 0.01);
  if (threshold >= max) max = threshold + Math.max(1, Math.abs(threshold) * 0.01);
  return { min, max };
}

function pct(count: number, denominator: number): number {
  return denominator > 0 ? count / denominator * 100 : 0;
}

function countQuadrants(values: XYValues, thresholds: { annexin: number; death: number }): {
  viable: number;
  earlyApoptotic: number;
  lateApoptoticDead: number;
  necroticOrMembraneDamaged: number;
} {
  const counts = {
    viable: 0,
    earlyApoptotic: 0,
    lateApoptoticDead: 0,
    necroticOrMembraneDamaged: 0,
  };
  for (let index = 0; index < values.x.length; index += 1) {
    const annexinPositive = values.x[index] >= thresholds.annexin;
    const deathPositive = values.y[index] >= thresholds.death;
    if (!annexinPositive && !deathPositive) counts.viable += 1;
    else if (annexinPositive && !deathPositive) counts.earlyApoptotic += 1;
    else if (annexinPositive && deathPositive) counts.lateApoptoticDead += 1;
    else counts.necroticOrMembraneDamaged += 1;
  }
  return counts;
}

function rectGate(input: {
  id: string;
  name: string;
  sampleId: string;
  parent: string;
  x: string;
  y: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}): WorkspaceGate {
  return {
    id: input.id,
    name: input.name,
    sample: input.sampleId,
    parent: input.parent,
    type: "rect",
    x: input.x,
    y: input.y,
    xMin: input.xMin,
    xMax: input.xMax,
    yMin: input.yMin,
    yMax: input.yMax,
  };
}

function buildQuadrantGates(input: {
  sampleId: string;
  parent: string;
  x: string;
  y: string;
  thresholds: { annexin: number; death: number };
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number };
}): WorkspaceGate[] {
  const prefix = sanitizeId(`apoptosis_${input.sampleId}_${input.parent}_${input.x}_${input.y}`);
  return [
    rectGate({
      id: `${prefix}_viable`,
      name: "Viable (Annexin-/Death dye-)",
      sampleId: input.sampleId,
      parent: input.parent,
      x: input.x,
      y: input.y,
      xMin: input.bounds.xMin,
      xMax: input.thresholds.annexin,
      yMin: input.bounds.yMin,
      yMax: input.thresholds.death,
    }),
    rectGate({
      id: `${prefix}_early_apoptotic`,
      name: "Early apoptotic (Annexin+/Death dye-)",
      sampleId: input.sampleId,
      parent: input.parent,
      x: input.x,
      y: input.y,
      xMin: input.thresholds.annexin,
      xMax: input.bounds.xMax,
      yMin: input.bounds.yMin,
      yMax: input.thresholds.death,
    }),
    rectGate({
      id: `${prefix}_late_apoptotic_dead`,
      name: "Late apoptotic/dead (Annexin+/Death dye+)",
      sampleId: input.sampleId,
      parent: input.parent,
      x: input.x,
      y: input.y,
      xMin: input.thresholds.annexin,
      xMax: input.bounds.xMax,
      yMin: input.thresholds.death,
      yMax: input.bounds.yMax,
    }),
    rectGate({
      id: `${prefix}_necrotic_or_membrane_damaged`,
      name: "Necrotic/membrane damaged (Annexin-/Death dye+)",
      sampleId: input.sampleId,
      parent: input.parent,
      x: input.x,
      y: input.y,
      xMin: input.bounds.xMin,
      xMax: input.thresholds.annexin,
      yMin: input.thresholds.death,
      yMax: input.bounds.yMax,
    }),
  ];
}

function summary(gate: WorkspaceGate, label: string, count: number, denominator: number): PopulationSummary {
  return {
    gateId: gate.id,
    label,
    count,
    percentOfParent: pct(count, denominator),
  };
}

function parentChainForControl(workspace: FlowcytoWorkspace, control: ApoptosisControlInput | undefined): WorkspaceGate[] {
  if (!control?.sampleId || !control.parentGateId) return [];
  return parentGateChain(workspace, { sampleId: control.sampleId, parent: control.parentGateId });
}

export async function suggestApoptosisQuadrants(input: SuggestApoptosisQuadrantsInput): Promise<SuggestApoptosisQuadrantsResult> {
  const workspace = await readWorkspace(input.workspacePath);
  const parent = input.parentGateId ?? "root";
  const compensation = resolveCompensation(workspace, input.compensationId);
  const sampleValues = await readXY({
    path: samplePath(input.workspacePath, workspace, input.sampleId),
    x: input.annexinChannel,
    y: input.deathChannel,
    parentGateChain: parentGateChain(workspace, { sampleId: input.sampleId, parent }),
    compensation,
  });
  if (sampleValues.x.length === 0) {
    throw new FlowcytoError("empty_apoptosis_data", "No finite events are available in the selected apoptosis parent population.", "/parent_gate_id");
  }

  const warnings: string[] = [];
  const controls: SuggestApoptosisQuadrantsResult["diagnostics"]["controls"] = {};
  let thresholds: SuggestApoptosisQuadrantsResult["thresholds"];
  let confidence: SuggestApoptosisQuadrantsResult["diagnostics"]["confidence"];

  if (input.thresholdMethod === "manual" || input.manualAnnexinThreshold !== undefined || input.manualDeathThreshold !== undefined) {
    if (!Number.isFinite(input.manualAnnexinThreshold) || !Number.isFinite(input.manualDeathThreshold)) {
      throw new FlowcytoError("missing_manual_threshold", "Manual apoptosis thresholding requires both manual_annexin_threshold and manual_death_threshold.", "/threshold_method");
    }
    const annexin = input.manualAnnexinThreshold;
    const death = input.manualDeathThreshold;
    if (annexin === undefined || death === undefined) {
      throw new FlowcytoError("missing_manual_threshold", "Manual apoptosis thresholding requires both manual_annexin_threshold and manual_death_threshold.", "/threshold_method");
    }
    thresholds = {
      annexin,
      death,
      method: "manual",
      source: "manual",
    };
    confidence = "manual_thresholds";
  } else if (input.negativeControl) {
    const negativeValues = await readXY({
      path: controlPath(input.workspacePath, workspace, input.negativeControl),
      x: input.annexinChannel,
      y: input.deathChannel,
      parentGateChain: parentChainForControl(workspace, input.negativeControl),
      compensation,
    });
    controls.negative = { events: negativeValues.x.length };
    if (negativeValues.x.length < 100) {
      warnings.push(`Negative control has only ${negativeValues.x.length} finite events after filtering; thresholds may be unstable.`);
    }
    const negativePercentile = input.negativePercentile ?? 99.5;
    if (!Number.isFinite(negativePercentile) || negativePercentile <= 0 || negativePercentile >= 100) {
      throw new FlowcytoError("invalid_negative_percentile", "negative_percentile must be greater than 0 and less than 100.", "/negative_percentile");
    }
    thresholds = {
      annexin: percentile(negativeValues.x, negativePercentile / 100),
      death: percentile(negativeValues.y, negativePercentile / 100),
      method: "negative_control_percentile",
      source: "negative_control",
      negativePercentile,
    };
    confidence = "control_anchored";
  } else {
    const negativePercentile = input.negativePercentile ?? 99.5;
    thresholds = {
      annexin: percentile(sampleValues.x, negativePercentile / 100),
      death: percentile(sampleValues.y, negativePercentile / 100),
      method: "sample_percentile_exploratory",
      source: "exploratory",
      negativePercentile,
    };
    confidence = "exploratory";
    warnings.push("No negative control or manual thresholds were provided. Suggested quadrants are exploratory and should not be used as validated apoptosis calls.");
  }

  if (!Number.isFinite(thresholds.annexin) || !Number.isFinite(thresholds.death)) {
    throw new FlowcytoError("invalid_apoptosis_threshold", "Apoptosis thresholds must be finite.", "/thresholds");
  }

  if (input.positiveControl) {
    const positiveValues = await readXY({
      path: controlPath(input.workspacePath, workspace, input.positiveControl),
      x: input.annexinChannel,
      y: input.deathChannel,
      parentGateChain: parentChainForControl(workspace, input.positiveControl),
      compensation,
    });
    controls.positive = { events: positiveValues.x.length };
  }
  if (input.annexinSinglePositiveControl) {
    const annexinValues = await readXY({
      path: controlPath(input.workspacePath, workspace, input.annexinSinglePositiveControl),
      x: input.annexinChannel,
      y: input.deathChannel,
      compensation,
    });
    controls.annexinSinglePositive = { events: annexinValues.x.length };
  }
  if (input.deathSinglePositiveControl) {
    const deathValues = await readXY({
      path: controlPath(input.workspacePath, workspace, input.deathSinglePositiveControl),
      x: input.annexinChannel,
      y: input.deathChannel,
      compensation,
    });
    controls.deathSinglePositive = { events: deathValues.x.length };
  }

  const xBounds = finiteBounds(sampleValues.x, thresholds.annexin);
  const yBounds = finiteBounds(sampleValues.y, thresholds.death);
  const bounds = {
    xMin: xBounds.min,
    xMax: xBounds.max,
    yMin: yBounds.min,
    yMax: yBounds.max,
  };
  const gates = buildQuadrantGates({
    sampleId: input.sampleId,
    parent,
    x: input.annexinChannel,
    y: input.deathChannel,
    thresholds,
    bounds,
  });
  const counts = countQuadrants(sampleValues, thresholds);
  const denominator = sampleValues.x.length;
  const compensationDiagnostics: AppliedCompensation = sampleValues.compensation ?? {
    applied: false,
    ...(input.compensationId ? { id: input.compensationId } : {}),
  };
  if (sampleValues.compensation?.warnings?.length) warnings.push(...sampleValues.compensation.warnings);

  return {
    ok: true,
    workspacePath: path.resolve(input.workspacePath),
    sampleId: input.sampleId,
    parent,
    axes: {
      x: input.annexinChannel,
      y: input.deathChannel,
    },
    thresholds,
    bounds,
    gates,
    summary: {
      viable: summary(gates[0], "Viable", counts.viable, denominator),
      earlyApoptotic: summary(gates[1], "Early apoptotic", counts.earlyApoptotic, denominator),
      lateApoptoticDead: summary(gates[2], "Late apoptotic/dead", counts.lateApoptoticDead, denominator),
      necroticOrMembraneDamaged: summary(gates[3], "Necrotic/membrane damaged", counts.necroticOrMembraneDamaged, denominator),
    },
    diagnostics: {
      confidence,
      parentEvents: denominator,
      compensation: compensationDiagnostics,
      controls,
      warnings,
    },
    nextAction: {
      tool: "upsert_gates",
      arguments: {
        workspace_path: path.resolve(input.workspacePath),
        expected_revision: workspace.revision,
        gates,
      },
    },
  };
}
