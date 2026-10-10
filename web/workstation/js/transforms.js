// Axis scales: linear, log and biex (an arcsinh-based biexponential with a
// linear region of +/- width around zero and log decades beyond it).

const LN10 = Math.log(10);

export function makeScale(setting) {
  const kind = setting.scale ?? "linear";
  let min = setting.min ?? 0;
  const max = setting.max ?? 1;
  let forward;
  let inverse;
  if (kind === "log") {
    if (!(min > 0)) min = max / 1e5;
    forward = (v) => Math.log10(v > 0 ? v : min / 10);
    inverse = (t) => 10 ** t;
  } else if (kind === "biex") {
    const width = setting.width > 0 ? setting.width : Math.max(max / 10 ** 4.5, 1e-9);
    forward = (v) => Math.asinh(v / (2 * width)) / LN10;
    inverse = (t) => 2 * width * Math.sinh(t * LN10);
  } else if (kind === "arcsinh") {
    const cofactor = setting.width > 0 ? setting.width : 150;
    forward = (v) => Math.asinh(v / cofactor);
    inverse = (t) => cofactor * Math.sinh(t);
  } else {
    forward = (v) => v;
    inverse = (t) => t;
  }
  const tMin = forward(min);
  const tMax = forward(max);
  return { kind, min, max, forward, inverse, tMin, tMax, ticks: () => ticks(kind, min, max) };
}

function niceStep(span, count) {
  const raw = span / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= raw) return step * power;
  return 10 * power;
}

export function formatLinear(value) {
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  if (abs >= 1e9) return `${+(value / 1e9).toFixed(2)}G`;
  if (abs >= 1e6) return `${+(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${+(value / 1e3).toFixed(2)}K`;
  return `${+value.toFixed(3)}`;
}

function ticks(kind, min, max) {
  const out = [];
  if (kind === "linear") {
    const step = niceStep(max - min, 6);
    for (let value = Math.ceil(min / step) * step; value <= max + step * 1e-9; value += step) {
      out.push({ value, major: true, label: formatLinear(value) });
    }
    return out;
  }
  // decades: 0 and +/-10^k majors (biex), with 2..9 x 10^k minors
  const decade = (sign, power) => ({ value: sign * 10 ** power, major: true, label: { sign, power } });
  if (kind !== "log" && min < 0 && max > 0) out.push({ value: 0, major: true, label: "0" });
  const top = Math.floor(Math.log10(Math.max(Math.abs(max), Math.abs(min), 1e-12)));
  for (let power = -6; power <= top; power += 1) {
    for (const sign of kind === "log" ? [1] : [1, -1]) {
      const value = sign * 10 ** power;
      if (value >= min && value <= max) out.push(decade(sign, power));
      for (let multiple = 2; multiple <= 9; multiple += 1) {
        const minor = sign * multiple * 10 ** power;
        if (minor >= min && minor <= max) out.push({ value: minor, major: false });
      }
    }
  }
  return out.sort((left, right) => left.value - right.value);
}
