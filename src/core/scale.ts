import type { AxisScale } from "./types.js";

const ARCSINH_COFACTOR = 150;
const BIEXP_COFACTOR = 150;
const BIEXP_WIDTH = 4.5;

export type PlotBounds = {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
};

export function transformValue(value: number, scale: AxisScale): number {
  if (scale === "arcsinh") return Math.asinh(value / ARCSINH_COFACTOR);
  if (scale === "log") return value > 0 ? Math.log10(value) : Number.NaN;
  if (scale === "biex") {
    const normalized = value / BIEXP_COFACTOR;
    return Math.sign(normalized) * Math.log10(1 + Math.abs(normalized) * BIEXP_WIDTH) / Math.log10(1 + BIEXP_WIDTH);
  }
  return value;
}

export function inverseTransformValue(value: number, scale: AxisScale): number {
  if (scale === "arcsinh") return Math.sinh(value) * ARCSINH_COFACTOR;
  if (scale === "log") return 10 ** value;
  if (scale === "biex") {
    const magnitude = ((1 + BIEXP_WIDTH) ** Math.abs(value) - 1) / BIEXP_WIDTH;
    return Math.sign(value) * magnitude * BIEXP_COFACTOR;
  }
  return value;
}

export function transformPoint(point: [number, number], scale: { x: AxisScale; y: AxisScale }): [number, number] {
  return [transformValue(point[0], scale.x), transformValue(point[1], scale.y)];
}

export function inverseTransformPoint(point: [number, number], scale: { x: AxisScale; y: AxisScale }): [number, number] {
  return [inverseTransformValue(point[0], scale.x), inverseTransformValue(point[1], scale.y)];
}

function linearTicks(min: number, max: number, count: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || count < 2) return [];
  const step = (max - min) / (count - 1);
  return Array.from({ length: count }, (_entry, index) => min + step * index);
}

export function generateTicks(min: number, max: number, count = 6): number[] {
  return linearTicks(min, max, count);
}

export function formatTick(value: number): string {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(1).replace(/\.0$/, "");
  return value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

export function includePoint(bounds: PlotBounds, point: [number, number]): void {
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return;
  bounds.xMin = Math.min(bounds.xMin, point[0]);
  bounds.xMax = Math.max(bounds.xMax, point[0]);
  bounds.yMin = Math.min(bounds.yMin, point[1]);
  bounds.yMax = Math.max(bounds.yMax, point[1]);
}

export function normalizeBounds(bounds: PlotBounds, padding = 0.06): PlotBounds {
  const next = { ...bounds };
  if (!Number.isFinite(next.xMin) || !Number.isFinite(next.xMax) || next.xMin === next.xMax) {
    next.xMin = 0;
    next.xMax = 1;
  }
  if (!Number.isFinite(next.yMin) || !Number.isFinite(next.yMax) || next.yMin === next.yMax) {
    next.yMin = 0;
    next.yMax = 1;
  }
  const xPad = (next.xMax - next.xMin) * padding;
  const yPad = (next.yMax - next.yMin) * padding;
  return {
    xMin: next.xMin - xPad,
    xMax: next.xMax + xPad,
    yMin: next.yMin - yPad,
    yMax: next.yMax + yPad,
  };
}
