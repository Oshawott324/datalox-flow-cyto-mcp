// The graph window: one population of one sample on a plot, with FlowJo's gate
// tools, gate editing by mouse and keyboard, and manual gate entry (Ctrl+G).

import {
  KEEP_OPEN, checkbox, confirmDialog, createWindow, dialog, dropdown, el, formatCount, formatPercent,
  openMenu, promptDialog, radioGroup,
} from "./ui.js";
import {
  OFF_SCALE, axisSetting, childPopulations, counts, defaultAxes, formatValue, gateContains, gateOfPopulation,
  matchPopulation, namePath, newId, onChange, parametersOf, parameterLabel, parentOf, parseValue, populationChain,
  populationName, sampleName, samplesOfGroup, store, uniqueName, ALL_SAMPLES,
} from "./model.js";
import { makeScale, formatLinear } from "./transforms.js";
import { canRedo, canUndo, fetchEvents, redo, runOp, setStatus, undo } from "./actions.js";

export const HISTOGRAM = "__histogram__";
const CANVAS_W = 540;
const CANVAS_H = 470;
const PLOT = { x: 60, y: 10, w: CANVAS_W - 60 - 12, h: CANVAS_H - 10 - 38 };
const EDGE = 2;
const PLOT_TYPES = [
  { value: "pseudocolor", label: "Pseudocolor" },
  { value: "dot", label: "Dot Plot" },
  { value: "density", label: "Density" },
  { value: "histogram", label: "Histogram" },
];
const TOOLS_2D = [
  { tool: "rect", icon: "▭", label: "Rectangle gate" },
  { tool: "polygon", icon: "⬠", label: "Polygon gate" },
  { tool: "freehand", icon: "✎", label: "Freehand gate" },
  { tool: "quadrant", icon: "⊞", label: "Quadrant gate" },
];
const TOOLS_1D = [
  { tool: "range", icon: "↔", label: "Range gate" },
  { tool: "bisector", icon: "⊥", label: "Bisector gate" },
];

let opened = 0;

export function openGraphWindow(options) {
  return new GraphWindow(options);
}

function chooseAxes(sampleId, populationId, fallback) {
  const parameters = new Set(parametersOf(sampleId).map((parameter) => parameter.name));
  const child = childPopulations(sampleId, populationId)[0]?.gate;
  if (child) return { x: child.x, y: child.type === "range" ? HISTOGRAM : child.y };
  if (fallback && parameters.has(fallback.x) && (fallback.y === HISTOGRAM || parameters.has(fallback.y))) return fallback;
  return defaultAxes(sampleId);
}

function cloneGate(gate) {
  return JSON.parse(JSON.stringify(gate));
}

function shortName(parameter) {
  return parameter.replace(/\s*\(.*?\)/g, "");
}

function pseudocolor(t) {
  const stops = [[0, [30, 30, 210]], [0.25, [0, 160, 255]], [0.5, [0, 200, 90]], [0.75, [255, 215, 0]], [1, [230, 25, 25]]];
  for (let index = 1; index < stops.length; index += 1) {
    const [t1, c1] = stops[index];
    const [t0, c0] = stops[index - 1];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return `rgb(${c0.map((c, k) => Math.round(c + (c1[k] - c) * f)).join(",")})`;
    }
  }
  return "rgb(230,25,25)";
}

class GraphWindow {
  constructor({ sampleId, populationId = "root", axes, x, y }) {
    this.sampleId = sampleId;
    this.populationId = populationId;
    const chosen = chooseAxes(sampleId, populationId, axes);
    this.x = chosen.x;
    this.y = chosen.y;
    this.lastY = this.y === HISTOGRAM ? defaultAxes(sampleId).y : this.y;
    this.plotType = this.y === HISTOGRAM ? "histogram" : "pseudocolor";
    this.tool = "pointer";
    this.selected = null;
    this.events = null;
    this.draft = null;
    this.drag = null;
    this.loadToken = 0;
    const offset = (opened++ % 8) * 26;
    this.win = createWindow({
      title: "",
      x: x ?? 330 + offset,
      y: y ?? 40 + offset,
      width: CANVAS_W + 50,
      height: CANVAS_H + 156,
      className: "graph-window",
      onClose: () => this.unsubscribe(),
      onKey: (event) => this.onKey(event),
    });
    this.build();
    this.unsubscribe = onChange(() => this.onStoreChange());
    this.refreshChrome();
    this.load();
  }

  // ------------------------------------------------------------- layout

  build() {
    this.toolButtons = new Map();
    const toolbar = el("div", { class: "toolbar", role: "toolbar", "aria-label": "Gate tools" });
    for (const entry of [...TOOLS_2D, ...TOOLS_1D]) {
      const button = el("button", { class: "tool", title: entry.label, "aria-label": entry.label, "aria-pressed": "false", text: entry.icon });
      button.addEventListener("click", () => this.setTool(this.tool === entry.tool ? "pointer" : entry.tool));
      this.toolButtons.set(entry.tool, button);
      toolbar.append(button);
    }
    toolbar.append(el("span", { class: "sep" }));
    this.undoButton = el("button", { class: "tool", title: "Undo (Ctrl+Z)", "aria-label": "Undo", text: "↶", onclick: () => undo() });
    this.redoButton = el("button", { class: "tool", title: "Redo (Ctrl+Y)", "aria-label": "Redo", text: "↷", onclick: () => redo() });
    toolbar.append(this.undoButton, this.redoButton, el("span", { class: "sep" }));
    this.prevButton = el("button", { class: "tool", title: "Previous sample", "aria-label": "Previous sample", text: "◀", onclick: () => this.stepSample(-1) });
    this.upButton = el("button", { class: "tool", title: "Parent population", "aria-label": "Parent population", text: "▲", onclick: () => this.goToParent() });
    this.nextButton = el("button", { class: "tool", title: "Next sample", "aria-label": "Next sample", text: "▶", onclick: () => this.stepSample(1) });
    toolbar.append(this.prevButton, this.upButton, this.nextButton, el("span", { class: "spacer" }));
    const graphMenu = el("button", { class: "tool text", "aria-haspopup": "menu", "aria-label": "Graph menu", text: "Graph ▾" });
    graphMenu.addEventListener("click", () => openMenu(this.graphMenuItems(), graphMenu));
    toolbar.append(graphMenu);

    this.breadcrumb = el("div", { class: "breadcrumb", "aria-label": "Population path" });

    this.canvas = el("canvas", { class: "plot-canvas", "aria-label": "Plot", role: "img" });
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = CANVAS_W * ratio;
    this.canvas.height = CANVAS_H * ratio;
    this.canvas.style.width = `${CANVAS_W}px`;
    this.canvas.style.height = `${CANVAS_H}px`;
    this.ctx = this.canvas.getContext("2d");
    this.ctx.scale(ratio, ratio);
    this.canvas.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    this.canvas.addEventListener("pointermove", (event) => this.onPointerMove(event));
    this.canvas.addEventListener("pointerup", (event) => this.onPointerUp(event));
    this.canvas.addEventListener("dblclick", (event) => this.onDoubleClick(event));
    this.canvas.addEventListener("contextmenu", (event) => this.onContextMenu(event));

    this.yButton = el("button", { class: "axis-button", "aria-haspopup": "menu" });
    this.yButton.addEventListener("click", () => this.openAxisMenu("y"));
    this.yT = el("button", { class: "t-button", title: "Y axis transform", "aria-label": "Y axis transform", text: "T" });
    this.yT.addEventListener("click", () => this.openTransformMenu("y"));
    this.xButton = el("button", { class: "axis-button", "aria-haspopup": "menu" });
    this.xButton.addEventListener("click", () => this.openAxisMenu("x"));
    this.xT = el("button", { class: "t-button", title: "X axis transform", "aria-label": "X axis transform", text: "T" });
    this.xT.addEventListener("click", () => this.openTransformMenu("x"));

    const frame = el("div", { class: "plot-frame" },
      el("div", { class: "y-axis-control" }, this.yButton, this.yT),
      this.canvas,
      el("div", { class: "x-axis-control" }, this.xButton, this.xT));

    this.typeDropdown = dropdown({
      label: "Plot type",
      options: () => PLOT_TYPES,
      value: this.plotType,
      onChange: (value) => this.setPlotType(value),
    });
    this.statsNode = el("span", { class: "stats", role: "status" });
    const options = el("div", { class: "options-bar" }, el("span", { text: "Type" }), this.typeDropdown.node, this.statsNode);
    this.win.body.append(toolbar, this.breadcrumb, frame, options);
  }

