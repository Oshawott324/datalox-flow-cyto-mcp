// Compensation: a matrix worked out from gated single-stain controls, and the
// matrix editor for viewing, entering and applying spillover values.

import { checkbox, confirmDialog, createWindow, dropdown, el, openMenu, promptDialog, radioGroup } from "./ui.js";
import {
  childPopulations, compensationById, groups, isFluorescence, namePath, onChange, sampleName, samplesOfGroup, store,
} from "./model.js";
import { calculateCompensation, registry, runOp, setStatus } from "./actions.js";

const NONE = "";

function fluorescenceParameters() {
  const first = store.samples[0];
  return (first?.parameters ?? []).map((parameter) => parameter.name).filter((name) => isFluorescence(name));
}

/** Every population of a sample, as name paths, for choosing control populations. */
function populationOptions(sampleId) {
  if (!sampleId) return [{ value: NONE, label: "—" }];
  const out = [{ value: NONE, label: "—" }];
  const walk = (parentId) => {
    for (const population of childPopulations(sampleId, parentId)) {
      out.push({ value: population.id, label: namePath(population.id).join(" / ") });
      walk(population.id);
    }
  };
  walk("root");
  return out;
}

function sampleOptions(emptyLabel = "—") {
  return [{ value: NONE, label: emptyLabel }, ...store.samples.map((sample) => ({ value: sample.id, label: sample.name }))];
}

