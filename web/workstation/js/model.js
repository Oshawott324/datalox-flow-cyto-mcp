// The workspace as the page sees it, and the questions the windows ask of it.

export const ALL_SAMPLES = "__all_samples__";
/** Gate coordinates at or beyond this magnitude mean "open-ended": past the edge of the axis. */
export const OFF_SCALE = 1e12;

export const store = {
  revision: -1,
  workspaceName: "",
  workspace: { samples: [], gates: [], views: [], compensations: [] },
  samples: [],
  axisDefaults: {},
  tree: {},
  /** The group selected in the Groups pane; graph windows step through its samples. */
  currentGroup: ALL_SAMPLES,
};

const listeners = new Set();
export function onChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function emitChange(reason) {
  for (const listener of listeners) listener(reason);
}

export function sampleInfo(sampleId) {
  return store.samples.find((sample) => sample.id === sampleId);
}

export function sampleName(sampleId) {
  return sampleInfo(sampleId)?.name ?? sampleId;
}

export function parametersOf(sampleId) {
  return sampleInfo(sampleId)?.parameters ?? [];
}

export function groups() {
  return [
    { id: ALL_SAMPLES, name: "All Samples", role: "test", samples: store.workspace.samples.map((sample) => sample.id), implicit: true },
    ...(store.workspace.groups ?? []),
  ];
}

export function groupById(groupId) {
  return groups().find((group) => group.id === groupId);
}

export function samplesOfGroup(groupId) {
  const group = groupById(groupId) ?? groups()[0];
  const order = store.workspace.samples.map((sample) => sample.id);
  return order.filter((id) => group.samples.includes(id));
}

export function gateOfPopulation(populationId) {
  return store.workspace.gates.find((gate) => gate.id === populationId
    || (gate.type === "quadrant" && gate.quadrants.some((population) => population.id === populationId)));
}

export function populationName(populationId) {
  if (populationId === "root") return "";
  const gate = gateOfPopulation(populationId);
  if (!gate) return populationId;
  if (gate.type === "quadrant") return gate.quadrants.find((entry) => entry.id === populationId)?.name ?? populationId;
  return gate.name ?? gate.id;
}

export function parentOf(populationId) {
  if (populationId === "root") return null;
  return gateOfPopulation(populationId)?.parent ?? "root";
}

export function namePath(populationId) {
  const names = [];
  let cursor = populationId;
  const seen = new Set();
  while (cursor && cursor !== "root" && !seen.has(cursor)) {
    seen.add(cursor);
    names.unshift(populationName(cursor));
    cursor = parentOf(cursor);
  }
  return names;
}

/** Population ids from the top of the tree down to this one. */
export function populationChain(populationId) {
  const chain = [];
  let cursor = populationId;
  while (cursor && cursor !== "root") {
    chain.unshift(cursor);
    cursor = parentOf(cursor);
  }
  return chain;
}

/** Child populations of a population in one sample, in display order. */
export function childPopulations(sampleId, parentId) {
  const out = [];
  for (const gate of store.workspace.gates) {
    if (gate.sample !== sampleId || gate.parent !== parentId) continue;
    if (gate.type === "quadrant") {
      for (const population of gate.quadrants) out.push({ id: population.id, name: population.name ?? population.id, gate, type: "quadrant" });
    } else {
      out.push({ id: gate.id, name: gate.name ?? gate.id, gate, type: gate.type });
    }
  }
  return out.sort((left, right) => left.name.localeCompare(right.name));
}

/** The population in another sample with the same name path, or its deepest existing ancestor. */
export function matchPopulation(sampleId, names) {
  let parent = "root";
  for (const name of names) {
    const next = childPopulations(sampleId, parent).find((population) => population.name === name);
    if (!next) return { populationId: parent, exact: false };
    parent = next.id;
  }
  return { populationId: parent, exact: true };
}

export function counts(sampleId, populationId) {
  const sample = store.tree[sampleId];
  if (!sample) return null;
  if (populationId === "root") return { count: sample.total, parentCount: sample.total };
  return sample.populations[populationId] ?? null;
}

export function compensationOf(sampleId) {
  return store.workspace.sampleCompensation?.[sampleId] ?? null;
}

