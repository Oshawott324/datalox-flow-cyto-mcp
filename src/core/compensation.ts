import { Matrix, solve } from "ml-matrix";

import {
  FlowcytoError,
  type AppliedCompensation,
  type CompensationDiagnostics,
  type CompensationKeyword,
  type CompensationMatrix,
  type CompensationStatus,
} from "./types.js";

export const SPILLOVER_KEYS: CompensationKeyword[] = ["$SPILLOVER", "SPILLOVER", "$COMP", "COMP", "$SPILL", "SPILL"];

export type ParsedCompensationMatrix = {
  channels: string[];
  matrix: number[][];
};

export type AlignmentResult = {
  compensation: CompensationMatrix;
  warnings: string[];
};

export type AvailableCompensationChannel = string | {
  name: string;
  detector?: string;
  marker?: string;
};

export type ExtractionResult = {
  compensations: CompensationMatrix[];
  diagnostics: CompensationDiagnostics;
};

function isFiniteMatrix(matrix: number[][]): boolean {
  return matrix.every((row) => row.every((value) => Number.isFinite(value)));
}

function assertSquareMatrix(channels: string[], matrix: number[][], pathValue = "/matrix"): void {
  if (channels.length === 0) {
    throw new FlowcytoError("invalid_compensation_matrix", "Compensation matrix must include at least one channel.", "/channels");
  }
  if (matrix.length !== channels.length) {
    throw new FlowcytoError("invalid_compensation_matrix", "Compensation matrix row count must match channels length.", pathValue);
  }
  matrix.forEach((row, index) => {
    if (!Array.isArray(row) || row.length !== channels.length) {
      throw new FlowcytoError("invalid_compensation_matrix", `Compensation matrix row ${index} must match channels length.`, `${pathValue}/${index}`);
    }
  });
  if (!isFiniteMatrix(matrix)) {
    throw new FlowcytoError("invalid_compensation_matrix", "Compensation matrix values must be finite numbers.", pathValue);
  }
}

