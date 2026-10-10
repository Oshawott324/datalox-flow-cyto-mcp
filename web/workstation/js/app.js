// The workspace window: ribbon, Groups pane and the Samples pane with each
// sample's population tree, as in FlowJo.

import {
  activeWindow, allWindows, checkbox, confirmDialog, dialog, dialogOpen, el, formatCount, formatPercent,
  messageDialog, openMenu, promptDialog, radioGroup, KEEP_OPEN, closeMenus,
} from "./ui.js";
import {
  ALL_SAMPLES, childPopulations, compensationLabel, compensationOf, counts, gateOfPopulation, groupById, groups,
  onChange, populationName, sampleName, samplesOfGroup, store,
} from "./model.js";
import { canRedo, canUndo, redo, refresh, registry, runOp, setStatus, undo } from "./actions.js";
import { openGraphWindow } from "./graph.js";
import { applyMenuItems, openCompensationWindow, openMatrixEditor } from "./compensation.js";

const ICONS = { rect: "▭", polygon: "⬠", quadrant: "⊞", range: "↔" };

const ui = {
  tab: "workspace",
  expanded: new Set(),
  selected: new Set(),
  anchor: null,
  focus: null,
  keyOwner: "workspace",
};

const rowKey = {
  sample: (sampleId) => `s\u0001${sampleId}`,
  population: (sampleId, populationId) => `p\u0001${sampleId}\u0001${populationId}`,
  parse: (key) => {
    const [kind, sampleId, populationId] = key.split("\u0001");
    return { kind, sampleId, populationId: kind === "s" ? "root" : populationId };
  },
};

registry.openGraph = (options) => openGraphWindow(options);
registry.openCompensation = openCompensationWindow;
registry.openMatrixEditor = openMatrixEditor;
registry.selectedSamples = () => [...new Set([...ui.selected].map((key) => rowKey.parse(key)).filter((row) => row.kind === "s").map((row) => row.sampleId))];

function selectedPopulation() {
  const rows = [...ui.selected].map(rowKey.parse).filter((row) => row.kind === "p");
  return rows.length === 1 ? rows[0] : null;
}

function selectedRows() {
  return [...ui.selected].map(rowKey.parse);
}

// ------------------------------------------------------------------ ribbon

function ribbonButton({ icon, label, title, action, disabled, menu }) {
  const button = el("button", { class: "ribbon-button", title: title ?? label, "aria-label": label, disabled, "aria-haspopup": menu ? "menu" : undefined },
    el("span", { class: "icon", text: icon }), el("span", { text: menu ? `${label} ▾` : label }));
  button.addEventListener("click", () => (menu ? openMenu(menu(), button) : action()));
  return button;
}

function band(label, buttons) {
  return el("div", { class: "band", role: "group", "aria-label": label }, el("div", { class: "band-buttons" }, buttons), el("div", { class: "band-label", text: label }));
}

