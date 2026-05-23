export type Rgba = [number, number, number, number];
export type DensityColorMode = "pseudocolor" | "density";

function interpolate(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

export function densityColor(t: number, mode: DensityColorMode = "pseudocolor"): Rgba {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  if (mode === "density") {
    const value = Math.round(255 - 210 * clamped);
    return [value, value, 255, 255];
  }
  const stops: Array<[number, [number, number, number]]> = [
    [0.00, [21, 39, 86]],
    [0.30, [18, 145, 171]],
    [0.55, [53, 180, 98]],
    [0.78, [247, 208, 63]],
    [1.00, [188, 37, 42]],
  ];
  for (let index = 1; index < stops.length; index += 1) {
    const previous = stops[index - 1]!;
    const next = stops[index]!;
    if (clamped <= next[0]) {
      const local = (clamped - previous[0]) / (next[0] - previous[0]);
      return [
        interpolate(previous[1][0], next[1][0], local),
        interpolate(previous[1][1], next[1][1], local),
        interpolate(previous[1][2], next[1][2], local),
        255,
      ];
    }
  }
  return [188, 37, 42, 255];
}

export function rgbaCss([red, green, blue, alpha]: Rgba): string {
  return `rgba(${red},${green},${blue},${alpha / 255})`;
}