export function compensationById(compensationId) {
  return (store.workspace.compensations ?? []).find((matrix) => matrix.id === compensationId);
}

export function compensationLabel(compensationId) {
  const matrix = compensationById(compensationId);
  if (!matrix) return compensationId ?? "";
  return matrix.name && matrix.name !== matrix.id ? `${matrix.id} (${matrix.name})` : matrix.id;
}

/** Whether a parameter is shown compensated in a sample. */
export function isCompensated(sampleId, parameter) {
  const matrix = compensationById(compensationOf(sampleId));
  if (!matrix) return false;
  const info = parametersOf(sampleId).find((entry) => entry.name === parameter);
  return matrix.channels.some((channel) => channel === parameter || (info && (channel === info.detector || channel === info.marker)));
}

export function parameterLabel(sampleId, parameter) {
  const info = parametersOf(sampleId).find((entry) => entry.name === parameter);
  const base = info && info.marker && info.marker !== info.name ? `${info.name} :: ${info.marker}` : parameter;
  return isCompensated(sampleId, parameter) ? `Comp-${base}` : base;
}

export function axisSetting(parameter) {
  return store.workspace.axes?.[parameter] ?? store.axisDefaults[parameter] ?? { scale: "linear", min: 0, max: 1 };
}

export function isFluorescence(parameter) {
  return store.axisDefaults[parameter]?.scale === "biex";
}

export function defaultAxes(sampleId) {
  const names = parametersOf(sampleId).map((parameter) => parameter.name);
  const pick = (patterns) => patterns.map((pattern) => names.find((name) => pattern.test(name))).find(Boolean);
  return {
    x: pick([/^FSC.*-A$/i, /^FS.*-A$/i, /^FSC/i]) ?? names[0],
    y: pick([/^SSC.*-A$/i, /^SS.*-A$/i, /^SSC/i]) ?? names[1] ?? names[0],
  };
}

let idCounter = 0;
export function newId(prefix) {
  const slug = String(prefix).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "gate";
  idCounter += 1;
  return `${slug}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function uniqueName(sampleId, base) {
  const taken = new Set(store.workspace.gates.filter((gate) => gate.sample === sampleId).flatMap((gate) =>
    gate.type === "quadrant" ? gate.quadrants.map((population) => population.name) : [gate.name]));
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) if (!taken.has(`${base} ${index}`)) return `${base} ${index}`;
}

// ------------------------------------------------------------ gate geometry

export function pointInPolygon(px, py, vertices) {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i, i += 1) {
    const [xi, yi] = vertices[i];
    const [xj, yj] = vertices[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Whether an event (x, y) is in a gate, or in one quadrant population of a quadrant gate. */
export function gateContains(gate, x, y, quadrantPopulation) {
  if (gate.type === "range") return x >= gate.min && x <= gate.max;
  if (gate.type === "rect") return x >= gate.xMin && x <= gate.xMax && y >= gate.yMin && y <= gate.yMax;
  if (gate.type === "polygon") return pointInPolygon(x, y, gate.vertices);
  if (gate.type === "quadrant" && quadrantPopulation) {
    const xOk = quadrantPopulation.x === "+" ? x >= gate.xThreshold : x < gate.xThreshold;
    const yOk = quadrantPopulation.y === "+" ? y >= gate.yThreshold : y < gate.yThreshold;
    return xOk && yOk;
  }
  return false;
}

export function formatValue(value) {
  if (!Number.isFinite(value)) return "";
  if (value >= OFF_SCALE) return "∞";
  if (value <= -OFF_SCALE) return "-∞";
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e7 || abs < 1e-3)) return value.toExponential(4).replace(/\.?0+e/, "e");
  return String(Math.round(value * 1000) / 1000);
}

export function parseValue(text) {
  const value = String(text).trim().toLowerCase().replace(/,/g, "");
  if (["∞", "inf", "+inf", "infinity", "+∞", "max"].includes(value)) return OFF_SCALE;
  if (["-∞", "-inf", "-infinity", "min"].includes(value)) return -OFF_SCALE;
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/.test(value)) return Number.NaN;
  return Number(value);
}