function renderRibbon() {
  const ribbon = document.getElementById("ribbon");
  const population = selectedPopulation();
  const group = groupById(store.currentGroup);
  const bands = {
    file: [
      band("Workspace", [
        ribbonButton({ icon: "💾", label: "Save", title: "Save (Ctrl+S)", action: saveMessage }),
      ]),
    ],
    edit: [
      band("History", [
        ribbonButton({ icon: "↶", label: "Undo", title: "Undo (Ctrl+Z)", action: undo, disabled: !canUndo() }),
        ribbonButton({ icon: "↷", label: "Redo", title: "Redo (Ctrl+Y)", action: redo, disabled: !canRedo() }),
      ]),
      band("Selection", [
        ribbonButton({ icon: "✎", label: "Rename", title: "Rename (F2)", action: renameSelected, disabled: !population }),
        ribbonButton({ icon: "✕", label: "Delete", title: "Delete (Del)", action: deleteSelected, disabled: !population }),
        ribbonButton({ icon: "☰", label: "Select All", title: "Select all samples (Ctrl+A)", action: selectAllSamples }),
      ]),
    ],
    workspace: [
      band("Groups", [
        ribbonButton({ icon: "➕", label: "Create Group", action: () => editGroup(null) }),
        ribbonButton({ icon: "✎", label: "Edit Group", action: () => editGroup(group), disabled: !group || group.implicit }),
        ribbonButton({ icon: "✕", label: "Delete Group", action: () => deleteGroup(group), disabled: !group || group.implicit }),
      ]),
      band("Gates", [
        ribbonButton({ icon: "⇉", label: "Copy to Group", disabled: !population, menu: () => copyMenu(population) }),
        ribbonButton({ icon: "📈", label: "Open Graph", action: openSelectedGraph, disabled: ui.selected.size === 0 }),
      ]),
      band("View", [
        ribbonButton({ icon: "⊞", label: "Expand All", action: () => { store.workspace.samples.forEach((sample) => expandAll(sample.id)); renderTree(); } }),
        ribbonButton({ icon: "⊟", label: "Collapse All", action: () => { ui.expanded.clear(); renderTree(); } }),
      ]),
    ],
    tools: [
      band("Cytometry", [
        ribbonButton({ icon: "◩", label: "Compensation", title: "Calculate a matrix from single-stain controls", action: openCompensationWindow }),
        ribbonButton({ icon: "▦", label: "Matrix Editor", action: () => openMatrixEditor() }),
        ribbonButton({
          icon: "[M]",
          label: "Apply Matrix",
          menu: () => {
            const matrices = store.workspace.compensations ?? [];
            return [
              ...matrices.map((matrix) => ({ label: matrix.id, submenu: applyMenuItems(matrix.id, registry.selectedSamples) })),
              "-",
              { label: "No Compensation", submenu: applyMenuItems(null, registry.selectedSamples) },
            ];
          },
        }),
      ]),
    ],
  };
  ribbon.replaceChildren(...bands[ui.tab]);
  document.querySelectorAll(".ribbon-tabs button").forEach((button) => button.setAttribute("aria-selected", String(button.dataset.tab === ui.tab)));
}

function saveMessage() {
  messageDialog({ title: "Save", message: `Every change is written to ${store.workspaceName} as you make it.\nThe workspace is at revision ${store.revision}.` });
}

// ------------------------------------------------------------------ groups

function renderGroups() {
  const list = document.getElementById("groupList");
  list.replaceChildren(...groups().map((group) => {
    const row = el("div", {
      class: `row groups-grid${group.id === store.currentGroup ? " selected" : ""}`,
      role: "option",
      "aria-selected": String(group.id === store.currentGroup),
      "data-group": group.id,
    }, el("span", { text: group.name }), el("span", { class: "num", text: String(samplesOfGroup(group.id).length) }), el("span", { text: { test: "Test", compensation: "Compensation", control: "Control" }[group.role] ?? "Test" }));
    row.addEventListener("click", () => {
      store.currentGroup = group.id;
      renderAll();
    });
    row.addEventListener("dblclick", () => { if (!group.implicit) editGroup(group); });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      store.currentGroup = group.id;
      renderAll();
      openMenu([
        { label: "Edit Group…", disabled: group.implicit, action: () => editGroup(group) },
        { label: "Delete Group", disabled: group.implicit, action: () => deleteGroup(group) },
        "-",
        { label: "Apply Matrix", submenu: (store.workspace.compensations ?? []).map((matrix) => ({ label: matrix.id, action: () => runOp({ op: "compensation.apply", compensationId: matrix.id, samples: samplesOfGroup(group.id) }, { via: "apply-matrix", label: `Applied ${matrix.id} to ${group.name}` }) })) },
      ], { x: event.clientX, y: event.clientY });
    });
    return row;
  }));
}

