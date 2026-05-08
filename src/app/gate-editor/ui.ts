export const GATE_EDITOR_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Flowcyto Gate Editor</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #d8dde2;
      --panel: #eceff2;
      --line: #9da8b3;
      --text: #111827;
      --muted: #5b6575;
      --accent: #136f63;
      --accent-2: #8f3f2d;
      --danger: #b42318;
      --plot: #ffffee;
      --axis: #111827;
      --tick: #667085;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    button, select, input {
      font: inherit;
      color: inherit;
    }
    .shell {
      height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr;
      min-width: 560px;
      overflow: hidden;
    }
    .toolbar {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 3px;
      min-height: 31px;
      padding: 3px 5px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    .toolbar select,
    .toolbar input,
    .axis-dock select,
    .side-strip select {
      height: 24px;
      border: 1px solid var(--line);
      border-radius: 2px;
      background: #fff;
      padding: 0 5px;
      min-width: 74px;
    }
    .toolbar input { min-width: 112px; }
    .toolbar button {
      width: 25px;
      height: 25px;
      border: 1px solid var(--line);
      border-radius: 2px;
      background: linear-gradient(#ffffff, #dde3e8);
      padding: 0;
      cursor: pointer;
      line-height: 1;
      text-align: center;
    }
    .toolbar button.active {
      border-color: var(--accent);
      color: #063d36;
      background: linear-gradient(#d9fff7, #9ddcd0);
    }
    .toolbar button.danger {
      color: var(--danger);
    }
    .toolbar .wide-select { min-width: 132px; }
    .toolbar .gate-name { width: 118px; }
    .status {
      margin-left: auto;
      color: var(--muted);
      white-space: nowrap;
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 12px;
    }
    .status.error { color: var(--danger); }
    .main {
      position: relative;
      min-height: 0;
      overflow: auto;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 9px;
      background: #d8dde2;
    }
    .instrument {
      display: grid;
      gap: 5px;
      align-items: start;
      justify-items: center;
    }
    .plot-console {
      display: grid;
      grid-template-columns: 34px minmax(360px, min(72vh, calc(100vw - 192px), 560px)) 118px;
      grid-template-rows: auto auto;
      column-gap: 5px;
      row-gap: 4px;
      align-items: stretch;
      min-height: 0;
    }
    .axis-dock {
      display: flex;
      gap: 4px;
      align-items: center;
    }
    .axis-y {
      grid-column: 1;
      grid-row: 1;
      flex-direction: column;
      justify-content: flex-end;
      padding-bottom: 24px;
    }
    .axis-y select {
      width: 118px;
      transform: rotate(-90deg);
      transform-origin: center;
      margin: 42px -42px;
    }
    .axis-y #yScale {
      width: 94px;
      margin: 30px -30px;
    }
    .plot-stack {
      grid-column: 2;
      grid-row: 1 / 3;
      display: grid;
      grid-template-rows: auto auto;
      gap: 4px;
      justify-items: stretch;
    }
    .plot-frame {
      position: relative;
      width: 100%;
      aspect-ratio: 1 / 1;
      border: 1px solid var(--line);
      border-radius: 0;
      background: var(--plot);
      overflow: hidden;
      box-shadow: 0 1px 1px rgba(17, 24, 39, 0.18);
    }
    #plot {
      width: 100%;
      height: 100%;
      display: block;
      cursor: crosshair;
    }
    .axis-x {
      justify-content: center;
    }
    .axis-x #xSelect { min-width: 190px; }
    .side-strip {
      grid-column: 3;
      grid-row: 1 / 3;
      display: grid;
      align-content: end;
      gap: 5px;
      min-width: 0;
      padding-bottom: 24px;
    }
    .side-strip select {
      width: 112px;
      min-width: 0;
    }
    .gate-tray {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 240px;
      max-height: calc(100% - 16px);
      border: 1px solid var(--line);
      background: #f5f7f9;
      box-shadow: 0 10px 24px rgba(17, 24, 39, 0.22);
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      z-index: 3;
    }
    [hidden] { display: none !important; }
    .tray-head {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: center;
      gap: 6px;
      padding: 5px 7px;
      border-bottom: 1px solid var(--line);
      background: #e5eaf0;
      font-size: 12px;
      font-weight: 650;
    }
    .tray-head button {
      width: 22px;
      height: 22px;
      border: 1px solid var(--line);
      border-radius: 2px;
      background: linear-gradient(#ffffff, #dde3e8);
      padding: 0;
      cursor: pointer;
    }
    .gate-list {
      min-height: 0;
      overflow: auto;
      padding: 6px;
    }
    .gate-row {
      width: 100%;
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
      padding: 5px 6px;
      border: 1px solid var(--line);
      border-radius: 2px;
      background: #fff;
      text-align: left;
      cursor: pointer;
      font-size: 12px;
    }
    .gate-row.active {
      border-color: var(--accent);
      box-shadow: inset 3px 0 0 var(--accent);
    }
    .gate-row small { color: var(--muted); }
    .errors {
      display: none;
      max-height: 120px;
      overflow: auto;
      margin: 0;
      padding: 6px 8px;
      border-top: 1px solid var(--line);
      color: var(--danger);
      white-space: pre-wrap;
      font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .errors.show { display: block; }
    @media (max-width: 720px) {
      .shell { min-width: 360px; }
      .plot-console {
        grid-template-columns: 30px minmax(280px, 1fr);
        grid-template-rows: auto auto auto;
      }
      .plot-stack { grid-column: 2; }
      .side-strip {
        grid-column: 2;
        grid-row: 3;
        grid-auto-flow: column;
        align-content: center;
        justify-content: center;
        padding-bottom: 0;
      }
      .axis-x #xSelect { min-width: 160px; }
      .status { max-width: 160px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="toolbar">
      <select id="sampleSelect" class="wide-select" aria-label="Sample"></select>
      <select id="parentSelect" class="wide-select" aria-label="Parent population"></select>
      <button id="selectMode" data-mode="select" class="active" title="Select, drag handles, or drag empty plot space to pan" aria-label="Select">↖</button>
      <button id="rectMode" data-mode="rect" title="Drag a rectangle, then Save" aria-label="Rectangle gate">▭</button>
      <button id="polygonMode" data-mode="polygon" title="Click at least three vertices, then Save" aria-label="Polygon gate">△</button>
      <button id="resetView" title="Reset plot pan and zoom" aria-label="Reset view">↺</button>
      <button id="gateTrayToggle" title="Show gates" aria-label="Show gates" aria-expanded="false">☰</button>
      <input id="gateName" class="gate-name" value="Gate" aria-label="Gate name">
      <button id="saveGate" title="Save gate" aria-label="Save gate">✓</button>
      <button id="deleteGate" class="danger" title="Delete selected gate" aria-label="Delete selected gate">×</button>
      <span id="status" class="status">Loading</span>
    </div>
    <div class="main">
      <section class="instrument" aria-label="Gate editor instrument">
        <div class="plot-console">
          <div class="axis-dock axis-y">
            <select id="ySelect" aria-label="Y axis"></select>
            <select id="yScale" aria-label="Y scale">
              <option value="linear">Y Lin</option>
              <option value="arcsinh">Y Asinh</option>
            </select>
          </div>
          <div class="plot-stack">
            <div class="plot-frame">
              <canvas id="plot"></canvas>
            </div>
            <div class="axis-dock axis-x">
              <select id="xSelect" aria-label="X axis"></select>
              <select id="xScale" aria-label="X scale">
                <option value="linear">X Lin</option>
                <option value="arcsinh">X Asinh</option>
              </select>
            </div>
          </div>
          <div class="side-strip">
            <select id="renderMode" aria-label="Render mode">
              <option value="pseudocolor">Pseudocolor</option>
              <option value="density">Density</option>
              <option value="scatter">Scatter</option>
            </select>
          </div>
        </div>
      </section>
      <aside id="gateTray" class="gate-tray" hidden>
        <div class="tray-head">
          <span>Gates</span>
          <button id="closeGateTray" aria-label="Close gates">×</button>
        </div>
        <div id="gateList" class="gate-list"></div>
        <pre id="errors" class="errors"></pre>
      </aside>
    </div>
  </div>
  <script>
    const state = {
      workspace: null,
      metadata: null,
      preview: null,
      sampleId: null,
      x: null,
      y: null,
      parent: "root",
      mode: "select",
      selectedGateId: null,
      draft: null,
      drag: null,
      bounds: null,
      viewport: null,
      viewKey: null,
      renderMode: "pseudocolor",
      scale: { x: "linear", y: "linear" },
      savePending: false
    };
    const canvas = document.getElementById("plot");
    const ctx = canvas.getContext("2d");
    const sampleSelect = document.getElementById("sampleSelect");
    const parentSelect = document.getElementById("parentSelect");
    const xSelect = document.getElementById("xSelect");
    const ySelect = document.getElementById("ySelect");
    const renderModeSelect = document.getElementById("renderMode");
    const xScaleSelect = document.getElementById("xScale");
    const yScaleSelect = document.getElementById("yScale");
    const gateName = document.getElementById("gateName");
    const gateList = document.getElementById("gateList");
    const gateTray = document.getElementById("gateTray");
    const gateTrayToggle = document.getElementById("gateTrayToggle");
    const closeGateTray = document.getElementById("closeGateTray");
    const statusEl = document.getElementById("status");
    const errorsEl = document.getElementById("errors");
    const appConfig = readMcpAppConfig();

    function isMcpApp() {
      return Boolean(window.openai && typeof window.openai.callTool === "function");
    }

    function readMcpAppConfig() {
      const output = window.openai && window.openai.toolOutput ? window.openai.toolOutput : null;
      if (!output) return {};
      if (output.result && typeof output.result === "object") return output.result;
      return output;
    }

    function toolResultValue(response) {
      if (response && response.structuredContent && Object.prototype.hasOwnProperty.call(response.structuredContent, "result")) {
        return response.structuredContent.result;
      }
      if (response && Object.prototype.hasOwnProperty.call(response, "result")) return response.result;
      return response;
    }

    async function callFlowcytoTool(name, args) {
      const response = await window.openai.callTool(name, args);
      return toolResultValue(response);
    }

    function setStatus(text, isError) {
      statusEl.textContent = text;
      statusEl.classList.toggle("error", Boolean(isError));
    }

    function setGateTrayOpen(open) {
      gateTray.hidden = !open;
      gateTrayToggle.setAttribute("aria-expanded", open ? "true" : "false");
    }

    function setErrors(errors) {
      if (!errors || errors.length === 0) {
        errorsEl.textContent = "";
        errorsEl.classList.remove("show");
        return;
      }
      errorsEl.textContent = errors.map((error) => error.path + " " + error.code + ": " + error.message).join("\n");
      errorsEl.classList.add("show");
      setGateTrayOpen(true);
    }

    async function api(path, options) {
      if (isMcpApp()) return appApi(path, options);
      const response = await fetch(path, options);
      const body = await response.json();
      if (!response.ok && body.errors) setErrors(body.errors);
      return body;
    }

    async function appApi(path, options) {
      const url = new URL(path, "http://flowcyto.local");
      const workspacePath = appConfig.workspacePath || appConfig.workspace_path;
      if (!workspacePath) {
        return {
          ok: false,
          errors: [{ path: "/workspace_path", code: "missing_workspace_path", message: "workspace_path is required for the embedded gate editor." }]
        };
      }
      if (url.pathname === "/api/state") {
        return callFlowcytoTool("get_gate_editor_state", {
          workspace_path: workspacePath,
          sample_id: url.searchParams.get("sample_id") || appConfig.sampleId || appConfig.sample_id || undefined,
          parent_gate_id: url.searchParams.get("parent") || appConfig.parent || appConfig.parent_gate_id || undefined,
          x: url.searchParams.get("x") || appConfig.x || undefined,
          y: url.searchParams.get("y") || appConfig.y || undefined,
          max_events: Number.parseInt(url.searchParams.get("max_events") || "", 10) || appConfig.maxEvents || appConfig.max_events || undefined
        });
      }
      if (url.pathname === "/api/gates/upsert") {
        const body = JSON.parse(options && options.body ? options.body : "{}");
        return callFlowcytoTool("upsert_gate", {
          workspace_path: workspacePath,
          gate: body.gate,
          expected_revision: body.expectedRevision
        });
      }
      if (url.pathname === "/api/gates/delete") {
        const body = JSON.parse(options && options.body ? options.body : "{}");
        return callFlowcytoTool("delete_gate", {
          workspace_path: workspacePath,
          gate_id: body.gateId,
          expected_revision: body.expectedRevision
        });
      }
      return {
        ok: false,
        errors: [{ path: url.pathname, code: "not_found", message: "No embedded gate editor route for " + url.pathname + "." }]
      };
    }

    function setOptions(select, values, selected) {
      select.innerHTML = "";
      values.forEach((value) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        select.appendChild(option);
      });
      if (selected && values.includes(selected)) select.value = selected;
    }

    function setParentOptions() {
      if (!state.workspace) return;
      const values = [{ id: "root", label: "root" }];
      state.workspace.gates
        .filter((gate) => gate.sample === state.sampleId)
        .forEach((gate) => values.push({ id: gate.id, label: gate.name || gate.id }));
      parentSelect.innerHTML = "";
      values.forEach((entry) => {
        const option = document.createElement("option");
        option.value = entry.id;
        option.textContent = entry.label;
        parentSelect.appendChild(option);
      });
      if (values.some((entry) => entry.id === state.parent)) parentSelect.value = state.parent;
      else parentSelect.value = "root";
    }

    function activeGates() {
      if (!state.workspace) return [];
      return state.workspace.gates.filter((gate) => {
        if (gate.sample !== state.sampleId || gate.parent !== state.parent) return false;
        if (gate.type === "polygon" || gate.type === "rect") return gate.x === state.x && gate.y === state.y;
        return gate.x === state.x;
      });
    }

    function selectedGate() {
      if (!state.workspace || !state.selectedGateId) return null;
      return state.workspace.gates.find((gate) => gate.id === state.selectedGateId) || null;
    }

    function updateButtons() {
      document.querySelectorAll("[data-mode]").forEach((button) => {
        button.classList.toggle("active", button.dataset.mode === state.mode);
      });
    }

    const ARCSINH_COFACTOR = 150;
    const DENSITY_GRID_MAX = 360;

    function transformValue(value, scale) {
      if (scale === "arcsinh") return Math.asinh(value / ARCSINH_COFACTOR);
      return value;
    }

    function inverseTransformValue(value, scale) {
      if (scale === "arcsinh") return Math.sinh(value) * ARCSINH_COFACTOR;
      return value;
    }

    function transformPoint(point) {
      return [
        transformValue(point[0], state.scale.x),
        transformValue(point[1], state.scale.y)
      ];
    }

    function inverseTransformPoint(point) {
      return [
        inverseTransformValue(point[0], state.scale.x),
        inverseTransformValue(point[1], state.scale.y)
      ];
    }

    function includeVisualPoint(point, bounds) {
      if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return;
      bounds.xMin = Math.min(bounds.xMin, point[0]);
      bounds.xMax = Math.max(bounds.xMax, point[0]);
      bounds.yMin = Math.min(bounds.yMin, point[1]);
      bounds.yMax = Math.max(bounds.yMax, point[1]);
    }

    function computeVisualBounds() {
      const points = state.preview && state.preview.points ? state.preview.points : [];
      const bins = state.preview && state.preview.bins ? state.preview.bins : null;
      const bounds = {
        xMin: Number.POSITIVE_INFINITY,
        xMax: Number.NEGATIVE_INFINITY,
        yMin: Number.POSITIVE_INFINITY,
        yMax: Number.NEGATIVE_INFINITY
      };
      points.forEach((point) => {
        includeVisualPoint(transformPoint(point), bounds);
      });
      if (bins) {
        [
          [bins.xMin, bins.yMin],
          [bins.xMin, bins.yMax],
          [bins.xMax, bins.yMin],
          [bins.xMax, bins.yMax]
        ].forEach((point) => {
          includeVisualPoint(transformPoint(point), bounds);
        });
      }
      activeGates().forEach((gate) => {
        if (gate.type === "polygon") {
          gate.vertices.forEach((point) => {
            includeVisualPoint(transformPoint(point), bounds);
          });
        }
        if (gate.type === "rect") {
          [[gate.xMin, gate.yMin], [gate.xMin, gate.yMax], [gate.xMax, gate.yMin], [gate.xMax, gate.yMax]].forEach((point) => {
            includeVisualPoint(transformPoint(point), bounds);
          });
        }
      });
      if (!Number.isFinite(bounds.xMin) || !Number.isFinite(bounds.xMax) || bounds.xMin === bounds.xMax) {
        bounds.xMin = 0;
        bounds.xMax = 1;
      }
      if (!Number.isFinite(bounds.yMin) || !Number.isFinite(bounds.yMax) || bounds.yMin === bounds.yMax) {
        bounds.yMin = 0;
        bounds.yMax = 1;
      }
      const xPad = (bounds.xMax - bounds.xMin) * 0.06;
      const yPad = (bounds.yMax - bounds.yMin) * 0.06;
      return {
        xMin: bounds.xMin - xPad,
        xMax: bounds.xMax + xPad,
        yMin: bounds.yMin - yPad,
        yMax: bounds.yMax + yPad
      };
    }

    function resetViewport() {
      state.bounds = computeVisualBounds();
      state.viewport = { ...state.bounds };
      draw();
    }

    function ensureViewport() {
      state.bounds = computeVisualBounds();
      if (!state.viewport) state.viewport = { ...state.bounds };
    }

    function panByPixels(dx, dy) {
      if (!state.viewport) return;
      const area = plotArea();
      const dataDx = dx / area.width * (state.viewport.xMax - state.viewport.xMin);
      const dataDy = dy / area.height * (state.viewport.yMax - state.viewport.yMin);
      state.viewport = {
        xMin: state.viewport.xMin - dataDx,
        xMax: state.viewport.xMax - dataDx,
        yMin: state.viewport.yMin + dataDy,
        yMax: state.viewport.yMax + dataDy
      };
    }

    function zoomAt(screenPoint, factor) {
      if (!state.viewport) return;
      const anchor = canvasToVisual(screenPoint);
      state.viewport = {
        xMin: anchor[0] - (anchor[0] - state.viewport.xMin) * factor,
        xMax: anchor[0] + (state.viewport.xMax - anchor[0]) * factor,
        yMin: anchor[1] - (anchor[1] - state.viewport.yMin) * factor,
        yMax: anchor[1] + (state.viewport.yMax - anchor[1]) * factor
      };
    }

    function cssSize() {
      const rect = canvas.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }

    function plotArea() {
      const size = cssSize();
      const left = 58;
      const top = 18;
      const right = 16;
      const bottom = 44;
      return {
        left,
        top,
        right,
        bottom,
        width: Math.max(1, size.width - left - right),
        height: Math.max(1, size.height - top - bottom)
      };
    }

    function visualToCanvas(point) {
      const area = plotArea();
      const bounds = state.viewport || state.bounds;
      const x = area.left + ((point[0] - bounds.xMin) / (bounds.xMax - bounds.xMin)) * area.width;
      const y = area.top + area.height - ((point[1] - bounds.yMin) / (bounds.yMax - bounds.yMin)) * area.height;
      return [x, y];
    }

    function dataToCanvas(point) {
      return visualToCanvas(transformPoint(point));
    }

    function canvasToVisual(point) {
      const area = plotArea();
      const bounds = state.viewport || state.bounds;
      const x = bounds.xMin + ((point[0] - area.left) / area.width) * (bounds.xMax - bounds.xMin);
      const y = bounds.yMin + ((area.top + area.height - point[1]) / area.height) * (bounds.yMax - bounds.yMin);
      return [x, y];
    }

    function canvasToData(point) {
      return inverseTransformPoint(canvasToVisual(point));
    }

    function resizeCanvas() {
      const size = cssSize();
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.floor(size.width * ratio));
      const height = Math.max(1, Math.floor(size.height * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    }

    function drawPolygon(points, color, selected) {
      if (points.length === 0) return;
      ctx.beginPath();
      points.forEach((point, index) => {
        const screen = dataToCanvas(point);
        if (index === 0) ctx.moveTo(screen[0], screen[1]);
        else ctx.lineTo(screen[0], screen[1]);
      });
      if (points.length > 2) ctx.closePath();
      ctx.strokeStyle = color;
      ctx.lineWidth = selected ? 2.5 : 1.6;
      ctx.stroke();
      points.forEach((point) => {
        const screen = dataToCanvas(point);
        ctx.beginPath();
        ctx.arc(screen[0], screen[1], selected ? 4 : 3, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      });
    }

    function drawRectGate(gate, color, selected) {
      const a = dataToCanvas([gate.xMin, gate.yMin]);
      const b = dataToCanvas([gate.xMax, gate.yMax]);
      const x = Math.min(a[0], b[0]);
      const y = Math.min(a[1], b[1]);
      const width = Math.abs(b[0] - a[0]);
      const height = Math.abs(b[1] - a[1]);
      ctx.strokeStyle = color;
      ctx.lineWidth = selected ? 2.5 : 1.6;
      ctx.strokeRect(x, y, width, height);
      [[gate.xMin, gate.yMin], [gate.xMin, gate.yMax], [gate.xMax, gate.yMin], [gate.xMax, gate.yMax]].forEach((point) => {
        const screen = dataToCanvas(point);
        ctx.fillStyle = color;
        ctx.fillRect(screen[0] - 3, screen[1] - 3, 6, 6);
      });
    }

    function plotClip(area, render) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(area.left, area.top, area.width, area.height);
      ctx.clip();
      render();
      ctx.restore();
    }

    function inPlotArea(point, area) {
      return point[0] >= area.left && point[0] <= area.left + area.width && point[1] >= area.top && point[1] <= area.top + area.height;
    }

    function pointInPlot(point) {
      return inPlotArea(point, plotArea());
    }

    function interpolate(a, b, t) {
      return Math.round(a + (b - a) * t);
    }

    function densityColor(t, mode) {
      if (mode === "density") {
        const value = Math.round(255 - 210 * t);
        return [value, value, 255, 255];
      }
      const stops = [
        [0.00, [21, 39, 86]],
        [0.30, [18, 145, 171]],
        [0.55, [53, 180, 98]],
        [0.78, [247, 208, 63]],
        [1.00, [188, 37, 42]]
      ];
      for (let index = 1; index < stops.length; index += 1) {
        const previous = stops[index - 1];
        const next = stops[index];
        if (t <= next[0]) {
          const local = (t - previous[0]) / (next[0] - previous[0]);
          return [
            interpolate(previous[1][0], next[1][0], local),
            interpolate(previous[1][1], next[1][1], local),
            interpolate(previous[1][2], next[1][2], local),
            255
          ];
        }
      }
      return [188, 37, 42, 255];
    }

    function drawServerBins(area, mode) {
      const bins = state.preview && state.preview.bins ? state.preview.bins : null;
      if (!bins || !bins.counts || bins.counts.length === 0) return false;
      let maxCount = 0;
      bins.counts.forEach((count) => {
        if (count > maxCount) maxCount = count;
      });
      if (maxCount === 0) return true;
      const maxLog = Math.log1p(maxCount);
      const xStep = (bins.xMax - bins.xMin) / bins.width;
      const yStep = (bins.yMax - bins.yMin) / bins.height;
      ctx.save();
      for (let yIndex = 0; yIndex < bins.height; yIndex += 1) {
        for (let xIndex = 0; xIndex < bins.width; xIndex += 1) {
          const count = bins.counts[yIndex * bins.width + xIndex];
          if (!count) continue;
          const x0 = bins.xMin + xIndex * xStep;
          const x1 = x0 + xStep;
          const y0 = bins.yMin + yIndex * yStep;
          const y1 = y0 + yStep;
          const a = visualToCanvas(transformPoint([x0, y0]));
          const b = visualToCanvas(transformPoint([x1, y1]));
          const left = Math.max(area.left, Math.min(a[0], b[0]));
          const right = Math.min(area.left + area.width, Math.max(a[0], b[0]));
          const top = Math.max(area.top, Math.min(a[1], b[1]));
          const bottom = Math.min(area.top + area.height, Math.max(a[1], b[1]));
          if (right <= left || bottom <= top) continue;
          const color = densityColor(Math.log1p(count) / maxLog, mode);
          ctx.fillStyle = "rgba(" + color[0] + "," + color[1] + "," + color[2] + "," + (color[3] / 255) + ")";
          ctx.fillRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top));
        }
      }
      ctx.restore();
      return true;
    }

    function drawDensity(area, mode) {
      if (drawServerBins(area, mode)) return;
      const points = state.preview && state.preview.points ? state.preview.points : [];
      const gridWidth = Math.max(64, Math.min(DENSITY_GRID_MAX, Math.floor(area.width)));
      const gridHeight = Math.max(64, Math.min(DENSITY_GRID_MAX, Math.floor(area.height)));
      const bins = new Uint16Array(gridWidth * gridHeight);
      let maxCount = 0;
      points.forEach((point) => {
        const screen = dataToCanvas(point);
        if (!inPlotArea(screen, area)) return;
        const x = Math.min(gridWidth - 1, Math.max(0, Math.floor(((screen[0] - area.left) / area.width) * gridWidth)));
        const y = Math.min(gridHeight - 1, Math.max(0, Math.floor(((screen[1] - area.top) / area.height) * gridHeight)));
        const index = y * gridWidth + x;
        bins[index] += 1;
        if (bins[index] > maxCount) maxCount = bins[index];
      });
      if (maxCount === 0) return;
      const image = ctx.createImageData(gridWidth, gridHeight);
      const maxLog = Math.log1p(maxCount);
      for (let index = 0; index < bins.length; index += 1) {
        const count = bins[index];
        if (count === 0) continue;
        const color = densityColor(Math.log1p(count) / maxLog, mode);
        const offset = index * 4;
        image.data[offset] = color[0];
        image.data[offset + 1] = color[1];
        image.data[offset + 2] = color[2];
        image.data[offset + 3] = color[3];
      }
      const buffer = document.createElement("canvas");
      buffer.width = gridWidth;
      buffer.height = gridHeight;
      const bufferContext = buffer.getContext("2d");
      if (!bufferContext) return;
      bufferContext.putImageData(image, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(buffer, area.left, area.top, area.width, area.height);
    }

    function drawScatter(area) {
      const points = state.preview && state.preview.points ? state.preview.points : [];
      if (points.length === 0 && drawServerBins(area, "density")) return;
      ctx.fillStyle = "rgba(38, 70, 83, 0.30)";
      points.forEach((point) => {
        const screen = dataToCanvas(point);
        if (!inPlotArea(screen, area)) return;
        ctx.fillRect(screen[0] - 0.6, screen[1] - 0.6, 1.2, 1.2);
      });
    }

    function tickValues(min, max, count) {
      const values = [];
      if (!Number.isFinite(min) || !Number.isFinite(max) || count < 2) return values;
      const step = (max - min) / (count - 1);
      for (let index = 0; index < count; index += 1) values.push(min + step * index);
      return values;
    }

    function formatTick(value) {
      const abs = Math.abs(value);
      if (abs >= 1000000) return (value / 1000000).toFixed(abs >= 10000000 ? 0 : 1).replace(/\\.0$/, "") + "M";
      if (abs >= 1000) return (value / 1000).toFixed(abs >= 10000 ? 0 : 1).replace(/\\.0$/, "") + "K";
      if (abs >= 100) return value.toFixed(0);
      if (abs >= 10) return value.toFixed(1).replace(/\\.0$/, "");
      return value.toFixed(2).replace(/\\.00$/, "").replace(/(\\.\\d)0$/, "$1");
    }

    function scaleLabel(scale) {
      return scale === "arcsinh" ? "asinh" : "lin";
    }

    function drawGrid(area) {
      const bounds = state.viewport || state.bounds;
      ctx.save();
      ctx.strokeStyle = "#edf1f5";
      ctx.lineWidth = 1;
      tickValues(bounds.xMin, bounds.xMax, 6).forEach((tick) => {
        const screen = visualToCanvas([tick, bounds.yMin]);
        ctx.beginPath();
        ctx.moveTo(screen[0], area.top);
        ctx.lineTo(screen[0], area.top + area.height);
        ctx.stroke();
      });
      tickValues(bounds.yMin, bounds.yMax, 6).forEach((tick) => {
        const screen = visualToCanvas([bounds.xMin, tick]);
        ctx.beginPath();
        ctx.moveTo(area.left, screen[1]);
        ctx.lineTo(area.left + area.width, screen[1]);
        ctx.stroke();
      });
      ctx.restore();
    }

    function drawAxes(area) {
      const bounds = state.viewport || state.bounds;
      const xTicks = tickValues(bounds.xMin, bounds.xMax, 6);
      const yTicks = tickValues(bounds.yMin, bounds.yMax, 6);
      ctx.save();
      ctx.strokeStyle = "#111827";
      ctx.fillStyle = "#344054";
      ctx.lineWidth = 1;
      ctx.font = "11px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      ctx.textBaseline = "top";
      ctx.textAlign = "center";
      xTicks.forEach((tick) => {
        const screen = visualToCanvas([tick, bounds.yMin]);
        ctx.beginPath();
        ctx.moveTo(screen[0], area.top + area.height);
        ctx.lineTo(screen[0], area.top + area.height + 5);
        ctx.stroke();
        ctx.fillText(formatTick(inverseTransformValue(tick, state.scale.x)), screen[0], area.top + area.height + 8);
      });
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      yTicks.forEach((tick) => {
        const screen = visualToCanvas([bounds.xMin, tick]);
        ctx.beginPath();
        ctx.moveTo(area.left - 5, screen[1]);
        ctx.lineTo(area.left, screen[1]);
        ctx.stroke();
        ctx.fillText(formatTick(inverseTransformValue(tick, state.scale.y)), area.left - 8, screen[1]);
      });
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "#111827";
      ctx.font = "12px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      ctx.fillText((state.x || "X") + " " + scaleLabel(state.scale.x), area.left + area.width / 2, area.top + area.height + 38);
      ctx.save();
      ctx.translate(14, area.top + area.height / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText((state.y || "Y") + " " + scaleLabel(state.scale.y), 0, 0);
      ctx.restore();
      ctx.strokeRect(area.left + 0.5, area.top + 0.5, area.width - 1, area.height - 1);
      ctx.restore();
    }

    function draw() {
      resizeCanvas();
      ensureViewport();
      canvas.setAttribute("aria-label", (state.x || "X") + " " + state.scale.x + " versus " + (state.y || "Y") + " " + state.scale.y);
      const size = cssSize();
      const area = plotArea();
      ctx.clearRect(0, 0, size.width, size.height);
      ctx.fillStyle = "#d8dde2";
      ctx.fillRect(0, 0, size.width, size.height);
      ctx.fillStyle = "#ffffee";
      ctx.fillRect(area.left, area.top, area.width, area.height);
      drawGrid(area);
      plotClip(area, () => {
        if (state.renderMode === "scatter") drawScatter(area);
        else drawDensity(area, state.renderMode);
      });
      plotClip(area, () => {
        activeGates().forEach((gate) => {
          const selected = gate.id === state.selectedGateId;
          const color = selected ? "#8f3f2d" : "#136f63";
          if (gate.type === "polygon") drawPolygon(gate.vertices, color, selected);
          if (gate.type === "rect") drawRectGate(gate, color, selected);
        });
        if (state.draft && state.draft.type === "polygon") drawPolygon(state.draft.vertices, "#8f3f2d", true);
        if (state.draft && state.draft.type === "rect") drawRectGate(state.draft, "#8f3f2d", true);
      });
      drawAxes(area);
    }

    function renderGateList() {
      gateList.innerHTML = "";
      activeGates().forEach((gate) => {
        const button = document.createElement("button");
        button.className = "gate-row" + (gate.id === state.selectedGateId ? " active" : "");
        const name = document.createElement("span");
        name.textContent = gate.name || gate.id;
        const type = document.createElement("small");
        type.textContent = gate.type;
        button.appendChild(name);
        button.appendChild(type);
        button.addEventListener("click", () => {
          state.selectedGateId = gate.id;
          gateName.value = gate.name || gate.id;
          renderGateList();
          draw();
        });
        gateList.appendChild(button);
      });
    }

    async function loadState(reason) {
      const params = new URLSearchParams();
      if (sampleSelect.value) params.set("sample_id", sampleSelect.value);
      if (reason !== "sample" && parentSelect.value) params.set("parent", parentSelect.value);
      if (reason !== "sample" && xSelect.value) params.set("x", xSelect.value);
      if (reason !== "sample" && ySelect.value) params.set("y", ySelect.value);
      const body = await api("/api/state?" + params.toString());
      if (!body.ok) {
        setErrors(body.errors);
        return;
      }
      state.workspace = body.workspace;
      state.metadata = body.metadata;
      state.preview = body.preview;
      state.sampleId = body.sampleId;
      state.parent = body.parent || "root";
      state.x = body.x;
      state.y = body.y;
      const nextViewKey = [state.sampleId, state.parent, state.x, state.y].join("\\0");
      if (state.viewKey !== nextViewKey || reason === "sample" || reason === "axis" || reason === "parent") {
        state.viewport = null;
        state.viewKey = nextViewKey;
      }
      setOptions(sampleSelect, body.workspace.samples.map((sample) => sample.id), state.sampleId);
      setParentOptions();
      setOptions(xSelect, body.metadata.parameters.map((parameter) => parameter.name), state.x);
      setOptions(ySelect, body.metadata.parameters.map((parameter) => parameter.name), state.y);
      if (!selectedGate()) state.selectedGateId = null;
      setErrors(body.validation && !body.validation.ok ? body.validation.errors : []);
      renderGateList();
      draw();
      setStatus(reason === "file" ? "Workspace revision " + body.workspace.revision : "Ready revision " + body.workspace.revision);
    }

    function makeGateId() {
      return "gate_" + Date.now().toString(36);
    }

    async function saveGate() {
      if (!state.workspace) return;
      let gate = null;
      if (state.draft && state.draft.type === "polygon" && state.draft.vertices.length >= 3) {
        gate = {
          id: makeGateId(),
          name: gateName.value || "Gate",
          sample: state.sampleId,
          parent: state.parent,
          type: "polygon",
          x: state.x,
          y: state.y,
          vertices: state.draft.vertices
        };
      } else if (state.draft && state.draft.type === "rect") {
        gate = {
          id: makeGateId(),
          name: gateName.value || "Gate",
          sample: state.sampleId,
          parent: state.parent,
          type: "rect",
          x: state.x,
          y: state.y,
          xMin: Math.min(state.draft.xMin, state.draft.xMax),
          xMax: Math.max(state.draft.xMin, state.draft.xMax),
          yMin: Math.min(state.draft.yMin, state.draft.yMax),
          yMax: Math.max(state.draft.yMin, state.draft.yMax)
        };
      } else if (selectedGate()) {
        gate = selectedGate();
        gate.name = gateName.value || gate.name || gate.id;
      }
      if (!gate) {
        setStatus("No gate to save", true);
        return;
      }
      state.savePending = true;
      const result = await api("/api/gates/upsert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gate, expectedRevision: state.workspace.revision })
      });
      state.savePending = false;
      if (result.ok) {
        state.draft = null;
        state.selectedGateId = gate.id;
        await loadState("save");
      } else {
        setErrors(result.errors);
        setStatus("Write rejected", true);
      }
    }

    async function deleteSelectedGate() {
      if (!state.workspace || !state.selectedGateId) return;
      const result = await api("/api/gates/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gateId: state.selectedGateId, expectedRevision: state.workspace.revision })
      });
      if (result.ok) {
        state.selectedGateId = null;
        await loadState("delete");
      } else {
        setErrors(result.errors);
        setStatus("Delete rejected", true);
      }
    }

    function canvasPoint(event) {
      const rect = canvas.getBoundingClientRect();
      return [event.clientX - rect.left, event.clientY - rect.top];
    }

    function distance(a, b) {
      return Math.hypot(a[0] - b[0], a[1] - b[1]);
    }

    function hitVertex(screenPoint) {
      if (!pointInPlot(screenPoint)) return null;
      for (const gate of activeGates()) {
        if (gate.type === "polygon") {
          for (let index = 0; index < gate.vertices.length; index += 1) {
            if (distance(screenPoint, dataToCanvas(gate.vertices[index])) <= 9) return { gateId: gate.id, type: "polygon", index };
          }
        }
        if (gate.type === "rect") {
          const handles = [[gate.xMin, gate.yMin], [gate.xMin, gate.yMax], [gate.xMax, gate.yMin], [gate.xMax, gate.yMax]];
          for (let index = 0; index < handles.length; index += 1) {
            if (distance(screenPoint, dataToCanvas(handles[index])) <= 9) return { gateId: gate.id, type: "rect", index };
          }
        }
      }
      return null;
    }

    canvas.addEventListener("pointerdown", (event) => {
      const point = canvasPoint(event);
      if (!pointInPlot(point)) return;
      const data = canvasToData(point);
      if (state.mode === "polygon") {
        if (!state.draft || state.draft.type !== "polygon") state.draft = { type: "polygon", vertices: [] };
        state.draft.vertices.push(data);
        draw();
        return;
      }
      if (state.mode === "rect") {
        state.draft = { type: "rect", xMin: data[0], xMax: data[0], yMin: data[1], yMax: data[1] };
        state.drag = { type: "draftRect" };
        draw();
        return;
      }
      const hit = hitVertex(point);
      if (hit) {
        state.selectedGateId = hit.gateId;
        state.drag = hit;
        const gate = selectedGate();
        if (gate) gateName.value = gate.name || gate.id;
        renderGateList();
        draw();
        return;
      }
      state.drag = { type: "pan", last: point };
    });

    canvas.addEventListener("pointermove", (event) => {
      if (!state.drag) return;
      const point = canvasPoint(event);
      const data = canvasToData(canvasPoint(event));
      if (state.drag.type === "pan") {
        panByPixels(point[0] - state.drag.last[0], point[1] - state.drag.last[1]);
        state.drag.last = point;
        draw();
        return;
      }
      if (state.drag.type === "draftRect" && state.draft && state.draft.type === "rect") {
        state.draft.xMax = data[0];
        state.draft.yMax = data[1];
        draw();
        return;
      }
      const gate = selectedGate();
      if (!gate) return;
      if (state.drag.type === "polygon" && gate.type === "polygon") {
        gate.vertices[state.drag.index] = data;
      }
      if (state.drag.type === "rect" && gate.type === "rect") {
        if (state.drag.index === 0 || state.drag.index === 1) gate.xMin = data[0];
        if (state.drag.index === 2 || state.drag.index === 3) gate.xMax = data[0];
        if (state.drag.index === 0 || state.drag.index === 2) gate.yMin = data[1];
        if (state.drag.index === 1 || state.drag.index === 3) gate.yMax = data[1];
      }
      draw();
    });

    window.addEventListener("pointerup", () => {
      state.drag = null;
    });

    canvas.addEventListener("wheel", (event) => {
      const point = canvasPoint(event);
      if (!pointInPlot(point)) return;
      event.preventDefault();
      zoomAt(point, event.deltaY < 0 ? 0.82 : 1.22);
      draw();
    }, { passive: false });

    document.querySelectorAll("[data-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        state.mode = button.dataset.mode;
        state.draft = null;
        updateButtons();
        draw();
      });
    });
    sampleSelect.addEventListener("change", () => loadState("sample"));
    parentSelect.addEventListener("change", () => {
      state.parent = parentSelect.value || "root";
      state.selectedGateId = null;
      state.draft = null;
      loadState("parent");
    });
    xSelect.addEventListener("change", () => loadState("axis"));
    ySelect.addEventListener("change", () => loadState("axis"));
    renderModeSelect.addEventListener("change", () => {
      state.renderMode = renderModeSelect.value;
      draw();
    });
    xScaleSelect.addEventListener("change", () => {
      state.scale.x = xScaleSelect.value;
      state.viewport = null;
      draw();
    });
    yScaleSelect.addEventListener("change", () => {
      state.scale.y = yScaleSelect.value;
      state.viewport = null;
      draw();
    });
    gateTrayToggle.addEventListener("click", () => setGateTrayOpen(gateTray.hidden));
    closeGateTray.addEventListener("click", () => setGateTrayOpen(false));
    document.getElementById("saveGate").addEventListener("click", saveGate);
    document.getElementById("deleteGate").addEventListener("click", deleteSelectedGate);
    document.getElementById("resetView").addEventListener("click", resetViewport);
    window.addEventListener("resize", draw);

    if (isMcpApp()) {
      window.setInterval(async () => {
        if (!state.workspace || state.savePending) return;
        const workspacePath = appConfig.workspacePath || appConfig.workspace_path;
        if (!workspacePath) return;
        try {
          const body = await callFlowcytoTool("get_workspace_revision", { workspace_path: workspacePath });
          if (body.ok && body.revision > state.workspace.revision) await loadState("file");
        } catch (error) {
          setStatus(error.message || String(error), true);
        }
      }, 1200);
    } else {
      const events = new EventSource("/api/events");
      events.addEventListener("workspace_changed", async (event) => {
        const change = JSON.parse(event.data);
        if (!state.workspace || change.revision > state.workspace.revision) {
          if (state.savePending) {
            state.workspace = change.workspace;
            setStatus("Workspace revision " + change.revision);
            return;
          }
          await loadState("file");
        }
      });
      events.addEventListener("workspace_error", (event) => {
        const body = JSON.parse(event.data);
        setErrors(body.errors);
        setStatus("Workspace read failed", true);
      });
      events.onerror = () => setStatus("Watcher disconnected", true);
    }

    loadState("init").catch((error) => setStatus(error.message || String(error), true));
  </script>
</body>
</html>`;