  refreshChrome() {
    const histogram = this.y === HISTOGRAM;
    const name = this.populationId === "root" ? "All events" : populationName(this.populationId);
    this.win.setTitle(`${sampleName(this.sampleId)} — ${name}`);
    for (const [tool, button] of this.toolButtons) {
      const allowed = histogram ? TOOLS_1D.some((entry) => entry.tool === tool) : TOOLS_2D.some((entry) => entry.tool === tool);
      button.disabled = !allowed;
      button.hidden = !allowed;
      button.classList.toggle("active", this.tool === tool);
      button.setAttribute("aria-pressed", String(this.tool === tool));
    }
    this.canvas.classList.toggle("pointer", this.tool === "pointer");
    this.undoButton.disabled = !canUndo();
    this.redoButton.disabled = !canRedo();
    this.upButton.disabled = this.populationId === "root";
    const group = this.groupSamples();
    this.prevButton.disabled = group.indexOf(this.sampleId) <= 0;
    this.nextButton.disabled = group.indexOf(this.sampleId) < 0 || group.indexOf(this.sampleId) >= group.length - 1;

    this.breadcrumb.replaceChildren();
    const tube = el("button", { class: "crumb", title: "Samples in this group", "aria-label": `Sample: ${sampleName(this.sampleId)}`, "aria-haspopup": "menu", text: `🧪 ${sampleName(this.sampleId)} ▾` });
    tube.addEventListener("click", () => openMenu(group.map((id) => ({
      label: sampleName(id),
      checked: id === this.sampleId,
      action: () => this.switchSample(id),
    })), tube));
    this.breadcrumb.append(tube);
    for (const id of populationChain(this.populationId)) {
      this.breadcrumb.append(el("span", { class: "crumb-sep", text: "›" }));
      const current = id === this.populationId;
      const crumb = el("button", { class: `crumb${current ? " current" : ""}`, text: populationName(id), "aria-label": `Population ${populationName(id)}`, "aria-current": current ? "page" : undefined });
      if (!current) crumb.addEventListener("click", () => this.navigate(id));
      this.breadcrumb.append(crumb);
    }

    const xLabel = parameterLabel(this.sampleId, this.x);
    this.xButton.textContent = xLabel;
    this.xButton.setAttribute("aria-label", `X axis: ${xLabel}`);
    const yLabel = histogram ? "Histogram" : parameterLabel(this.sampleId, this.y);
    this.yButton.textContent = yLabel;
    this.yButton.setAttribute("aria-label", `Y axis: ${yLabel}`);
    this.yT.disabled = histogram;
    this.typeDropdown.value = this.plotType;

    const count = counts(this.sampleId, this.populationId);
    const label = this.populationId === "root" ? sampleName(this.sampleId) : populationName(this.populationId);
    const events = count?.count ?? this.events?.count;
    let text = `${label}: ${formatCount(events)} events`;
    if (this.populationId !== "root" && count) text += ` · ${formatPercent(count.parentCount ? count.count / count.parentCount * 100 : 0)}% of parent`;
    this.statsNode.textContent = events === undefined ? "Loading…" : text;
  }

  groupSamples() {
    const inGroup = samplesOfGroup(store.currentGroup);
    return inGroup.includes(this.sampleId) ? inGroup : samplesOfGroup(ALL_SAMPLES);
  }

  // ----------------------------------------------------------- data

  get scales() {
    return {
      x: makeScale(axisSetting(this.x)),
      y: this.y === HISTOGRAM ? null : makeScale(axisSetting(this.y)),
    };
  }

  async load() {
    const token = ++this.loadToken;
    const channels = this.y === HISTOGRAM ? [this.x] : [this.x, this.y];
    try {
      const data = await fetchEvents(this.sampleId, this.populationId, channels);
      if (token !== this.loadToken) return;
      this.events = { n: data.count, x: data.columns[0], y: data.columns[1] ?? null, count: data.count };
    } catch (error) {
      if (token !== this.loadToken) return;
      this.events = null;
      setStatus(error.message, true);
    }
    this.refreshChrome();
    this.render();
  }

  onStoreChange() {
    if (!store.workspace.samples.some((sample) => sample.id === this.sampleId)) {
      this.win.close();
      return;
    }
    if (this.populationId !== "root" && !gateOfPopulation(this.populationId)) {
      let cursor = this.populationId;
      while (cursor !== "root" && !gateOfPopulation(cursor)) cursor = "root";
      this.populationId = cursor;
    }
    if (this.selected && !gateOfPopulation(this.selected)) this.selected = null;
    this.refreshChrome();
    this.load();
  }

  navigate(populationId) {
    this.populationId = populationId;
    this.selected = null;
    this.cancelDraft();
    this.refreshChrome();
    this.load();
  }

  goToParent() {
    if (this.populationId === "root") return;
    this.navigate(parentOf(this.populationId));
  }

  switchSample(sampleId) {
    const names = namePath(this.populationId);
    const match = matchPopulation(sampleId, names);
    this.sampleId = sampleId;
    this.populationId = match.populationId;
    if (!match.exact) setStatus(`${sampleName(sampleId)} has no population “${names.join(" / ")}”; showing ${match.populationId === "root" ? "all events" : populationName(match.populationId)}.`);
    const parameters = new Set(parametersOf(sampleId).map((parameter) => parameter.name));
    if (!parameters.has(this.x) || (this.y !== HISTOGRAM && !parameters.has(this.y))) Object.assign(this, defaultAxes(sampleId));
    this.selected = null;
    this.cancelDraft();
    this.refreshChrome();
    this.load();
  }

  stepSample(step) {
    const group = this.groupSamples();
    const next = group[group.indexOf(this.sampleId) + step];
    if (next) this.switchSample(next);
  }