async function editGroup(group) {
  const name = el("input", { class: "text-input", value: group?.name ?? "", "aria-label": "Group name" });
  const role = radioGroup([
    { value: "test", label: "Test" },
    { value: "compensation", label: "Compensation" },
    { value: "control", label: "Control" },
  ], group?.role ?? "test", undefined, "Role");
  const preselected = new Set(group ? group.samples : registry.selectedSamples());
  const boxes = store.workspace.samples.map((sample) => ({ id: sample.id, box: checkbox(sampleName(sample.id), preselected.has(sample.id)) }));
  const errorText = el("div", { class: "error-text" });
  const body = el("div", {},
    el("div", { class: "field" }, el("label", { text: "Name" }), name),
    el("div", { class: "field" }, el("label", { text: "Role" }), role.node),
    el("div", { text: "Samples", style: { color: "#5d6676" } }),
    el("div", { class: "sample-checklist" }, boxes.map((entry) => entry.box.node)),
    errorText);
  const result = await dialog({
    title: group ? "Edit Group" : "Create Group",
    body,
    width: 460,
    buttons: [
      {
        label: "OK",
        primary: true,
        action: () => {
          if (!name.value.trim()) {
            errorText.textContent = "Enter a group name.";
            return KEEP_OPEN;
          }
          return { name: name.value.trim(), role: role.value, samples: boxes.filter((entry) => entry.box.checked).map((entry) => entry.id) };
        },
      },
      { label: "Cancel", cancel: true, action: () => null },
    ],
  });
  if (!result) return;
  if (group) await runOp({ op: "group.update", groupId: group.id, ...result }, { via: "group", label: `Updated group ${result.name}` });
  else {
    const detail = await runOp({ op: "group.create", ...result }, { via: "group", label: `Created group ${result.name}` });
    if (detail?.groupId) {
      store.currentGroup = detail.groupId;
      renderAll();
    }
  }
}

async function deleteGroup(group) {
  if (!group || group.implicit) return;
  if (!(await confirmDialog({ title: "Delete Group", message: `Delete the group “${group.name}”? Its samples stay in the workspace.` }))) return;
  if (store.currentGroup === group.id) store.currentGroup = ALL_SAMPLES;
  await runOp({ op: "group.delete", groupId: group.id }, { via: "group", label: `Deleted group ${group.name}` });
}

// ------------------------------------------------------------- sample tree

function expandAll(sampleId) {
  ui.expanded.add(rowKey.sample(sampleId));
  const walk = (parentId) => childPopulations(sampleId, parentId).forEach((population) => {
    ui.expanded.add(rowKey.population(sampleId, population.id));
    walk(population.id);
  });
  walk("root");
}

function visibleRows() {
  const rows = [];
  for (const sampleId of samplesOfGroup(store.currentGroup)) {
    const key = rowKey.sample(sampleId);
    rows.push({ key, sampleId, populationId: "root", depth: 0 });
    if (!ui.expanded.has(key)) continue;
    const walk = (parentId, depth) => {
      for (const population of childPopulations(sampleId, parentId)) {
        const childKey = rowKey.population(sampleId, population.id);
        rows.push({ key: childKey, sampleId, populationId: population.id, depth, population });
        if (ui.expanded.has(childKey)) walk(population.id, depth + 1);
      }
    };
    walk("root", 1);
  }
  return rows;
}

function hasChildren(sampleId, populationId) {
  return childPopulations(sampleId, populationId).length > 0;
}

let drag = null;