function splitDelimited(input: string): string[] {
  const normalized = input.trim().replace(/;/g, ",");
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const ch = normalized[index];
    if (ch === "\"") {
      if (quoted && normalized[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (ch === "," && !quoted) {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  values.push(current.trim());
  return values.filter((value) => value.length > 0);
}

function parseNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new FlowcytoError("invalid_compensation_matrix", `Invalid compensation matrix value ${value}.`, "/matrix");
  }
  return parsed;
}

export function normalizeDetectorToken(value: string): string {
  return value.toLowerCase().replace(/[ _-]/g, "");
}

export function normalizeCompensationKeyword(value: string): string {
  return value.replace(/^\$/, "").toLowerCase();
}

export function compensationIdForKeyword(keyword: CompensationKeyword, sampleId: string): string {
  const sample = sampleId.replace(/[^A-Za-z0-9._-]+/g, "_");
  return `fcs_${normalizeCompensationKeyword(keyword)}_${sample}`;
}

function resolveParsedChannels(channels: string[], availableChannels: string[]): string[] {
  return channels.map((channel) => {
    const parameterNumber = Number.parseInt(channel, 10);
    if (/^\d+$/.test(channel) && parameterNumber >= 1 && parameterNumber <= availableChannels.length) {
      return availableChannels[parameterNumber - 1] ?? channel;
    }
    return channel;
  });
}

export function parseSpilloverText(value: string): ParsedCompensationMatrix {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new FlowcytoError("invalid_compensation_matrix", "Spillover keyword is empty.", "/keywords");
  }

  const cells = splitDelimited(trimmed);
  const size = Number.parseInt(cells[0] ?? "", 10);
  if (Number.isInteger(size) && size > 0) {
    const channels = cells.slice(1, 1 + size);
    const values = cells.slice(1 + size).map(parseNumber);
    if (channels.length !== size || values.length !== size * size) {
      throw new FlowcytoError("invalid_compensation_matrix", "BD-style spillover text does not match declared matrix size.", "/keywords");
    }
    const matrix = Array.from({ length: size }, (_, row) => values.slice(row * size, (row + 1) * size));
    assertSquareMatrix(channels, matrix);
    return { channels, matrix };
  }

  const rows = trimmed
    .replace(/;/g, ",")
    .split(/\r?\n/)
    .map((row) => splitDelimited(row))
    .filter((row) => row.length > 0);
  if (rows.length >= 2) {
    const channels = rows[0];
    const matrix = rows.slice(1).map((row) => row.map(parseNumber));
    if (matrix.length === channels.length && matrix.every((row) => row.length === channels.length)) {
      assertSquareMatrix(channels, matrix);
      return { channels, matrix };
    }
  }

  throw new FlowcytoError("invalid_compensation_matrix", "Unsupported spillover keyword format.", "/keywords");
}

export function extractSpilloverMatrices(input: {
  keywords: Record<string, string>;
  sampleId: string;
  availableChannels: string[];
}): ExtractionResult {
  const keywordsFound: string[] = [];
  const unparsedKeywordCandidates: string[] = [];
  const compensations: CompensationMatrix[] = [];

  for (const keyword of SPILLOVER_KEYS) {
    const raw = input.keywords[keyword];
    if (typeof raw !== "string" || raw.trim().length === 0) continue;
    keywordsFound.push(keyword);
    try {
      const parsed = parseSpilloverText(raw);
      const channels = resolveParsedChannels(parsed.channels, input.availableChannels);
      compensations.push({
        id: compensationIdForKeyword(keyword, input.sampleId),
        name: `FCS ${keyword}`,
        source: "fcs_keyword",
        sample: input.sampleId,
        keyword,
        channels,
        matrix: parsed.matrix,
      });
    } catch {
      unparsedKeywordCandidates.push(keyword);
    }
  }

  const diagnostics: CompensationDiagnostics = {
    keywordsScanned: SPILLOVER_KEYS,
    keywordsFound,
    unparsedKeywordCandidates,
    availableChannels: input.availableChannels,
  };
  return { compensations, diagnostics };
}

function detectorCore(value: string): string {
  return value.replace(/^(?:FJComp-|Comp-|C_)/i, "").replace(/-(?:A|H|W)$/i, "");
}

function availableChannelMap(availableChannels: AvailableCompensationChannel[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const channel of availableChannels) {
    const name = typeof channel === "string" ? channel : channel.name;
    const aliases = typeof channel === "string"
      ? [channel]
      : [channel.name, channel.detector, channel.marker].filter((value): value is string => typeof value === "string" && value.length > 0);
    const keys = new Set(aliases.flatMap((alias) => [normalizeDetectorToken(alias), normalizeDetectorToken(detectorCore(alias))]));
    keys.forEach((key) => {
      const existing = map.get(key) ?? [];
      existing.push(name);
      map.set(key, existing);
    });
  }
  return map;
}

export function alignCompensationMatrix(
  compensation: CompensationMatrix,
  availableChannels: AvailableCompensationChannel[],
): AlignmentResult {
  assertSquareMatrix(compensation.channels, compensation.matrix);
  const channelMap = availableChannelMap(availableChannels);
  const matched: Array<{ originalIndex: number; availableChannel: string }> = [];
  const warnings: string[] = [];

  compensation.channels.forEach((channel, originalIndex) => {
    const exactKey = normalizeDetectorToken(channel);
    const coreKey = normalizeDetectorToken(detectorCore(channel));
    const exactCandidates = [...new Set(channelMap.get(exactKey) ?? [])];
    const candidates = exactCandidates.length > 0
      ? exactCandidates
      : [...new Set(channelMap.get(coreKey) ?? [])];
    if (candidates.length === 0) {
      warnings.push(`Matrix channel ${channel} did not match any available sample channel.`);
      return;
    }
    if (candidates.length > 1) {
      throw new FlowcytoError(
        "ambiguous_compensation_channel_alignment",
        `Matrix channel ${channel} matched multiple sample channels: ${candidates.join(", ")}.`,
        "/compensation_id",
      );
    }
    matched.push({ originalIndex, availableChannel: candidates[0] });
  });

  if (matched.length === 0) {
    throw new FlowcytoError("compensation_alignment_failed", "No compensation matrix channels match sample channels.", "/compensation_id");
  }

  const channels = matched.map((entry) => entry.availableChannel);
  const matrix = matched.map((row) => matched.map((column) => compensation.matrix[row.originalIndex][column.originalIndex]));
  return {
    compensation: {
      ...compensation,
      channels,
      matrix,
    },
    warnings,
  };
}

function solveCompensatedRows(values: number[][], matrix: number[][]): number[][] {
  const spill = new Matrix(matrix);
  const observed = new Matrix(values);
  try {
    return solve(spill.transpose(), observed.transpose()).transpose().to2DArray();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FlowcytoError("singular_compensation_matrix", `Unable to solve compensation matrix: ${message}.`, "/compensation_id");
  }
}

export function applyCompensationColumns(input: {
  values: number[][];
  channels: string[];
  compensation: CompensationMatrix;
}): { values: number[][]; compensation: AppliedCompensation } {
  assertSquareMatrix(input.compensation.channels, input.compensation.matrix);
  const indexes = input.compensation.channels.map((channel) => input.channels.indexOf(channel));
  if (indexes.some((index) => index === -1)) {
    throw new FlowcytoError("compensation_alignment_failed", "Aligned compensation channels are not present in the requested values.", "/compensation_id");
  }
  const selected = input.values.map((row) => indexes.map((index) => row[index]));
  const compensated = solveCompensatedRows(selected, input.compensation.matrix);
  const output = input.values.map((row, rowIndex) => {
    const next = [...row];
    indexes.forEach((columnIndex, compensatedIndex) => {
      next[columnIndex] = compensated[rowIndex][compensatedIndex];
    });
    return next;
  });
  return {
    values: output,
    compensation: {
      applied: true,
      id: input.compensation.id,
      source: input.compensation.source,
      channels: input.compensation.channels,
    },
  };
}

function looksLikeFluorochromeChannel(channel: string): boolean {
  if (/^(?:fitc|pe|apc|percp|bv\d+|buv\d+|efluor\d+|af\d+|alexa\d+)-(?:A|H|W)$/i.test(channel)) {
    return false;
  }
  return /\b(?:fitc|pe|apc|percp|cy7|bv\d+|buv\d+|pacific|efluor|alexa|af\d+)\b/i.test(channel)
    && !/^[A-Z]\d+[-_ ]?A$/i.test(channel);
}

export function detectCompensationStatus(input: {
  keywords: Record<string, string>;
  channels: string[];
  compensations: CompensationMatrix[];
}): CompensationStatus {
  const signals: string[] = [];
  const strongSignals: string[] = [];
  if (input.channels.some((channel) => /^FJComp-/i.test(channel))) strongSignals.push("FJComp-prefixed channels detected");
  if (input.channels.some((channel) => /^Comp-/i.test(channel))) strongSignals.push("Comp-prefixed channels detected");
  if (input.channels.some((channel) => /^C_/i.test(channel))) strongSignals.push("C_-prefixed channels detected");

  const cyt = input.keywords.$CYT ?? input.keywords.CYT ?? "";
  if (/aurora|cytoflex|spectroflo/i.test(cyt)) strongSignals.push(`Spectral cytometer keyword detected: ${cyt}`);
  signals.push(...strongSignals);
  if (input.channels.filter(looksLikeFluorochromeChannel).length >= 2) {
    signals.push("Fluorochrome-like channel names detected");
  }

  const embeddedMatrixFound = input.compensations.length > 0;
  const detectedAsPreCompensated = strongSignals.length > 0;
  const suggestedCompensationId = embeddedMatrixFound && input.compensations.length === 1 && !detectedAsPreCompensated
    ? input.compensations[0].id
    : undefined;
  let recommendation = "No embedded compensation matrix was discovered.";
  if (detectedAsPreCompensated && embeddedMatrixFound) {
    recommendation = "Data appears pre-compensated or pre-unmixed. Applying the embedded matrix may double-compensate the sample.";
  } else if (detectedAsPreCompensated) {
    recommendation = "Data appears pre-compensated or pre-unmixed. Confirm acquisition/export processing before applying additional compensation.";
  } else if (embeddedMatrixFound) {
    recommendation = "Embedded compensation matrix is available. Confirm whether data was already compensated at acquisition before applying it.";
  }
  return {
    detectedAsPreCompensated,
    signals,
    embeddedMatrixFound,
    ...(suggestedCompensationId ? { suggestedCompensationId } : {}),
    recommendation,
  };
}

export function compensationDiagnosticsForWorkspace(input: {
  workspaceCompensations: CompensationMatrix[];
  sampleId?: string;
  availableChannels: string[];
}): CompensationDiagnostics {
  const matrices = input.workspaceCompensations.filter((matrix) => !input.sampleId || matrix.sample === input.sampleId || matrix.sample === undefined);
  return {
    keywordsScanned: SPILLOVER_KEYS,
    keywordsFound: matrices.flatMap((matrix) => matrix.keyword ? [matrix.keyword] : []),
    unparsedKeywordCandidates: [],
    availableChannels: input.availableChannels,
    ...(matrices[0] ? { matrixChannels: matrices[0].channels } : {}),
  };
}
