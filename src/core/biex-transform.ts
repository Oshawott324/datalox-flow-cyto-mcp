import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { FlowcytoError } from "./types.js";

export type BiexParams = {
  maxRange: number;
  pos: number;
  neg: number;
  width: number;
  length: number;
};

export type BiexTransform = {
  forward: (x: number) => number;
  inverse: (y: number) => number;
};

type BiexSpline = {
  x: number[];
  y: number[];
  b: number[];
  c: number[];
  d: number[];
};

type BiexReferenceCase = {
  label: string;
  parameters: BiexParams;
  forwardSpline: BiexSpline;
  inverseSpline: BiexSpline;
};

type BiexReference = {
  generator: string;
  cases: BiexReferenceCase[];
};

const PARAM_EPSILON = 1e-9;

let cachedReference: BiexReference | null = null;

function referencePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../testdata/fixtures/biex-transform-reference.json"),
    path.resolve(here, "../../../testdata/fixtures/biex-transform-reference.json"),
  ];
  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) {
    throw new FlowcytoError(
      "missing_flowjo_biex_reference",
      "FlowJo biex reference table is missing from the installed package.",
      "/testdata/fixtures/biex-transform-reference.json",
    );
  }
  return match;
}

function readReference(): BiexReference {
  if (cachedReference) return cachedReference;
  cachedReference = JSON.parse(readFileSync(referencePath(), "utf8")) as BiexReference;
  return cachedReference;
}

function finiteParam(value: number, name: keyof BiexParams): number {
  if (!Number.isFinite(value)) {
    throw new FlowcytoError("invalid_flowjo_biex_parameters", `FlowJo biex ${name} must be finite.`, "/transforms/biex");
  }
  return value;
}

function normalizeParams(params: BiexParams): BiexParams {
  return {
    length: finiteParam(params.length, "length"),
    maxRange: finiteParam(params.maxRange, "maxRange"),
    pos: finiteParam(params.pos, "pos"),
    neg: finiteParam(params.neg, "neg"),
    width: finiteParam(params.width, "width"),
  };
}

function sameParam(left: number, right: number): boolean {
  return Math.abs(left - right) <= PARAM_EPSILON * Math.max(1, Math.abs(left), Math.abs(right));
}

function sameParams(left: BiexParams, right: BiexParams): boolean {
  return sameParam(left.length, right.length)
    && sameParam(left.maxRange, right.maxRange)
    && sameParam(left.pos, right.pos)
    && sameParam(left.neg, right.neg)
    && sameParam(left.width, right.width);
}

function findReferenceCase(params: BiexParams): BiexReferenceCase {
  const normalized = normalizeParams(params);
  const match = readReference().cases.find((entry) => sameParams(entry.parameters, normalized));
  if (!match) {
    throw new FlowcytoError(
      "unsupported_flowjo_biex_parameters",
      `FlowJo biex parameters are not in the validated reference table: length=${normalized.length}, maxRange=${normalized.maxRange}, pos=${normalized.pos}, neg=${normalized.neg}, width=${normalized.width}.`,
      "/transforms/biex",
    );
  }
  return match;
}

function splineInterval(spline: BiexSpline, value: number): number {
  const last = spline.x.length - 1;
  if (last < 1) {
    throw new FlowcytoError("invalid_flowjo_biex_reference", "FlowJo biex spline has fewer than two knots.", "/transforms/biex");
  }
  if (value <= spline.x[0]) return 0;
  if (value >= spline.x[last]) return last - 1;
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (spline.x[mid] <= value) low = mid;
    else high = mid;
  }
  return low;
}

function evaluateSpline(spline: BiexSpline, value: number): number {
  if (!Number.isFinite(value)) {
    throw new FlowcytoError("invalid_flowjo_biex_coordinate", "FlowJo biex coordinate must be finite.", "/transforms/biex");
  }
  if (value <= spline.x[0]) return spline.y[0] + (value - spline.x[0]) * spline.b[0];
  const last = spline.x.length - 1;
  if (value >= spline.x[last]) return spline.y[last] + (value - spline.x[last]) * spline.b[last];
  const index = splineInterval(spline, value);
  const dx = value - spline.x[index];
  return spline.y[index] + dx * (spline.b[index] + dx * (spline.c[index] + dx * spline.d[index]));
}

export function buildBiexTransform(params: BiexParams): BiexTransform {
  const entry = findReferenceCase(params);
  return {
    forward: (x) => evaluateSpline(entry.forwardSpline, x),
    inverse: (y) => evaluateSpline(entry.inverseSpline, y),
  };
}