function renderTree() {
  const tree = document.getElementById("sampleTree");
  const rows = visibleRows();
  tree.replaceChildren(...rows.map((entry) => {
    const isSample = entry.populationId === "root";
    const expandable = hasChildren(entry.sampleId, entry.populationId);
    const expanded = ui.expanded.has(entry.key);
    const count = counts(entry.sampleId, entry.populationId);
    const label = isSample ? sampleName(entry.sampleId) : entry.population.name;
    const twisty = el("span", { class: "twisty", text: expandable ? (expanded ? "▾" : "▸") : "" });
    twisty.addEventListener("click", (event) => {
      event.stopPropagation();
      toggle(entry.key);
    });
    const statistic = !isSample && count ? formatPercent(count.parentCount ? count.count / count.parentCount * 100 : 0) : "";
    const compensation = isSample ? compensationOf(entry.sampleId) : null;
    const row = el("div", {
      class: `row samples-grid${ui.selected.has(entry.key) ? " selected" : ""}`,
      role: "treeitem",
      "aria-level": String(entry.depth + 1),
      "aria-expanded": expandable ? String(expanded) : undefined,
      "aria-selected": String(ui.selected.has(entry.key)),
      "aria-label": isSample ? `Sample ${label}` : `Population ${label}`,
      "data-key": entry.key,
    },
    el("span", { class: "name-cell", style: { paddingLeft: `${entry.depth * 18}px` } },
      twisty,
      el("span", { class: "node-icon", text: isSample ? "🧪" : ICONS[entry.population.type] ?? "•" }),
      el("span", { text: label })),
    el("span", { class: "num", title: isSample ? "" : "Freq. of Parent (%)", text: statistic }),
    el("span", { class: "num", text: count ? formatCount(count.count) : "…" }),
    el("span", {}, compensation ? el("span", { class: "comp-badge", title: "Double-click to open in the Matrix Editor", text: compensationLabel(compensation) }) : ""));
    row.addEventListener("pointerdown", (event) => onRowPointerDown(event, entry));
    row.addEventListener("dblclick", (event) => {
      if (event.target.classList?.contains("comp-badge")) {
        openMatrixEditor(compensation);
        return;
      }
      openGraphWindow({ sampleId: entry.sampleId, populationId: entry.populationId });
    });
    row.addEventListener("contextmenu", (event) => onRowContextMenu(event, entry));
    return row;
  }));
}

function toggle(key) {
  if (ui.expanded.has(key)) ui.expanded.delete(key);
  else ui.expanded.add(key);
  renderTree();
}

function select(key, event) {
  const keys = visibleRows().map((row) => row.key);
  if (event?.shiftKey && ui.anchor && keys.includes(ui.anchor)) {
    const [a, b] = [keys.indexOf(ui.anchor), keys.indexOf(key)].sort((p, q) => p - q);
    ui.selected = new Set(keys.slice(a, b + 1));
  } else if (event?.ctrlKey || event?.metaKey) {
    if (ui.selected.has(key)) ui.selected.delete(key);
    else ui.selected.add(key);
    ui.anchor = key;
  } else {
    ui.selected = new Set([key]);
    ui.anchor = key;
  }
  ui.focus = key;
  renderTree();
  renderRibbon();
}