  setAxis(axis, parameter) {
    if (axis === "y" && parameter === HISTOGRAM) {
      if (this.y !== HISTOGRAM) this.lastY = this.y;
      this.y = HISTOGRAM;
      this.plotType = "histogram";
    } else if (axis === "y") {
      this.y = parameter;
      if (this.plotType === "histogram") this.plotType = "pseudocolor";
    } else {
      this.x = parameter;
    }
    this.selected = null;
    this.cancelDraft();
    if (this.tool !== "pointer") this.tool = "pointer";
    this.refreshChrome();
    this.load();
  }

  setPlotType(type) {
    if (type === "histogram") {
      this.setAxis("y", HISTOGRAM);
      return;
    }
    this.plotType = type;
    if (this.y === HISTOGRAM) {
      this.setAxis("y", this.lastY ?? defaultAxes(this.sampleId).y);
      this.plotType = type;
      this.refreshChrome();
    }
    this.render();
  }

  setTool(tool) {
    this.tool = tool;
    this.cancelDraft();
    if (tool !== "pointer") this.selected = null;
    this.refreshChrome();
    this.render();
  }

  cancelDraft() {
    this.draft = null;
    this.drag = null;
  }

  // ---------------------------------------------------- coordinates

  toPx(value, axis, scales = this.scales) {
    const scale = scales[axis];
    let t = scale.forward(value);
    if (!Number.isFinite(t)) t = value < 0 ? -Infinity : Infinity;
    const frac = (t - scale.tMin) / (scale.tMax - scale.tMin);
    return axis === "x" ? PLOT.x + frac * PLOT.w : PLOT.y + PLOT.h - frac * PLOT.h;
  }

  /** Data value at a pixel; on or past an edge of the plot it is open-ended. */
  fromPx(px, axis, scales = this.scales, snap = true) {
    const scale = scales[axis];
    if (axis === "x") {
      if (snap && px <= PLOT.x + EDGE) return -OFF_SCALE;
      if (snap && px >= PLOT.x + PLOT.w - EDGE) return OFF_SCALE;
      const frac = Math.min(1, Math.max(0, (px - PLOT.x) / PLOT.w));
      return scale.inverse(scale.tMin + frac * (scale.tMax - scale.tMin));
    }
    if (snap && px >= PLOT.y + PLOT.h - EDGE) return -OFF_SCALE;
    if (snap && px <= PLOT.y + EDGE) return OFF_SCALE;
    const frac = Math.min(1, Math.max(0, (PLOT.y + PLOT.h - px) / PLOT.h));
    return scale.inverse(scale.tMin + frac * (scale.tMax - scale.tMin));
  }

  clampPx(value, axis, scales) {
    const px = this.toPx(value, axis, scales);
    return axis === "x" ? Math.min(PLOT.x + PLOT.w, Math.max(PLOT.x, px)) : Math.min(PLOT.y + PLOT.h, Math.max(PLOT.y, px));
  }

  /** Shift a value by a distance in display units, leaving open-ended values open. */
  shift(value, scale, dt) {
    if (Math.abs(value) >= OFF_SCALE) return value;
    let t = scale.forward(value);
    if (!Number.isFinite(t)) t = scale.tMin;
    return scale.inverse(t + dt);
  }

  // ------------------------------------------------------------ gates

  visibleGates() {
    const histogram = this.y === HISTOGRAM;
    return store.workspace.gates.filter((gate) => {
      if (gate.sample !== this.sampleId || gate.parent !== this.populationId) return false;
      if (histogram) return gate.type === "range" && gate.x === this.x;
      return gate.type !== "range" && gate.x === this.x && gate.y === this.y;
    });
  }

  displayGate(gate) {
    if (this.drag?.gate && this.drag.gate.id === gate.id) return this.drag.gate;
    return gate;
  }

  gateFraction(gate, population) {
    const events = this.events;
    if (!events || events.n === 0) return 0;
    let inside = 0;
    for (let index = 0; index < events.n; index += 1) {
      if (gateContains(gate, events.x[index], events.y ? events.y[index] : 0, population)) inside += 1;
    }
    return inside / events.n * 100;
  }

  gatePixels(gate, scales) {
    if (gate.type === "polygon") return gate.vertices.map(([vx, vy]) => [this.clampPx(vx, "x", scales), this.clampPx(vy, "y", scales)]);
    if (gate.type === "rect") {
      const left = this.clampPx(gate.xMin, "x", scales);
      const right = this.clampPx(gate.xMax, "x", scales);
      const top = this.clampPx(gate.yMax, "y", scales);
      const bottom = this.clampPx(gate.yMin, "y", scales);
      return [[left, top], [right, top], [right, bottom], [left, bottom]];
    }
    if (gate.type === "quadrant") return [[this.clampPx(gate.xThreshold, "x", scales), this.clampPx(gate.yThreshold, "y", scales)]];
    return [];
  }

  rangeLineY(gate) {
    const ranges = this.visibleGates().filter((entry) => entry.type === "range");
    const index = Math.max(0, ranges.findIndex((entry) => entry.id === gate.id));
    return PLOT.y + 26 + index * 22;
  }

  handlesOf(gate, scales) {
    if (gate.type === "range") {
      const y = this.rangeLineY(gate);
      return [[this.clampPx(gate.min, "x", scales), y], [this.clampPx(gate.max, "x", scales), y]];
    }
    return this.gatePixels(gate, scales);
  }

  hitHandle(gate, point, scales) {
    const handles = this.handlesOf(gate, scales);
    for (let index = 0; index < handles.length; index += 1) {
      if (Math.hypot(handles[index][0] - point[0], handles[index][1] - point[1]) <= 6) return index;
    }
    return -1;
  }

