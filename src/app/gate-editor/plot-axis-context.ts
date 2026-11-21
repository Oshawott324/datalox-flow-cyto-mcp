import { buildBiexTransform, FlowcytoError, transformValue, inverseTransformValue, type PanelAxis } from "../../core/index.js";
import type { RenderablePlotContext } from "./server.js";

export function buildPanelAxisMapping(axis: PanelAxis) {
  const scale = axis.scale ?? "linear";
  const params = axis.transform;
  if (scale === "biex") {
    if (!params || ![params.maxRange, params.pos, params.neg, params.width, params.length].every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new FlowcytoError("missing_axis_transform", "Biex rendering requires maxRange, pos, neg, width and length.");
    }
    return buildBiexTransform(params as Required<Omit<NonNullable<PanelAxis["transform"]>, "cofactor">>);
  }
  if (scale === "arcsinh") {
    const cofactor = params?.cofactor;
    if (cofactor === undefined || !Number.isFinite(cofactor) || cofactor <= 0) {
      throw new FlowcytoError("missing_axis_transform", "Arcsinh rendering requires a positive cofactor.");
    }
    return { forward: (value: number) => Math.asinh(value / cofactor), inverse: (value: number) => Math.sinh(value) * cofactor };
  }
  return { forward: (value: number) => transformValue(value, scale), inverse: (value: number) => inverseTransformValue(value, scale) };
}

/** Does not change membership or data-space bins; only the presentation mapping. */
export function configurePlotAxes(context: RenderablePlotContext, axes: { x: PanelAxis; y: PanelAxis }): RenderablePlotContext {
  const scale = { x: axes.x.scale ?? context.scale.x, y: axes.y.scale ?? context.scale.y };
  const mapping = (key: "x" | "y") => axes[key].scale === undefined && axes[key].transform === undefined
    ? { forward: (value: number) => transformValue(value, scale[key]), inverse: (value: number) => inverseTransformValue(value, scale[key]) }
    : buildPanelAxisMapping({ ...axes[key], scale: scale[key] });
  const axisMapping = { x: mapping("x"), y: mapping("y") };
  for (const gate of context.gates) {
    const points = gate.type === "polygon" ? gate.vertices : gate.type === "rect"
      ? [[gate.xMin, gate.yMin], [gate.xMax, gate.yMax]] : [];
    if (points.some(([x, y]) => !Number.isFinite(axisMapping.x.forward(x)) || !Number.isFinite(axisMapping.y.forward(y)))) {
      throw new FlowcytoError("invalid_gate_axis_domain", `Gate ${gate.id} has vertices outside the axis transform domain.`);
    }
  }
  const visualBounds = { ...context.visualBounds };
  const bounds = { ...context.bounds };
  for (const key of ["x", "y"] as const) {
    const explicit = axes[key].bounds;
    const fn = axisMapping[key];
    let min = Infinity;
    let max = -Infinity;
    if (explicit) {
      min = fn.forward(explicit.min);
      max = fn.forward(explicit.max);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
        throw new FlowcytoError("invalid_axis_bounds", `Invalid ${key} bounds for ${scale[key]} scale.`);
      }
      bounds[`${key}Min`] = explicit.min;
      bounds[`${key}Max`] = explicit.max;
    } else {
      const add = (value: number) => {
        const transformed = fn.forward(value);
        if (Number.isFinite(transformed)) { min = Math.min(min, transformed); max = Math.max(max, transformed); }
      };
      const index = key === "x" ? 0 : 1;
      for (const point of context.preview.points ?? []) add(point[index]);
      const bins = context.preview.bins;
      if (bins) {
        const count = key === "x" ? bins.width : bins.height;
        const start = bins[`${key}Min`];
        const end = bins[`${key}Max`];
        for (let i = 0; i <= count; i++) add(start + (end - start) * i / count);
      }
      for (const gate of context.gates) {
        if (gate.type === "polygon") for (const point of gate.vertices) add(point[index]);
        if (gate.type === "rect") { add(gate[`${key}Min`]); add(gate[`${key}Max`]); }
        if (gate.type === "range" && key === "x") { add(gate.min); add(gate.max); }
        if (gate.type === "quadrant") add(gate[key === "x" ? "xThreshold" : "yThreshold"]);
      }
      if (!Number.isFinite(min) || !Number.isFinite(max)) throw new FlowcytoError("empty_axis_domain", `No finite values in the ${key} axis domain; specify bounds.`);
      const padding = min === max ? Math.max(1, Math.abs(min) * 0.06) : (max - min) * 0.06;
      min -= padding;
      max += padding;
    }
    visualBounds[`${key}Min`] = min;
    visualBounds[`${key}Max`] = max;
  }
  return { ...context, scale, axisMapping, bounds, visualBounds };
}