function normalizeToken(text) {
  return String(text).toLowerCase().replace(/-[ahw]$/i, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/** The control tube whose name names this parameter's fluorochrome, as FlowJo matches controls to colours. */
function suggestControl(parameter) {
  const token = normalizeToken(parameter);
  const matches = store.samples.filter((sample) => normalizeToken(sample.name.replace(/\.fcs$/i, "")).includes(token));
  return matches.length === 1 ? matches[0].id : NONE;
}

export function applyMenuItems(compensationId, selectedSamples) {
  const apply = (samples, label) => runOp({ op: "compensation.apply", compensationId, samples }, {
    via: "apply-matrix",
    label: compensationId ? `Applied ${compensationId} to ${label}` : `Removed compensation from ${label}`,
  });
  const items = groups().map((group) => ({
    label: `${group.name} (${samplesOfGroup(group.id).length})`,
    action: () => apply(samplesOfGroup(group.id), group.name),
  }));
  const selected = selectedSamples?.() ?? [];
  items.push("-", {
    label: `Selected Samples (${selected.length})`,
    disabled: selected.length === 0,
    action: () => apply(selected, `${selected.length} selected sample(s)`),
  });
  return items;
}

function percentText(value, units) {
  return units === "percent" ? String(+(value * 100).toFixed(4)) : String(+value.toFixed(6));
}

function heat(value, diagonal) {
  if (diagonal) return "#eef1f5";
  if (value < 0) return `rgba(60,110,220,${Math.min(0.55, 0.12 + Math.abs(value) * 6)})`;
  if (value > 0) return `rgba(240,190,20,${Math.min(0.7, 0.08 + value * 4)})`;
  return "#fff";
}

// ------------------------------------------------------------ compensation window

let compensationWindow = null;

export function openCompensationWindow() {
  if (compensationWindow) {
    compensationWindow.win.focus();
    return;
  }
  const parameters = fluorescenceParameters();
  const rows = parameters.map((parameter) => ({
    parameter,
    use: true,
    sample: suggestControl(parameter),
    positive: NONE,
    negative: NONE,
    negativeSample: NONE,
  }));
  let result = null;
  const win = createWindow({
    title: "Compensation",
    x: 250,
    y: 70,
    width: 900,
    height: 600,
    className: "comp-window",
    onClose: () => { compensationWindow = null; unsubscribe(); },
  });
  const table = el("div", { class: "comp-table", style: { gridTemplateColumns: "40px 190px 190px 170px 170px 150px" } });
  const message = el("div", { class: "comp-message", role: "status" });
  const resultArea = el("div");
  const render = () => {
    table.replaceChildren(...["Use", "Parameter", "Control sample", "Positive population", "Negative population", "Negative from"].map((text) => el("span", { class: "head", text })));
    for (const row of rows) {
      const use = checkbox("", row.use, (checked) => { row.use = checked; });
      use.input.setAttribute("aria-label", `Use ${row.parameter}`);
      const sample = dropdown({
        label: `${row.parameter} control sample`,
        options: () => sampleOptions(),
        value: row.sample,
        onChange: (value) => { row.sample = value; row.positive = NONE; row.negative = NONE; render(); },
      });
      const positive = dropdown({
        label: `${row.parameter} positive population`,
        options: () => populationOptions(row.sample),
        value: row.positive,
        onChange: (value) => { row.positive = value; },
      });
      const negativeSample = row.negativeSample || row.sample;
      const negative = dropdown({
        label: `${row.parameter} negative population`,
        options: () => populationOptions(negativeSample),
        value: row.negative,
        onChange: (value) => { row.negative = value; },
      });
      const from = dropdown({
        label: `${row.parameter} negative from sample`,
        options: () => sampleOptions("Same tube"),
        value: row.negativeSample,
        onChange: (value) => { row.negativeSample = value; row.negative = NONE; render(); },
      });
      table.append(use.node, el("span", { text: row.parameter }), sample.node, positive.node, negative.node, from.node);
    }
  };
  const calculate = el("button", { class: "button primary", text: "Calculate" });
  calculate.addEventListener("click", async () => {
    const chosen = rows.filter((row) => row.use);
    const missing = chosen.filter((row) => !row.sample || !row.positive || !row.negative);
    if (chosen.length === 0 || missing.length > 0) {
      message.className = "comp-message error";
      message.textContent = chosen.length === 0
        ? "Choose at least one parameter."
        : `Choose a control sample and its positive and negative populations for ${missing.map((row) => row.parameter).join(", ")}.`;
      return;
    }
    message.className = "comp-message";
    message.textContent = "Calculating…";
    const body = await calculateCompensation(chosen.map((row) => ({
      sampleId: row.sample,
      channel: row.parameter,
      positiveGateId: row.positive,
      negativeGateId: row.negative,
      ...(row.negativeSample ? { negativeSampleId: row.negativeSample } : {}),
    })));
    if (!body.ok) {
      result = null;
      message.className = "comp-message error";
      message.textContent = `Calculation Error: ${body.error?.message ?? "the matrix could not be calculated."}`;
      resultArea.replaceChildren();
      return;
    }
    result = body.compensation;
    message.className = "comp-message ok";
    message.textContent = "Finalized";
    renderResult();
  });
  const renderResult = () => {
    if (!result) {
      resultArea.replaceChildren();
      return;
    }
    const grid = matrixGrid({ channels: result.channels, matrix: result.matrix, units: "percent", editable: false });
    const name = el("input", { class: "text-input", value: "Comp-Matrix", "aria-label": "Matrix name" });
    const save = el("button", { class: "button primary", text: "Save Matrix" });
    const apply = el("button", { class: "button", text: "Apply Matrix ▾", disabled: true });
    save.addEventListener("click", async () => {
      const id = name.value.trim();
      if (!id) return;
      const existing = compensationById(id);
      if (existing && !(await confirmDialog({ title: "Replace Matrix", message: `A matrix named “${id}” exists. Replace it?` }))) return;
      const done = await runOp({ op: "compensation.save", compensation: { id, name: id, source: "controls", channels: result.channels, matrix: result.matrix } }, {
        via: "compensation-window",
        label: `Saved matrix ${id}`,
      });
      if (done) {
        apply.disabled = false;
        apply.dataset.matrix = id;
        message.textContent = `Finalized · saved as ${id}`;
      }
    });
    apply.addEventListener("click", () => openMenu(applyMenuItems(apply.dataset.matrix, registry.selectedSamples), apply));
    resultArea.replaceChildren(
      el("h3", { text: "Spillover (%) — rows: fluorochrome, columns: detector it spills into" }),
      grid.node,
      el("div", { class: "field", style: { marginTop: "8px", gridTemplateColumns: "90px 220px auto auto" } }, el("label", { text: "Matrix name" }), name, save, apply),
    );
  };
  win.body.append(
    el("div", { class: "comp-section" },
      el("h3", { text: "Single-stain controls" }),
      el("div", { class: "dialog-message", style: { color: "#5d6676", marginBottom: "6px" }, text: "For each parameter, choose its single-stain control and the populations of stained (positive) and unstained (negative) events, gated in the workspace. The spillover into every detector is the difference of their medians, relative to the control's own detector." }),
      table,
      el("div", { style: { display: "flex", gap: "10px", alignItems: "center", marginTop: "8px" } }, calculate, message)),
    el("div", { class: "comp-section" }, resultArea),
  );
  const unsubscribe = onChange(() => render());
  render();
  compensationWindow = { win };
}

// --------------------------------------------------------------- matrix grid

function matrixGrid({ channels, matrix, units, editable, onEdit }) {
  const values = matrix.map((row) => [...row]);
  const node = el("div", { class: "matrix-grid", role: "grid", style: { gridTemplateColumns: `minmax(150px, auto) repeat(${channels.length}, auto)` } });
  node.append(el("span", { class: "head", text: "Spill from \\ into" }), ...channels.map((channel) => el("span", { class: "head", text: channel })));
  channels.forEach((from, i) => {
    node.append(el("span", { class: "head", text: from }));
    channels.forEach((into, j) => {
      const input = el("input", {
        class: "matrix-cell",
        value: percentText(values[i][j], units),
        readonly: !editable || i === j,
        "aria-label": `Spillover of ${from} into ${into}`,
        style: { background: heat(values[i][j], i === j) },
      });
      const commit = () => {
        const parsed = Number(input.value);
        if (!Number.isFinite(parsed)) {
          input.value = percentText(values[i][j], units);
          return;
        }
        values[i][j] = units === "percent" ? parsed / 100 : parsed;
        input.style.background = heat(values[i][j], i === j);
        onEdit?.(values);
      };
      input.addEventListener("change", commit);
      input.addEventListener("keydown", (event) => {
        if (!editable || i === j || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
        event.preventDefault();
        let step = units === "percent" ? 0.1 : 0.001;
        if (event.shiftKey) step *= 10;
        if (event.ctrlKey || event.altKey) step /= 10;
        const current = Number(input.value) || 0;
        input.value = String(+(current + (event.key === "ArrowUp" ? step : -step)).toFixed(6));
        commit();
      });
      node.append(input);
    });
  });
  return { node, values };
}

// -------------------------------------------------------------- matrix editor

let editorWindow = null;

export function openMatrixEditor(selectId) {
  if (editorWindow) {
    editorWindow.win.focus();
    if (selectId) editorWindow.select(selectId);
    return;
  }
  let current = selectId ?? (store.workspace.compensations ?? [])[0]?.id ?? null;
  let units = "percent";
  let draft = null;
  const win = createWindow({
    title: "Matrix Editor",
    x: 220,
    y: 60,
    width: 880,
    height: 560,
    className: "comp-window",
    onClose: () => { editorWindow = null; unsubscribe(); },
  });
  const list = el("div", { class: "matrix-list table-body", role: "listbox", "aria-label": "Matrices" });
  const main = el("div", { class: "matrix-main" });
  const newButton = el("button", { class: "button", title: "New blank matrix", text: "+ New" });
  const editButton = el("button", { class: "button", title: "Duplicate the selected matrix to edit it", text: "Edit" });
  const deleteButton = el("button", { class: "button", text: "Delete" });
  const footer = el("div", { class: "matrix-list-footer" }, newButton, editButton, deleteButton);

  const render = () => {
    const matrices = store.workspace.compensations ?? [];
    if (current && !matrices.some((matrix) => matrix.id === current)) current = matrices[0]?.id ?? null;
    list.replaceChildren(...matrices.map((matrix) => {
      const row = el("div", { class: `row${matrix.id === current ? " selected" : ""}`, role: "option", "aria-selected": String(matrix.id === current) },
        el("span", { text: matrix.id }));
      row.addEventListener("click", () => { current = matrix.id; draft = null; render(); });
      return row;
    }));
    const matrix = matrices.find((entry) => entry.id === current);
    editButton.disabled = !matrix;
    deleteButton.disabled = !matrix || matrix.source === "fcs_keyword";
    if (!matrix) {
      main.replaceChildren(el("div", { class: "comp-section", text: "No matrix selected. Use + New to enter one, or the Compensation window to calculate one from single-stain controls." }));
      return;
    }
    const editable = matrix.source !== "fcs_keyword";
    const source = { fcs_keyword: `Acquisition matrix (${matrix.keyword ?? "FCS keyword"} of ${sampleName(matrix.sample)})`, controls: "Calculated from single-stain controls", manual: "Entered by hand" }[matrix.source] ?? matrix.source;
    const grid = matrixGrid({
      channels: matrix.channels,
      matrix: draft?.id === matrix.id ? draft.matrix : matrix.matrix,
      units,
      editable,
      onEdit: (values) => { draft = { id: matrix.id, matrix: values }; save.disabled = false; },
    });
    const save = el("button", { class: "button primary", text: "Save", disabled: !(draft?.id === matrix.id) });
    save.addEventListener("click", async () => {
      if (!draft) return;
      const done = await runOp({ op: "compensation.save", compensation: { ...matrix, matrix: draft.matrix, source: matrix.source === "controls" ? "manual" : matrix.source } }, {
        via: "matrix-editor",
        label: `Saved matrix ${matrix.id}`,
      });
      if (done) draft = null;
      render();
    });
    const apply = el("button", { class: "button", text: "Apply Matrix ▾", "aria-haspopup": "menu" });
    apply.addEventListener("click", () => openMenu(applyMenuItems(matrix.id, registry.selectedSamples), apply));
    const unitChoice = radioGroup([{ value: "percent", label: "Percent" }, { value: "fraction", label: "Fraction" }], units, (value) => { units = value; render(); }, "Units");
    const appliedTo = Object.entries(store.workspace.sampleCompensation ?? {}).filter(([, id]) => id === matrix.id).map(([sample]) => sampleName(sample));
    main.replaceChildren(
      el("div", { class: "comp-section" },
        el("div", { class: "field" }, el("label", { text: "Name" }), el("span", { text: matrix.id })),
        el("div", { class: "field" }, el("label", { text: "Source" }), el("span", { text: source })),
        el("div", { class: "field" }, el("label", { text: "Applied to" }), el("span", { text: appliedTo.length ? `${appliedTo.length} sample(s)` : "No samples" })),
        el("div", { class: "field" }, el("label", { text: "Values" }), unitChoice.node)),
      el("div", { class: "comp-section" },
        el("div", { class: "dialog-message", style: { color: "#5d6676", marginBottom: "6px" }, text: editable
          ? "Rows are the fluorochrome spilling over; columns the detector it spills into. The diagonal is 100% (1). Click a cell to type a value, or use the Up and Down arrow keys (Shift for larger steps, Ctrl or Alt for smaller)."
          : "The acquisition matrix stored in the FCS file cannot be changed. Press Edit to make an editable copy." }),
        grid.node,
        el("div", { style: { display: "flex", gap: "6px", marginTop: "8px" } }, save, apply)),
    );
  };

  newButton.addEventListener("click", async () => {
    const id = await promptDialog({ title: "New Matrix", label: "Matrix name", value: "Comp-Matrix" });
    if (!id) return;
    if (compensationById(id)) {
      setStatus(`A matrix named ${id} exists.`, true);
      return;
    }
    const channels = fluorescenceParameters();
    const matrix = channels.map((_, i) => channels.map((__, j) => (i === j ? 1 : 0)));
    const done = await runOp({ op: "compensation.save", compensation: { id, name: id, source: "manual", channels, matrix } }, { via: "matrix-editor", label: `Created matrix ${id}` });
    if (done) { current = id; draft = null; render(); }
  });
  editButton.addEventListener("click", async () => {
    const matrix = compensationById(current);
    if (!matrix) return;
    const id = await promptDialog({ title: "Edit Matrix", label: "Name of the editable copy", value: `${matrix.id}-copy` });
    if (!id) return;
    if (compensationById(id)) {
      setStatus(`A matrix named ${id} exists.`, true);
      return;
    }
    const copy = { id, name: id, source: "manual", channels: [...matrix.channels], matrix: matrix.matrix.map((row) => [...row]) };
    const done = await runOp({ op: "compensation.save", compensation: copy }, { via: "matrix-editor", label: `Copied ${matrix.id} to ${id}` });
    if (done) { current = id; draft = null; render(); }
  });
  deleteButton.addEventListener("click", async () => {
    if (!current) return;
    if (!(await confirmDialog({ title: "Delete Matrix", message: `Delete the matrix “${current}”? Samples using it will be shown uncompensated.` }))) return;
    await runOp({ op: "compensation.delete", compensationId: current }, { via: "matrix-editor", label: `Deleted matrix ${current}` });
  });

  win.body.append(el("div", { class: "matrix-layout" }, el("div", { style: { display: "flex", flexDirection: "column", minHeight: 0, borderRight: "1px solid var(--line)" } }, list, footer), main));
  const unsubscribe = onChange(() => render());
  render();
  editorWindow = { win, select: (id) => { current = id; draft = null; render(); } };
}