function onRowPointerDown(event, entry) {
  if (event.button === 2) {
    if (!ui.selected.has(entry.key)) select(entry.key);
    return;
  }
  if (event.button !== 0 || event.target.classList?.contains("twisty")) return;
  if (!(ui.selected.has(entry.key) && !event.shiftKey && !event.ctrlKey && !event.metaKey)) select(entry.key, event);
  if (entry.populationId === "root") return;
  const start = { x: event.clientX, y: event.clientY };
  const move = (moveEvent) => {
    if (!drag && Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < 6) return;
    if (!drag) {
      drag = { entry, ghost: el("div", { class: "drag-ghost", text: populationName(entry.populationId) }) };
      document.body.append(drag.ghost);
    }
    drag.ghost.style.left = `${moveEvent.clientX + 12}px`;
    drag.ghost.style.top = `${moveEvent.clientY + 8}px`;
    document.querySelectorAll(".drop-target").forEach((node) => node.classList.remove("drop-target"));
    dropTarget(moveEvent)?.node.classList.add("drop-target");
  };
  const up = async (upEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (!drag) return;
    const target = dropTarget(upEvent);
    drag.ghost.remove();
    document.querySelectorAll(".drop-target").forEach((node) => node.classList.remove("drop-target"));
    const source = drag.entry;
    drag = null;
    if (!target) return;
    if (target.groupId) await copyToSamples(source, samplesOfGroup(target.groupId), groupById(target.groupId).name);
    else if (target.sampleId !== source.sampleId) await copyToSamples(source, [target.sampleId], sampleName(target.sampleId));
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function dropTarget(event) {
  const node = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-group], [data-key]");
  if (!node) return null;
  if (node.dataset.group) return { node, groupId: node.dataset.group };
  const { kind, sampleId } = rowKey.parse(node.dataset.key);
  return kind === "s" ? { node, sampleId } : null;
}

async function copyToSamples(source, targets, label) {
  const others = targets.filter((id) => id !== source.sampleId);
  if (others.length === 0) {
    setStatus("There is no other sample to copy the gate to.", true);
    return;
  }
  const name = populationName(source.populationId);
  const detail = await runOp({ op: "population.copy", sampleId: source.sampleId, populationId: source.populationId, targetSamples: others }, {
    via: "copy",
    label: `Copied “${name}” to ${label}`,
  });
  if (detail) {
    others.forEach((sampleId) => ui.expanded.add(rowKey.sample(sampleId)));
    setStatus(`Copied “${name}” and the gates below it to ${others.length} sample(s) in ${label}: ${detail.created} created, ${detail.replaced} replaced.`);
    renderTree();
  }
}

function copyMenu(population) {
  if (!population) return [];
  return [
    ...groups().map((group) => ({
      label: `${group.name} (${samplesOfGroup(group.id).length})`,
      action: () => copyToSamples(population, samplesOfGroup(group.id), group.name),
    })),
  ];
}

function onRowContextMenu(event, entry) {
  event.preventDefault();
  const at = { x: event.clientX, y: event.clientY };
  if (entry.populationId === "root") {
    const samples = registry.selectedSamples();
    openMenu([
      { label: "Open Graph", action: () => openGraphWindow({ sampleId: entry.sampleId }) },
      { label: ui.expanded.has(entry.key) ? "Collapse" : "Expand", action: () => toggle(entry.key) },
      { label: "Expand All", action: () => { expandAll(entry.sampleId); renderTree(); } },
      "-",
      {
        label: "Apply Matrix",
        submenu: [
          ...(store.workspace.compensations ?? []).map((matrix) => ({
            label: matrix.id,
            checked: compensationOf(entry.sampleId) === matrix.id,
            action: () => runOp({ op: "compensation.apply", compensationId: matrix.id, samples }, { via: "apply-matrix", label: `Applied ${matrix.id} to ${samples.length} sample(s)` }),
          })),
          "-",
          { label: "No Compensation", action: () => runOp({ op: "compensation.apply", compensationId: null, samples }, { via: "apply-matrix", label: `Removed compensation from ${samples.length} sample(s)` }) },
        ],
      },
      { label: "Create Group from Selection…", action: () => editGroup(null) },
    ], at);
    return;
  }
  openMenu([
    { label: "Open Graph", action: () => openGraphWindow({ sampleId: entry.sampleId, populationId: entry.populationId }) },
    { label: "Rename…", shortcut: "F2", action: renameSelected },
    { label: "Copy to Group", submenu: copyMenu(entry) },
    "-",
    { label: "Delete", shortcut: "Del", action: deleteSelected },
  ], at);
}

async function renameSelected() {
  const population = selectedPopulation();
  if (!population) return;
  const current = populationName(population.populationId);
  const name = await promptDialog({ title: "Rename", label: "Name", value: current });
  if (!name || name === current) return;
  await runOp({ op: "population.rename", populationId: population.populationId, name }, {
    via: "rename",
    label: `Renamed “${current}” to “${name}”`,
    undo: { op: "population.rename", populationId: population.populationId, name: current },
  });
}

async function deleteSelected() {
  const population = selectedPopulation();
  if (!population) return;
  const gate = gateOfPopulation(population.populationId);
  if (!gate) return;
  const name = gate.type === "quadrant" ? `quadrant gate (${gate.quadrants.map((entry) => entry.name).join(", ")})` : `gate “${gate.name ?? gate.id}”`;
  if (!(await confirmDialog({ title: "Delete", message: `Delete the ${name} and every population below it?` }))) return;
  ui.selected.clear();
  await runOp({ op: "gate.delete", gateId: gate.id }, {
    via: "delete",
    label: `Deleted ${name}`,
    undo: (detail) => ({ op: "gates.restore", gates: detail.removed }),
  });
}

function selectAllSamples() {
  ui.selected = new Set(samplesOfGroup(store.currentGroup).map((id) => rowKey.sample(id)));
  renderTree();
  renderRibbon();
}

function openSelectedGraph() {
  for (const row of selectedRows().slice(0, 6)) openGraphWindow({ sampleId: row.sampleId, populationId: row.populationId });
}

function onTreeKey(event) {
  const rows = visibleRows();
  const index = rows.findIndex((row) => row.key === ui.focus);
  const current = rows[index];
  const ctrl = event.ctrlKey || event.metaKey;
  if (ctrl && event.key.toLowerCase() === "a") {
    event.preventDefault();
    selectAllSamples();
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const next = rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))];
    if (next) select(next.key, event);
  } else if (event.key === "ArrowRight" && current) {
    if (!ui.expanded.has(current.key)) toggle(current.key);
  } else if (event.key === "ArrowLeft" && current) {
    if (ui.expanded.has(current.key)) toggle(current.key);
  } else if (event.key === "Enter" && current) {
    openGraphWindow({ sampleId: current.sampleId, populationId: current.populationId });
  } else if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    deleteSelected();
  } else if (event.key === "F2") {
    event.preventDefault();
    renameSelected();
  }
}