  hitBody(gate, point, scales) {
    if (gate.type === "range") {
      const y = this.rangeLineY(gate);
      const [a, b] = this.handlesOf(gate, scales);
      return Math.abs(point[1] - y) <= 7 && point[0] >= Math.min(a[0], b[0]) - 4 && point[0] <= Math.max(a[0], b[0]) + 4;
    }
    if (gate.type === "quadrant") {
      const [[cx, cy]] = this.gatePixels(gate, scales);
      return Math.abs(point[0] - cx) <= 5 || Math.abs(point[1] - cy) <= 5;
    }
    const pixels = this.gatePixels(gate, scales);
    let inside = false;
    for (let i = 0, j = pixels.length - 1; i < pixels.length; j = i, i += 1) {
      const [xi, yi] = pixels[i];
      const [xj, yj] = pixels[j];
      if ((yi > point[1]) !== (yj > point[1]) && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  gateAt(point, scales) {
    const gates = this.visibleGates();
    const selected = gates.find((gate) => gate.id === this.selected);
    if (selected && this.hitBody(selected, point, scales)) return selected;
    return [...gates].reverse().find((gate) => this.hitBody(gate, point, scales)) ?? null;
  }

  /** The population a point falls in: the gate's own, or the quadrant under the point. */
  populationAt(gate, point, scales) {
    if (gate.type !== "quadrant") return gate.id;
    const [[cx, cy]] = this.gatePixels(gate, scales);
    const sx = point[0] >= cx ? "+" : "-";
    const sy = point[1] <= cy ? "+" : "-";
    return gate.quadrants.find((population) => population.x === sx && population.y === sy)?.id ?? gate.quadrants[0].id;
  }

  // ------------------------------------------------------------- render

  render() {
    const ctx = this.ctx;
    const scales = this.scales;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.save();
    ctx.beginPath();
    ctx.rect(PLOT.x, PLOT.y, PLOT.w, PLOT.h);
    ctx.clip();
    if (this.events) {
      if (this.y === HISTOGRAM) this.drawHistogram(scales);
      else this.drawEvents(scales);
    }
    ctx.restore();
    this.drawAxes(scales);
    if (this.events) for (const gate of this.visibleGates()) this.drawGate(this.displayGate(gate), scales);
    this.drawDraft(scales);
    ctx.strokeStyle = "#555";
    ctx.lineWidth = 1;
    ctx.strokeRect(PLOT.x + 0.5, PLOT.y + 0.5, PLOT.w, PLOT.h);
    if (!this.events) {
      ctx.fillStyle = "#777";
      ctx.font = "13px sans-serif";
      ctx.fillText("Loading events…", PLOT.x + PLOT.w / 2 - 50, PLOT.y + PLOT.h / 2);
    }
  }

  eventPixels(scales) {
    const { n, x, y } = this.events;
    const px = new Float32Array(n);
    const py = new Float32Array(n);
    const sx = scales.x;
    const sy = scales.y;
    const spanX = sx.tMax - sx.tMin;
    const spanY = sy.tMax - sy.tMin;
    for (let index = 0; index < n; index += 1) {
      let tx = sx.forward(x[index]);
      let ty = sy.forward(y[index]);
      if (!Number.isFinite(tx)) tx = sx.tMin;
      if (!Number.isFinite(ty)) ty = sy.tMin;
      px[index] = Math.min(PLOT.x + PLOT.w - 1, Math.max(PLOT.x, PLOT.x + (tx - sx.tMin) / spanX * PLOT.w));
      py[index] = Math.min(PLOT.y + PLOT.h - 1, Math.max(PLOT.y, PLOT.y + PLOT.h - (ty - sy.tMin) / spanY * PLOT.h));
    }
    return { px, py };
  }

  drawEvents(scales) {
    const ctx = this.ctx;
    const { px, py } = this.eventPixels(scales);
    const n = this.events.n;
    if (this.plotType === "dot") {
      ctx.fillStyle = "rgba(20,20,20,0.75)";
      for (let index = 0; index < n; index += 1) ctx.fillRect(px[index], py[index], 1, 1);
      return;
    }
    const cell = this.plotType === "density" ? 4 : 2;
    const cols = Math.ceil(PLOT.w / cell) + 1;
    const rows = Math.ceil(PLOT.h / cell) + 1;
    let grid = new Float32Array(cols * rows);
    for (let index = 0; index < n; index += 1) {
      grid[Math.floor((py[index] - PLOT.y) / cell) * cols + Math.floor((px[index] - PLOT.x) / cell)] += 1;
    }
    if (this.plotType === "density") {
      for (let pass = 0; pass < 2; pass += 1) {
        const next = new Float32Array(grid.length);
        for (let row = 0; row < rows; row += 1) {
          for (let col = 0; col < cols; col += 1) {
            let sum = 0;
            let weight = 0;
            for (let dr = -1; dr <= 1; dr += 1) {
              for (let dc = -1; dc <= 1; dc += 1) {
                const r = row + dr;
                const c = col + dc;
                if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
                sum += grid[r * cols + c];
                weight += 1;
              }
            }
            next[row * cols + col] = sum / weight;
          }
        }
        grid = next;
      }
    }
    let max = 0;
    for (const value of grid) if (value > max) max = value;
    const scale = Math.log1p(max);
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const value = grid[row * cols + col];
        if (value <= (this.plotType === "density" ? 0.05 : 0)) continue;
        ctx.fillStyle = pseudocolor(Math.log1p(value) / scale);
        ctx.fillRect(PLOT.x + col * cell, PLOT.y + row * cell, cell, cell);
      }
    }
  }

  drawHistogram(scales) {
    const ctx = this.ctx;
    const bins = 256;
    const counts = new Float64Array(bins);
    const sx = scales.x;
    const span = sx.tMax - sx.tMin;
    for (let index = 0; index < this.events.n; index += 1) {
      let t = sx.forward(this.events.x[index]);
      if (!Number.isFinite(t)) t = sx.tMin;
      const bin = Math.min(bins - 1, Math.max(0, Math.floor((t - sx.tMin) / span * bins)));
      counts[bin] += 1;
    }
    const max = Math.max(1, ...counts) * 1.08;
    this.histogramMax = max;
    ctx.beginPath();
    ctx.moveTo(PLOT.x, PLOT.y + PLOT.h);
    for (let bin = 0; bin < bins; bin += 1) {
      const x0 = PLOT.x + bin / bins * PLOT.w;
      const y0 = PLOT.y + PLOT.h - counts[bin] / max * PLOT.h;
      ctx.lineTo(x0, y0);
      ctx.lineTo(x0 + PLOT.w / bins, y0);
    }
    ctx.lineTo(PLOT.x + PLOT.w, PLOT.y + PLOT.h);
    ctx.closePath();
    ctx.fillStyle = "#b9c4d4";
    ctx.fill();
    ctx.strokeStyle = "#2c3a50";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  drawTickLabel(label, x, y, align) {
    const ctx = this.ctx;
    ctx.fillStyle = "#222";
    if (typeof label === "string") {
      ctx.font = "11px sans-serif";
      ctx.textAlign = align;
      ctx.fillText(label, x, y);
      return;
    }
    const base = label.sign < 0 ? "-10" : "10";
    ctx.font = "11px sans-serif";
    const baseWidth = ctx.measureText(base).width;
    ctx.font = "8px sans-serif";
    const exp = String(label.power);
    const expWidth = ctx.measureText(exp).width;
    const total = baseWidth + expWidth;
    const start = align === "center" ? x - total / 2 : align === "right" ? x - total : x;
    ctx.textAlign = "left";
    ctx.font = "11px sans-serif";
    ctx.fillText(base, start, y);
    ctx.font = "8px sans-serif";
    ctx.fillText(exp, start + baseWidth, y - 5);
  }

  drawAxes(scales) {
    const ctx = this.ctx;
    ctx.strokeStyle = "#444";
    ctx.lineWidth = 1;
    ctx.textBaseline = "alphabetic";
    let lastX = -Infinity;
    let lastTickX = -Infinity;
    for (const tick of scales.x.ticks()) {
      const x = Math.round(this.toPx(tick.value, "x", scales)) + 0.5;
      if (x < PLOT.x - 0.5 || x > PLOT.x + PLOT.w + 0.5) continue;
      if (!tick.major && Math.abs(x - lastTickX) < 4) continue;
      lastTickX = x;
      ctx.beginPath();
      ctx.moveTo(x, PLOT.y + PLOT.h);
      ctx.lineTo(x, PLOT.y + PLOT.h + (tick.major ? 6 : 3));
      ctx.stroke();
      if (tick.major && tick.label !== undefined && x - lastX > 34) {
        this.drawTickLabel(tick.label, x, PLOT.y + PLOT.h + 19, "center");
        lastX = x;
      }
    }
    if (this.y === HISTOGRAM) {
      const max = this.histogramMax ?? 1;
      const step = 10 ** Math.floor(Math.log10(max / 4));
      const nice = [1, 2, 5, 10].map((m) => m * step).find((s) => max / s <= 6) ?? step * 10;
      for (let value = 0; value <= max; value += nice) {
        const y = Math.round(PLOT.y + PLOT.h - value / max * PLOT.h) + 0.5;
        ctx.beginPath();
        ctx.moveTo(PLOT.x - 6, y);
        ctx.lineTo(PLOT.x, y);
        ctx.stroke();
        this.drawTickLabel(formatLinear(value), PLOT.x - 8, y + 4, "right");
      }
      return;
    }
    let lastY = Infinity;
    let lastTickY = Infinity;
    for (const tick of scales.y.ticks()) {
      const y = Math.round(this.toPx(tick.value, "y", scales)) + 0.5;
      if (y < PLOT.y - 0.5 || y > PLOT.y + PLOT.h + 0.5) continue;
      if (!tick.major && Math.abs(y - lastTickY) < 4) continue;
      lastTickY = y;
      ctx.beginPath();
      ctx.moveTo(PLOT.x - (tick.major ? 6 : 3), y);
      ctx.lineTo(PLOT.x, y);
      ctx.stroke();
      if (tick.major && tick.label !== undefined && lastY - y > 14) {
        this.drawTickLabel(tick.label, PLOT.x - 8, y + 4, "right");
        lastY = y;
      }
    }
  }

  drawLabel(lines, x, y) {
    const ctx = this.ctx;
    ctx.font = "11px sans-serif";
    const width = Math.max(...lines.map((line) => ctx.measureText(line).width)) + 6;
    const height = lines.length * 13 + 3;
    const left = Math.min(PLOT.x + PLOT.w - width - 1, Math.max(PLOT.x + 1, x));
    const top = Math.min(PLOT.y + PLOT.h - height - 1, Math.max(PLOT.y + 1, y));
    ctx.fillStyle = "rgba(255,255,255,0.82)";
    ctx.fillRect(left, top, width, height);
    ctx.fillStyle = "#111";
    ctx.textAlign = "left";
    lines.forEach((line, index) => ctx.fillText(line, left + 3, top + 12 + index * 13));
  }

  drawGate(gate, scales) {
    const ctx = this.ctx;
    const selected = gate.id === this.selected;
    ctx.strokeStyle = selected ? "#1f6fd1" : "#111";
    ctx.lineWidth = selected ? 2 : 1.4;
    if (gate.type === "range") {
      const y = this.rangeLineY(gate);
      const [[a], [b]] = this.handlesOf(gate, scales);
      ctx.beginPath();
      ctx.moveTo(a, y);
      ctx.lineTo(b, y);
      ctx.moveTo(a, y - 6);
      ctx.lineTo(a, y + 6);
      ctx.moveTo(b, y - 6);
      ctx.lineTo(b, y + 6);
      ctx.stroke();
      this.drawLabel([gate.name ?? gate.id, formatPercent(this.gateFraction(gate))], (a + b) / 2 - 20, y - 32);
    } else if (gate.type === "quadrant") {
      const [[cx, cy]] = this.gatePixels(gate, scales);
      ctx.beginPath();
      ctx.moveTo(cx, PLOT.y);
      ctx.lineTo(cx, PLOT.y + PLOT.h);
      ctx.moveTo(PLOT.x, cy);
      ctx.lineTo(PLOT.x + PLOT.w, cy);
      ctx.stroke();
      for (const population of gate.quadrants) {
        const left = population.x === "-";
        const top = population.y === "+";
        const text = [population.name ?? population.id, formatPercent(this.gateFraction(gate, population))];
        this.drawLabel(text, left ? PLOT.x + 3 : PLOT.x + PLOT.w - 100, top ? PLOT.y + 3 : PLOT.y + PLOT.h - 32);
      }
    } else {
      const pixels = this.gatePixels(gate, scales);
      ctx.beginPath();
      pixels.forEach(([x, y], index) => (index ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
      const top = pixels.reduce((best, point) => (point[1] < best[1] ? point : best), pixels[0]);
      this.drawLabel([gate.name ?? gate.id, formatPercent(this.gateFraction(gate))], top[0] - 10, top[1] - 32);
    }
    if (selected) {
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#1f6fd1";
      ctx.lineWidth = 1.5;
      for (const [x, y] of this.handlesOf(gate, scales)) {
        ctx.fillRect(x - 3.5, y - 3.5, 7, 7);
        ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
      }
    }
  }

  drawDraft() {
    const draft = this.draft;
    if (!draft) return;
    const ctx = this.ctx;
    ctx.strokeStyle = "#d1361f";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    if (draft.type === "rect") {
      ctx.rect(Math.min(draft.a[0], draft.b[0]), Math.min(draft.a[1], draft.b[1]), Math.abs(draft.b[0] - draft.a[0]), Math.abs(draft.b[1] - draft.a[1]));
    } else if (draft.type === "polygon" || draft.type === "freehand") {
      draft.points.forEach(([x, y], index) => (index ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (draft.hover) ctx.lineTo(draft.hover[0], draft.hover[1]);
      if (draft.type === "freehand") ctx.closePath();
    } else if (draft.type === "range") {
      const y = PLOT.y + 26;
      ctx.moveTo(draft.a, y);
      ctx.lineTo(draft.b, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    if (draft.type === "polygon") {
      ctx.fillStyle = "#d1361f";
      for (const [x, y] of draft.points) ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
    }
  }

  // ------------------------------------------------------------ pointer

  point(event) {
    const rect = this.canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  onPointerDown(event) {
    if (event.button !== 0 || !this.events) return;
    const point = this.point(event);
    const scales = this.scales;
    this.canvas.setPointerCapture(event.pointerId);
    if (this.tool === "rect") {
      this.draft = { type: "rect", a: point, b: point };
    } else if (this.tool === "freehand") {
      this.draft = { type: "freehand", points: [point] };
    } else if (this.tool === "polygon") {
      if (!this.draft) this.draft = { type: "polygon", points: [point], hover: point };
      else {
        const first = this.draft.points[0];
        const last = this.draft.points.at(-1);
        if (this.draft.points.length >= 3 && Math.hypot(first[0] - point[0], first[1] - point[1]) <= 8) {
          this.finishPolygon();
          return;
        }
        if (Math.hypot(last[0] - point[0], last[1] - point[1]) > 3) this.draft.points.push(point);
      }
    } else if (this.tool === "range") {
      this.draft = { type: "range", a: point[0], b: point[0] };
    } else if (this.tool === "pointer") {
      const selected = this.visibleGates().find((gate) => gate.id === this.selected);
      const handle = selected ? this.hitHandle(selected, point, scales) : -1;
      if (selected && handle >= 0) {
        this.drag = { kind: "handle", handle, start: point, original: selected, gate: cloneGate(selected), moved: false };
      } else {
        const gate = this.gateAt(point, scales);
        this.selected = gate?.id ?? null;
        if (gate) this.drag = { kind: "move", start: point, original: gate, gate: cloneGate(gate), moved: false };
      }
    }
    this.render();
  }

  onPointerMove(event) {
    const point = this.point(event);
    const scales = this.scales;
    if (this.draft?.type === "rect") this.draft.b = point;
    else if (this.draft?.type === "freehand") {
      const last = this.draft.points.at(-1);
      if (Math.hypot(last[0] - point[0], last[1] - point[1]) >= 6) this.draft.points.push(point);
    } else if (this.draft?.type === "polygon") this.draft.hover = point;
    else if (this.draft?.type === "range") this.draft.b = point[0];
    else if (this.drag) {
      const dx = point[0] - this.drag.start[0];
      const dy = point[1] - this.drag.start[1];
      if (Math.abs(dx) + Math.abs(dy) >= 2) this.drag.moved = true;
      if (!this.drag.moved) return;
      this.drag.gate = this.drag.kind === "move"
        ? this.movedGate(this.drag.original, dx, dy, scales)
        : this.reshapedGate(this.drag.original, this.drag.handle, point, scales);
    } else {
      return;
    }
    this.render();
  }

  async onPointerUp(event) {
    const point = this.point(event);
    const scales = this.scales;
    if (this.draft?.type === "rect") {
      const { a, b } = this.draft;
      this.draft = null;
      if (Math.abs(a[0] - b[0]) < 3 || Math.abs(a[1] - b[1]) < 3) return this.render();
      const xs = [this.fromPx(a[0], "x", scales), this.fromPx(b[0], "x", scales)].sort((p, q) => p - q);
      const ys = [this.fromPx(a[1], "y", scales), this.fromPx(b[1], "y", scales)].sort((p, q) => p - q);
      await this.createGate({ type: "rect", x: this.x, y: this.y, xMin: xs[0], xMax: xs[1], yMin: ys[0], yMax: ys[1] }, "draw:rect");
    } else if (this.draft?.type === "freehand") {
      const points = this.draft.points;
      this.draft = null;
      if (points.length < 3) return this.render();
      await this.createGate({ type: "polygon", x: this.x, y: this.y, vertices: points.map((p) => [this.fromPx(p[0], "x", scales), this.fromPx(p[1], "y", scales)]) }, "draw:freehand");
    } else if (this.draft?.type === "range") {
      const { a, b } = this.draft;
      this.draft = null;
      if (Math.abs(a - b) < 3) return this.render();
      const values = [this.fromPx(a, "x", scales), this.fromPx(b, "x", scales)].sort((p, q) => p - q);
      await this.createGate({ type: "range", x: this.x, min: values[0], max: values[1] }, "draw:range");
    } else if (this.tool === "quadrant" && !this.draft) {
      await this.createQuadrant(this.fromPx(point[0], "x", scales, false), this.fromPx(point[1], "y", scales, false), "draw:quadrant");
    } else if (this.tool === "bisector" && !this.draft) {
      await this.createBisector(this.fromPx(point[0], "x", scales, false), "draw:bisector");
    } else if (this.drag) {
      const drag = this.drag;
      if (drag.moved) {
        await this.commitEdit(drag.original, drag.gate, drag.kind === "move" ? "edit:move" : "edit:handle");
      }
      this.drag = null;
    }
    this.render();
  }

  onDoubleClick(event) {
    const point = this.point(event);
    if (this.tool === "polygon" && this.draft) {
      this.finishPolygon();
      return;
    }
    if (this.tool !== "pointer") return;
    const scales = this.scales;
    const gate = this.gateAt(point, scales);
    if (!gate) return;
    const populationId = this.populationAt(gate, point, scales);
    const rect = this.win.root.getBoundingClientRect();
    openGraphWindow({ sampleId: this.sampleId, populationId, axes: { x: this.x, y: this.y }, x: rect.left + 28, y: rect.top + 28 });
  }

  onContextMenu(event) {
    event.preventDefault();
    const point = this.point(event);
    const scales = this.scales;
    const gate = this.gateAt(point, scales);
    const at = { x: event.clientX, y: event.clientY };
    if (gate) {
      this.selected = gate.id;
      this.render();
      const populationId = this.populationAt(gate, point, scales);
      openMenu([
        { label: "Open Graph", action: () => openGraphWindow({ sampleId: this.sampleId, populationId, axes: { x: this.x, y: this.y } }) },
        { label: "Rename…", action: () => this.renamePopulation(populationId) },
        "-",
        { label: "Delete Gate", shortcut: "Del", action: () => this.deleteSelected() },
      ], at);
    } else {
      openMenu(this.graphMenuItems(), at);
    }
  }

  finishPolygon() {
    const draft = this.draft;
    this.draft = null;
    if (!draft || draft.points.length < 3) {
      this.render();
      return;
    }
    const scales = this.scales;
    this.createGate({
      type: "polygon",
      x: this.x,
      y: this.y,
      vertices: draft.points.map((p) => [this.fromPx(p[0], "x", scales), this.fromPx(p[1], "y", scales)]),
    }, "draw:polygon");
  }

  movedGate(original, dx, dy, scales) {
    const gate = cloneGate(original);
    const dtx = dx / PLOT.w * (scales.x.tMax - scales.x.tMin);
    const dty = scales.y ? -dy / PLOT.h * (scales.y.tMax - scales.y.tMin) : 0;
    if (gate.type === "polygon") gate.vertices = gate.vertices.map(([x, y]) => [this.shift(x, scales.x, dtx), this.shift(y, scales.y, dty)]);
    if (gate.type === "rect") {
      gate.xMin = this.shift(gate.xMin, scales.x, dtx);
      gate.xMax = this.shift(gate.xMax, scales.x, dtx);
      gate.yMin = this.shift(gate.yMin, scales.y, dty);
      gate.yMax = this.shift(gate.yMax, scales.y, dty);
    }
    if (gate.type === "quadrant") {
      gate.xThreshold = this.shift(gate.xThreshold, scales.x, dtx);
      gate.yThreshold = this.shift(gate.yThreshold, scales.y, dty);
    }
    if (gate.type === "range") {
      gate.min = this.shift(gate.min, scales.x, dtx);
      gate.max = this.shift(gate.max, scales.x, dtx);
    }
    return gate;
  }

  reshapedGate(original, handle, point, scales) {
    const gate = cloneGate(original);
    const vx = this.fromPx(point[0], "x", scales);
    if (gate.type === "range") {
      if (handle === 0) gate.min = vx;
      else gate.max = vx;
      if (gate.min > gate.max) [gate.min, gate.max] = [gate.max, gate.min];
      return gate;
    }
    const vy = this.fromPx(point[1], "y", scales);
    if (gate.type === "polygon") gate.vertices[handle] = [vx, vy];
    if (gate.type === "rect") {
      if (handle === 0 || handle === 3) gate.xMin = vx;
      else gate.xMax = vx;
      if (handle === 0 || handle === 1) gate.yMax = vy;
      else gate.yMin = vy;
      if (gate.xMin > gate.xMax) [gate.xMin, gate.xMax] = [gate.xMax, gate.xMin];
      if (gate.yMin > gate.yMax) [gate.yMin, gate.yMax] = [gate.yMax, gate.yMin];
    }
    if (gate.type === "quadrant") {
      gate.xThreshold = this.fromPx(point[0], "x", scales, false);
      gate.yThreshold = this.fromPx(point[1], "y", scales, false);
    }
    return gate;
  }

  // ------------------------------------------------------------ changes

  async createGate(shape, via) {
    this.render();
    const name = await promptDialog({ title: "Gate Name", label: "Subset name", value: uniqueName(this.sampleId, shape.type === "range" ? "Range" : "Gate") });
    this.setTool("pointer");
    if (!name) return;
    const gate = { id: newId(name), name, sample: this.sampleId, parent: this.populationId, ...shape };
    const done = await runOp({ op: "gate.save", gate }, {
      via,
      label: `Created gate “${name}”`,
      undo: { op: "gate.delete", gateId: gate.id },
    });
    if (done) this.selected = gate.id;
    this.render();
  }

  async createQuadrant(xThreshold, yThreshold, via) {
    const xs = shortName(this.x);
    const ys = shortName(this.y);
    const taken = store.workspace.gates
      .filter((gate) => gate.sample === this.sampleId && gate.type === "quadrant")
      .reduce((sum, gate) => sum + gate.quadrants.length, 0);
    const label = (index) => `Q${taken + index}`;
    const quadrants = [
      { name: `${label(1)}: ${xs}- , ${ys}+`, x: "-", y: "+" },
      { name: `${label(2)}: ${xs}+ , ${ys}+`, x: "+", y: "+" },
      { name: `${label(3)}: ${xs}+ , ${ys}-`, x: "+", y: "-" },
      { name: `${label(4)}: ${xs}- , ${ys}-`, x: "-", y: "-" },
    ].map((population) => ({ ...population, id: newId(population.name.slice(0, 3)) }));
    const gate = { id: newId("quadrant"), name: "Quadrant", sample: this.sampleId, parent: this.populationId, type: "quadrant", x: this.x, y: this.y, xThreshold, yThreshold, quadrants };
    this.setTool("pointer");
    const done = await runOp({ op: "gate.save", gate }, { via, label: "Created quadrant gate", undo: { op: "gate.delete", gateId: gate.id } });
    if (done) this.selected = gate.id;
    this.render();
  }

  async createBisector(value, via) {
    this.setTool("pointer");
    const left = { id: newId("L"), name: uniqueName(this.sampleId, "L"), sample: this.sampleId, parent: this.populationId, type: "range", x: this.x, min: -OFF_SCALE, max: value };
    const right = { id: newId("R"), name: uniqueName(this.sampleId, "R"), sample: this.sampleId, parent: this.populationId, type: "range", x: this.x, min: value, max: OFF_SCALE };
    const first = await runOp({ op: "gate.save", gate: left }, { via, label: "Created bisector (L)", undo: { op: "gate.delete", gateId: left.id } });
    if (first) await runOp({ op: "gate.save", gate: right }, { via, label: "Created bisector (L, R)", undo: { op: "gate.delete", gateId: right.id } });
  }

  async commitEdit(original, gate, via) {
    await runOp({ op: "gate.save", gate }, { via, label: `Edited gate “${gate.name ?? gate.id}”`, undo: { op: "gate.save", gate: original } });
  }

  async deleteSelected() {
    const gate = this.visibleGates().find((entry) => entry.id === this.selected);
    if (!gate) return;
    const name = gate.name ?? gate.id;
    const ok = await confirmDialog({ title: "Delete Gate", message: `Delete the gate “${name}” and every population below it?` });
    if (!ok) return;
    await runOp({ op: "gate.delete", gateId: gate.id }, {
      via: "delete",
      label: `Deleted gate “${name}”`,
      undo: (detail) => ({ op: "gates.restore", gates: detail.removed }),
    });
    this.selected = null;
  }

  async renamePopulation(populationId) {
    const current = populationName(populationId);
    const name = await promptDialog({ title: "Rename", label: "Name", value: current });
    if (!name || name === current) return;
    await runOp({ op: "population.rename", populationId, name }, {
      via: "rename",
      label: `Renamed “${current}” to “${name}”`,
      undo: { op: "population.rename", populationId, name: current },
    });
  }

  async nudge(dx, dy) {
    const gate = this.visibleGates().find((entry) => entry.id === this.selected);
    if (!gate) return;
    await this.commitEdit(gate, this.movedGate(gate, dx, dy, this.scales), "edit:nudge");
  }

  onKey(event) {
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && event.key.toLowerCase() === "g") {
      event.preventDefault();
      this.manualGate();
      return true;
    }
    if (event.key === "Escape") {
      this.cancelDraft();
      if (this.tool !== "pointer") this.setTool("pointer");
      else this.selected = null;
      this.render();
      return true;
    }
    if (event.key === "Enter" && this.draft?.type === "polygon") {
      this.finishPolygon();
      return true;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && this.selected) {
      event.preventDefault();
      this.deleteSelected();
      return true;
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[event.key] && this.selected) {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      this.nudge(arrows[event.key][0] * step, arrows[event.key][1] * step);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------- menus

  graphMenuItems() {
    const histogram = this.y === HISTOGRAM;
    return [
      { label: "Manually Enter Gate…", shortcut: "Ctrl+G", action: () => this.manualGate() },
      "-",
      { label: "Customize X Axis…", action: () => this.customizeAxis("x") },
      { label: "Customize Y Axis…", disabled: histogram, action: () => this.customizeAxis("y") },
      "-",
      { label: "Open Parent Graph", disabled: this.populationId === "root", action: () => openGraphWindow({ sampleId: this.sampleId, populationId: parentOf(this.populationId), axes: { x: this.x, y: this.y } }) },
      { label: "Delete Selected Gate", shortcut: "Del", disabled: !this.selected, action: () => this.deleteSelected() },
    ];
  }

  openAxisMenu(axis) {
    const current = axis === "x" ? this.x : this.y;
    const items = parametersOf(this.sampleId).map((parameter) => ({
      label: parameterLabel(this.sampleId, parameter.name),
      checked: parameter.name === current,
      action: () => this.setAxis(axis, parameter.name),
    }));
    if (axis === "y") items.unshift({ label: "Histogram", checked: this.y === HISTOGRAM, action: () => this.setAxis("y", HISTOGRAM) }, "-");
    openMenu(items, axis === "x" ? this.xButton : this.yButton);
  }

  openTransformMenu(axis) {
    const parameter = axis === "x" ? this.x : this.y;
    if (parameter === HISTOGRAM) return;
    const setting = axisSetting(parameter);
    const choose = (scale) => {
      const next = { ...setting, scale };
      const defaults = store.axisDefaults[parameter] ?? {};
      if (scale === "log" && !(next.min > 0)) next.min = Math.max(1, (next.max ?? 1) / 1e5);
      if (scale === "biex" && !(next.width > 0)) next.width = defaults.width ?? (next.max ?? 1) / 10 ** 4.5;
      if (scale === "biex" && setting.scale === "log") next.min = -10 * next.width;
      if (scale === "linear" && setting.scale !== "linear") next.min = defaults.scale === "linear" ? defaults.min ?? 0 : 0;
      this.saveAxis(parameter, next);
    };
    openMenu([
      { label: "Linear", checked: setting.scale === "linear", action: () => choose("linear") },
      { label: "Log", checked: setting.scale === "log", action: () => choose("log") },
      { label: "Biex", checked: setting.scale === "biex", action: () => choose("biex") },
      "-",
      { label: "Customize Axis…", action: () => this.customizeAxis(axis) },
    ], axis === "x" ? this.xT : this.yT);
  }

  async saveAxis(parameter, setting) {
    await runOp({ op: "axis.set", parameter, setting }, { via: "axis", label: `Changed the ${parameter} axis`, quiet: false });
  }

  async customizeAxis(axis) {
    const parameter = axis === "x" ? this.x : this.y;
    if (parameter === HISTOGRAM) return;
    const setting = axisSetting(parameter);
    const min = el("input", { class: "text-input", value: formatValue(setting.min ?? 0), "aria-label": "Minimum" });
    const max = el("input", { class: "text-input", value: formatValue(setting.max ?? 1), "aria-label": "Maximum" });
    const width = el("input", { class: "text-input", value: formatValue(setting.width ?? (setting.max ?? 1) / 10 ** 4.5), "aria-label": "Biex linear width" });
    const errorText = el("div", { class: "error-text" });
    const widthField = el("div", { class: "field" }, el("label", { text: "Linear width (biex)" }), width);
    const transform = radioGroup([
      { value: "linear", label: "Linear" },
      { value: "log", label: "Log" },
      { value: "biex", label: "Biex" },
    ], setting.scale === "arcsinh" ? "biex" : setting.scale, (value) => { widthField.hidden = value !== "biex"; }, "Transform");
    widthField.hidden = transform.value !== "biex";
    const body = el("div", {},
      el("div", { class: "field" }, el("label", { text: "Parameter" }), el("span", { text: parameterLabel(this.sampleId, parameter) })),
      el("div", { class: "field" }, el("label", { text: "Transform" }), transform.node),
      el("div", { class: "field" }, el("label", { text: "Minimum" }), min),
      el("div", { class: "field" }, el("label", { text: "Maximum" }), max),
      widthField,
      el("div", { class: "dialog-message", style: { color: "#5d6676" }, text: "Applies to this parameter in every sample. Axis settings change only how plots are drawn." }),
      errorText);
    await dialog({
      title: "Customize Axis",
      body,
      buttons: [
        {
          label: "OK",
          primary: true,
          action: async () => {
            const next = { scale: transform.value, min: parseValue(min.value), max: parseValue(max.value) };
            if (next.scale === "biex") next.width = parseValue(width.value);
            const bad = [next.min, next.max, next.width ?? 1].some((value) => !Number.isFinite(value) || Math.abs(value) >= OFF_SCALE);
            if (bad || next.min >= next.max) {
              errorText.textContent = "Enter numbers, with the minimum below the maximum.";
              return KEEP_OPEN;
            }
            if (next.scale === "log" && next.min <= 0) {
              errorText.textContent = "A log axis needs a minimum above zero.";
              return KEEP_OPEN;
            }
            if (next.scale === "biex" && !(next.width > 0)) {
              errorText.textContent = "The linear width must be above zero.";
              return KEEP_OPEN;
            }
            await this.saveAxis(parameter, next);
            return true;
          },
        },
        {
          label: "Defaults",
          action: async () => {
            await runOp({ op: "axis.set", parameter, setting: null }, { via: "axis", label: `Reset the ${parameter} axis` });
            return true;
          },
        },
        { label: "Cancel", cancel: true, action: () => false },
      ],
    });
  }

  /** FlowJo's Manual Gate Definition: bounds typed as intensities or percentiles. */
  async manualGate() {
    if (!this.events) return;
    const histogram = this.y === HISTOGRAM;
    const scales = this.scales;
    const axes = histogram ? ["x"] : ["x", "y"];
    const rows = {};
    const grid = el("div", { class: "manual-grid" },
      el("span", { class: "head", text: "Parameter" }), el("span", { class: "head", text: "Lower limit" }),
      el("span", { class: "head", text: "Upper limit" }), el("span", { class: "head", text: "Units" }));
    for (const axis of axes) {
      const parameter = axis === "x" ? this.x : this.y;
      const scale = scales[axis];
      const lower = el("input", { class: "text-input", value: formatValue(scale.min), "aria-label": `${axis.toUpperCase()} lower limit` });
      const upper = el("input", { class: "text-input", value: formatValue(scale.max), "aria-label": `${axis.toUpperCase()} upper limit` });
      const units = dropdown({
        label: `${axis.toUpperCase()} units`,
        options: () => [{ value: "intensity", label: "Intensity" }, { value: "percentile", label: "Percentile" }],
        value: "intensity",
        onChange: (value) => {
          lower.value = value === "percentile" ? "0" : formatValue(scale.min);
          upper.value = value === "percentile" ? "100" : formatValue(scale.max);
        },
      });
      rows[axis] = { parameter, lower, upper, units };
      grid.append(el("span", { text: parameterLabel(this.sampleId, parameter) }), lower, upper, units.node);
    }
    const quad = histogram ? null : checkbox("Make Quad Gates", false, (checked) => {
      for (const axis of axes) rows[axis].upper.disabled = checked;
    });
    const errorText = el("div", { class: "error-text" });
    const body = el("div", {}, grid, quad?.node, errorText);

    const valueOf = (axis, text, end) => {
      const row = rows[axis];
      const number = parseValue(text);
      if (!Number.isFinite(number)) return Number.NaN;
      if (row.units.value === "intensity") return number;
      if (number <= 0 && end === "lower") return -OFF_SCALE;
      if (number >= 100 && end === "upper") return OFF_SCALE;
      const column = axis === "x" ? this.events.x : this.events.y;
      const sorted = Float64Array.from(column).sort();
      const position = (sorted.length - 1) * Math.min(100, Math.max(0, number)) / 100;
      const low = Math.floor(position);
      const high = Math.ceil(position);
      return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
    };

    const result = await dialog({
      title: "Manual Gate Definition",
      width: 560,
      body,
      buttons: [
        {
          label: "OK",
          primary: true,
          action: () => {
            const bounds = {};
            for (const axis of axes) {
              const lower = valueOf(axis, rows[axis].lower.value, "lower");
              const upper = quad?.checked ? Number.NaN : valueOf(axis, rows[axis].upper.value, "upper");
              if (!Number.isFinite(lower) || (!quad?.checked && (!Number.isFinite(upper) || lower >= upper))) {
                errorText.textContent = quad?.checked ? "Enter a number for each centre." : "Enter numbers, with each lower limit below its upper limit.";
                return KEEP_OPEN;
              }
              bounds[axis] = [lower, upper];
            }
            return bounds;
          },
        },
        { label: "Cancel", cancel: true, action: () => null },
      ],
    });
    if (!result) return;
    if (quad?.checked) {
      await this.createQuadrant(result.x[0], result.y[0], "manual");
      return;
    }
    if (histogram) await this.createGate({ type: "range", x: this.x, min: result.x[0], max: result.x[1] }, "manual");
    else await this.createGate({ type: "rect", x: this.x, y: this.y, xMin: result.x[0], xMax: result.x[1], yMin: result.y[0], yMax: result.y[1] }, "manual");
  }
}