// ----------------------------------------------------------------- frame

function renderTitle() {
  document.getElementById("docName").textContent = store.workspaceName;
  document.getElementById("saveState").textContent = `All changes saved · revision ${store.revision}`;
  document.title = `Flowcyto Workstation — ${store.workspaceName}`;
}

function renderAll() {
  if (!groupById(store.currentGroup)) store.currentGroup = ALL_SAMPLES;
  const known = new Set(visibleRows().map((row) => row.key));
  for (const key of [...ui.selected]) if (!known.has(key)) ui.selected.delete(key);
  renderTitle();
  renderRibbon();
  renderGroups();
  renderTree();
}

document.querySelectorAll(".ribbon-tabs button").forEach((button) => button.addEventListener("click", () => {
  ui.tab = button.dataset.tab;
  renderRibbon();
}));

document.addEventListener("pointerdown", (event) => {
  const windowRoot = event.target.closest?.(".window");
  if (windowRoot) ui.keyOwner = allWindows().find((entry) => entry.root === windowRoot) ?? "workspace";
  else if (event.target.closest?.("#app")) ui.keyOwner = "workspace";
}, true);

document.addEventListener("contextmenu", (event) => {
  if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
});

document.addEventListener("keydown", (event) => {
  if (dialogOpen()) return;
  if (event.key === "Escape") closeMenus();
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (ctrl && key === "z" && !event.shiftKey) {
    event.preventDefault();
    undo();
    return;
  }
  if (ctrl && (key === "y" || (key === "z" && event.shiftKey))) {
    event.preventDefault();
    redo();
    return;
  }
  if (ctrl && key === "s") {
    event.preventDefault();
    saveMessage();
    return;
  }
  if (event.target instanceof HTMLInputElement) return;
  const owner = ui.keyOwner !== "workspace" && allWindows().includes(ui.keyOwner) ? ui.keyOwner : null;
  if (owner) {
    owner.onKey?.(event);
    return;
  }
  onTreeKey(event);
});

onChange(() => renderAll());

refresh().then(() => {
  setStatus("Ready");
}).catch((error) => {
  setStatus(error.message, true);
});

export { activeWindow };
