import type { ImportedAxisTransform, ImportedFlowJoMatrix } from "./flowjo-compensation-import.js";
import { namePathToGateId } from "./gate-path.js";
import type {
  FlowcytoLayout,
  FlowcytoWorkspace,
  LayoutPanel,
  LayoutPanelSource,
  LayoutPlotType,
  PanelAxis,
  PanelBlocker,
  PanelStatus,
  SampleMetadata,
} from "./types.js";

type XmlNode = Record<string, unknown>;

/** Everything the importer knows about one FlowJo sample that was actually loaded. */
export type FlowJoLayoutSample = {
  sampleId: string;
  metadata: SampleMetadata;
  resolveChannel: (channel: string) => string;
  /** This sample's own spillover matrices, keyed by the prefix each declares. */
  matricesByPrefix: Map<string, ImportedFlowJoMatrix>;
  /** This sample's own transforms, keyed by the raw FlowJo parameter name. */
  transforms: Map<string, ImportedAxisTransform>;
  /**
   * Divisors the sample's bound cytometer applies to FCS values before FlowJo
   * transforms them. Carried here so an imported axis states its input domain
   * explicitly instead of the renderer guessing one.
   */
  rescale: { linear: number; log: number; provenance: string };
};

export type FlowJoLayoutImportInput = {
  workspaceXml: XmlNode;
  /** Keyed by the FlowJo numeric sampleID, as a string. */
  samplesByFlowJoId: Map<string, FlowJoLayoutSample>;
  /** Numeric sampleIDs named by any <SampleRef>, used as evidence for dangling ids. */
  groupReferencedSampleIds: Set<string>;
  workspace: FlowcytoWorkspace;
};

export type FlowJoLayoutImportResult = {
  layouts: FlowcytoLayout[];
  warnings: string[];
  panelsTotal: number;
  /** Bound and renderable. */
  panelsResolved: number;
  /** Bound, but carrying an unresolved compensation reference or transform. */
  panelsPartial: number;
  panelsUnresolved: number;
  unresolvedByReason: Record<string, number>;
  blockedByReason: Record<string, number>;
  compensationReferences: {
    /** Explicit prefixed references bound to an imported matrix. */
    resolved: number;
    /** Explicit prefixed references that could not be bound to a matrix. */
    unresolved: number;
    /** Axes carrying no compensation reference at all. Not a claim of raw data. */
    absent: number;
  };
};

function asRecord(value: unknown): XmlNode | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as XmlNode : null;
}

function arrayOf(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function stringAttr(node: XmlNode | null, key: string): string | undefined {
  const value = node?.[key];
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
}

function numberAttr(node: XmlNode | null, key: string): number | undefined {
  const value = node?.[key];
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Collects <Layout> nodes from anywhere in the document, not only LayoutEditor. */
export function collectLayoutNodes(value: unknown, found: XmlNode[] = []): XmlNode[] {
  const node = asRecord(value);
  if (!node) return found;
  for (const layout of arrayOf(node.Layout)) {
    const layoutNode = asRecord(layout);
    if (layoutNode) found.push(layoutNode);
  }
  for (const [key, child] of Object.entries(node)) {
    if (key === "Layout") continue;
    if (Array.isArray(child)) child.forEach((entry) => collectLayoutNodes(entry, found));
    else collectLayoutNodes(child, found);
  }
  return found;
}

/** Compensation prefixes declared by the file's own spillover matrices. */
export function collectCompensationPrefixes(value: unknown, found: Map<string, string> = new Map()): Map<string, string> {
  const node = asRecord(value);
  if (!node) return found;
  for (const matrix of arrayOf(node.spilloverMatrix)) {
    const matrixNode = asRecord(matrix);
    const prefix = stringAttr(matrixNode, "prefix");
    const name = stringAttr(matrixNode, "name");
    if (prefix && !found.has(prefix)) found.set(prefix, name ?? prefix);
  }
  for (const [key, child] of Object.entries(node)) {
    if (key === "spilloverMatrix") continue;
    if (Array.isArray(child)) child.forEach((entry) => collectCompensationPrefixes(entry, found));
    else collectCompensationPrefixes(child, found);
  }
  return found;
}

const PLOT_TYPES: Record<string, LayoutPlotType> = {
  pseudocolor: "pseudocolor",
  dotplot: "dot",
  dot: "dot",
  contour: "contour",
  histogram: "histogram",
};

function plotTypeFor(graph: XmlNode | null): LayoutPlotType | undefined {
  const raw = stringAttr(graph, "type");
  return raw ? PLOT_TYPES[raw.toLowerCase().replace(/[\s_-]+/g, "")] : undefined;
}

type AxisRead =
  | {
    ok: true;
    axis: PanelAxis;
    /** A bound matrix id, when the axis named a prefix this sample defines. */
    compensationId?: string;
    /** An explicit reference that could not be bound to a matrix. */
    compensationReference?: { reference: string; detail: string };
    /** Set when this sample defines no transform for the raw axis name. */
    transformMissing?: string;
  }
  | { ok: false; reason: "unknown_parameter"; detail: string };

/**
 * Reads one <Axis> and checks it against both the XML definition and the source
 * sample's FCS parameters, compensation matrices and transforms.
 *
 * A prefix declared by a spillover matrix is an explicit compensation reference.
 * It binds only to a matrix this sample actually defines; absence of a prefix
 * records nothing, and is never a claim that the data is uncompensated.
 *
 * The transform is looked up by the RAW axis name against this sample's own
 * transforms, because FlowJo defines separate transforms for "FL03-A" and
 * "Comp-FL03-A" and they need not agree.
 */
function readAxis(
  graph: XmlNode | null,
  dimension: "x" | "y",
  sample: FlowJoLayoutSample,
  prefixes: Map<string, string>,
): AxisRead | null {
  const axisNode = arrayOf(graph?.Axis)
    .map(asRecord)
    .find((entry) => stringAttr(entry, "dimension") === dimension) ?? null;
  const rawName = stringAttr(axisNode, "name");
  if (!rawName) return null;

  let bare = rawName;
  let matchedPrefix: string | undefined;
  let matrixName: string | undefined;
  for (const [prefix, name] of prefixes) {
    if (prefix && rawName.toLowerCase().startsWith(prefix.toLowerCase())) {
      bare = rawName.slice(prefix.length);
      matchedPrefix = prefix;
      matrixName = name;
      break;
    }
  }

  const resolved = sample.resolveChannel(bare);
  const known = sample.metadata.parameters.some((parameter) => parameter.name === resolved);
  if (!known) {
    return {
      ok: false,
      reason: "unknown_parameter",
      detail: `Axis ${dimension}="${rawName}" resolves to ${resolved}, which is not a parameter of sample ${sample.sampleId}.`,
    };
  }

  let compensationId: string | undefined;
  let compensationReference: { reference: string; detail: string } | undefined;
  if (matchedPrefix) {
    const bound = sample.matricesByPrefix.get(matchedPrefix);
    if (bound && bound.compensation.channels.includes(resolved)) {
      compensationId = bound.compensation.id;
    } else {
      compensationReference = {
        reference: rawName,
        detail: bound
          ? `Axis ${rawName} references FlowJo matrix "${bound.flowjoName}" (prefix "${matchedPrefix}") for sample ${sample.sampleId}, but ${resolved} is not one of that matrix's channels (${bound.compensation.channels.join(", ")}), so the compensation state is unknown.`
          : `Axis ${rawName} references FlowJo compensation matrix "${matrixName ?? matchedPrefix}" (prefix "${matchedPrefix}"), but sample ${sample.sampleId} defines no matrix with that prefix, so the compensation state is unknown.`,
      };
    }
  }

  const transform = sample.transforms.get(rawName);
  // The divisor belongs to the cytometer, but which of its two factors applies
  // is decided by this axis' scale, exactly as gate-coordinate conversion does.
  const divisor = transform
    ? (transform.scale === "linear" ? sample.rescale.linear : sample.rescale.log)
    : 1;
  const axis: PanelAxis = {
    channel: resolved,
    ...(transform ? { scale: transform.scale } : {}),
    ...(transform?.params ? { transform: transform.params } : {}),
    ...(Number.isFinite(divisor) && divisor > 0 && divisor !== 1 ? { inputDivisor: divisor } : {}),
  };
  return {
    ok: true,
    axis,
    ...(compensationId ? { compensationId } : {}),
    ...(compensationReference ? { compensationReference } : {}),
    ...(transform ? {} : { transformMissing: rawName }),
  };
}

/** ChartData attributes Flowcyto models itself; everything else is preserved. */
const MODELLED_CHART_ATTRS = new Set(["x", "y", "width", "height"]);

function preservedChartAttrs(chart: XmlNode): Record<string, unknown> {
  const preserved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(chart)) {
    if (MODELLED_CHART_ATTRS.has(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      preserved[key] = value;
    }
  }
  return preserved;
}

function showFlags(chart: XmlNode): LayoutPanel["show"] {
  const flag = (key: string) => stringAttr(chart, key) === "1";
  return {
    sampleName: flag("showSampleName"),
    populationName: flag("showPopulationName"),
    count: flag("showCount"),
    freq: flag("showFreq"),
  };
}

type SourceRead =
  | { ok: true; source: LayoutPanelSource }
  | { ok: false; status: PanelStatus };

function readSource(
  layer: XmlNode,
  input: FlowJoLayoutImportInput,
  compensation: { id?: string; unresolved?: { reference: string; detail: string } },
): SourceRead {
  const flowjoSampleId = stringAttr(layer, "sampleID") ?? "";
  const sample = input.samplesByFlowJoId.get(flowjoSampleId);
  if (!sample) {
    const inGroup = input.groupReferencedSampleIds.has(flowjoSampleId);
    return {
      ok: false,
      status: {
        state: "unresolved",
        reason: "unknown_sample",
        detail: inGroup
          ? `FlowJo sampleID=${flowjoSampleId} is referenced by a group (SampleRef) but has no SampleNode, so the sample definition is absent from this workspace.`
          : `FlowJo sampleID=${flowjoSampleId} has no SampleNode and no group SampleRef; the layout reference cannot be bound.`,
      },
    };
  }

  const populationPath = stringAttr(layer, "path") ?? "";
  const resolution = namePathToGateId(input.workspace, sample.sampleId, populationPath);
  if (resolution.status === "unknown_sample") {
    return {
      ok: false,
      status: {
        state: "unresolved",
        reason: "unknown_sample",
        detail: `Sample ${sample.sampleId} was loaded from the .wsp but is absent from the workspace being built.`,
      },
    };
  }
  if (resolution.status !== "resolved") {
    const where = `at segment "${resolution.atSegment}" (depth ${resolution.depth})`;
    const detail = `FlowJo population path "${populationPath}" in sample ${sample.sampleId}: ${resolution.status} ${where}.`;
    if (resolution.status === "ambiguous") {
      return {
        ok: false,
        status: {
          state: "unresolved", reason: "ambiguous_path", candidates: resolution.candidates, detail,
        },
      };
    }
    return {
      ok: false,
      status: {
        state: "unresolved",
        reason: resolution.status === "unsupported_name" ? "unsupported_name" : "unknown_path",
        detail,
      },
    };
  }

  const legendColor = stringAttr(asRecord(layer.LegendSpec), "color");
  return {
    ok: true,
    source: {
      sample: sample.sampleId,
      parent: resolution.gateId,
      // Importing a reference is not permission to apply it: a renderer still has
      // to pass the id explicitly, exactly as for any other compensation.
      ...(compensation.id ? { compensationId: compensation.id } : {}),
      ...(compensation.unresolved ? { unresolvedCompensation: compensation.unresolved } : {}),
      ...(legendColor ? { legend: { color: legendColor } } : {}),
    },
  };
}

function unsupportedFeature(chart: XmlNode, layoutNode: XmlNode): string | null {
  const multigraph = asRecord(chart.Multigraph);
  const rows = numberAttr(multigraph, "rows") ?? 0;
  const columns = numberAttr(multigraph, "columns") ?? 0;
  if (rows > 0 || columns > 0) {
    return `Multigraph grid expansion (rows=${rows}, columns=${columns}) is not modelled.`;
  }
  if (stringAttr(asRecord(chart.Ancestry), "backgating") === "1") {
    return "Ancestry backgating overlay is not modelled.";
  }
  const iteration = stringAttr(asRecord(layoutNode.Iteration), "iterationType");
  if (iteration && iteration !== "OFF") {
    return `Layout Iteration mode ${iteration} is not modelled; only materialised panels are imported.`;
  }
  return null;
}

/**
 * Classifies on the FlowJo population path rather than the resolved gate id: the
 * same path resolves to a different gate id in every sample, so a comparison
 * layout would otherwise look like unrelated populations.
 */
function classifyKind(resolved: Array<{ samples: string[]; paths: string[] }>): FlowcytoLayout["kind"] {
  if (resolved.length < 2) return "freeform";
  const samples = new Set(resolved.flatMap((entry) => entry.samples));
  const paths = new Set(resolved.flatMap((entry) => entry.paths));
  if (samples.size === 1 && paths.size === resolved.length) return "gating_strategy";
  if (samples.size > 1 && paths.size === 1) return "comparison";
  return "freeform";
}

export function importFlowJoLayouts(input: FlowJoLayoutImportInput): FlowJoLayoutImportResult {
  const layoutNodes = collectLayoutNodes(input.workspaceXml);
  const prefixes = collectCompensationPrefixes(input.workspaceXml);
  const warnings: string[] = [];
  const layouts: FlowcytoLayout[] = [];
  const unresolvedByReason: Record<string, number> = {};
  const blockedByReason: Record<string, number> = {};
  let panelsTotal = 0;
  let panelsResolved = 0;
  let panelsPartial = 0;
  let unresolvedCompensation = 0;
  let resolvedCompensation = 0;
  let absentCompensation = 0;

  layoutNodes.forEach((layoutNode, layoutIndex) => {
    const name = stringAttr(layoutNode, "name") ?? `Layout ${layoutIndex + 1}`;
    const print = asRecord(layoutNode.PrintLayout);
    const panels: LayoutPanel[] = [];
    const resolvedDescriptors: Array<{ samples: string[]; paths: string[] }> = [];

    arrayOf(asRecord(layoutNode.FigList)?.ChartData).forEach((entry, chartIndex) => {
      const chart = asRecord(entry);
      if (!chart) return;
      panelsTotal += 1;
      const panelId = `${name}_panel_${chartIndex + 1}`.replace(/[^A-Za-z0-9._-]+/g, "_");
      const graph = asRecord(chart.Graph);
      const preserved = {
        ChartData: preservedChartAttrs(chart),
        ...(graph ? { Graph: graph } : {}),
        ...(chart.PopModelList ? { PopModelList: chart.PopModelList } : {}),
      };
      // ChartData width/height are not reliable: in the comparison layout of the
      // reference workspace they are 0 and the real size lives only on the panel's
      // own direct-child WindowPosition. Nested WindowPosition elements belong to
      // Ancestry/Multigraph and are not reachable through this key. No default size
      // is invented; a panel with no usable geometry is reported instead.
      const window = asRecord(chart.WindowPosition);
      const positive = (value: number | undefined) => (value !== undefined && value > 0 ? value : undefined);
      const width = positive(numberAttr(chart, "width")) ?? positive(numberAttr(window, "width"));
      const height = positive(numberAttr(chart, "height")) ?? positive(numberAttr(window, "height"));
      const position = {
        x: numberAttr(chart, "x") ?? numberAttr(window, "x") ?? 0,
        y: numberAttr(chart, "y") ?? numberAttr(window, "y") ?? 0,
        width: width ?? 0,
        height: height ?? 0,
      };
      const base = {
        id: panelId,
        position,
        show: showFlags(chart),
        _flowjo: preserved,
      };
      const unresolve = (status: PanelStatus): void => {
        panels.push({ ...base, sources: [], x: { channel: "" }, status });
        if (status.state === "unresolved") {
          unresolvedByReason[status.reason] = (unresolvedByReason[status.reason] ?? 0) + 1;
          warnings.push(`Layout "${name}" panel ${panelId}: ${status.detail}`);
        }
      };

      if (width === undefined || height === undefined) {
        unresolve({
          state: "unresolved",
          reason: "unsupported_feature",
          detail: "Panel geometry is absent from both ChartData and its WindowPosition, so no size could be read without inventing one.",
        });
        return;
      }

      const unsupported = unsupportedFeature(chart, layoutNode);
      if (unsupported) {
        unresolve({ state: "unresolved", reason: "unsupported_feature", detail: unsupported });
        return;
      }

      const layers = arrayOf(asRecord(chart.PopModelList)?.DataLayer).map(asRecord)
        .filter((layer): layer is XmlNode => layer !== null);
      if (layers.length === 0) {
        unresolve({ state: "unresolved", reason: "unknown_sample", detail: "Panel has no DataLayer, so no sample or population is referenced." });
        return;
      }

      // Axes are read against the first bindable sample, since FlowJo stores one
      // Graph per panel and every layer shares it.
      const firstBindable = layers
        .map((layer) => input.samplesByFlowJoId.get(stringAttr(layer, "sampleID") ?? ""))
        .find((sample): sample is FlowJoLayoutSample => sample !== undefined);
      if (!firstBindable) {
        const read = readSource(layers[0], input, {});
        unresolve(read.ok
          ? { state: "unresolved", reason: "unknown_sample", detail: "No DataLayer references a loaded sample." }
          : read.status);
        return;
      }

      const xRead = readAxis(graph, "x", firstBindable, prefixes);
      const yRead = readAxis(graph, "y", firstBindable, prefixes);
      if (xRead && !xRead.ok) {
        unresolve({ state: "unresolved", reason: "unknown_parameter", detail: xRead.detail });
        return;
      }
      if (yRead && !yRead.ok) {
        unresolve({ state: "unresolved", reason: "unknown_parameter", detail: yRead.detail });
        return;
      }
      if (!xRead) {
        unresolve({ state: "unresolved", reason: "unknown_parameter", detail: "Panel Graph defines no x Axis." });
        return;
      }

      const axisReads = [xRead, ...(yRead?.ok ? [yRead] : [])];
      const references = axisReads
        .map((read) => read.compensationReference)
        .filter((entry): entry is { reference: string; detail: string } => entry !== undefined);
      const boundIds = [...new Set(axisReads.map((read) => read.compensationId).filter(Boolean))] as string[];
      unresolvedCompensation += references.length;
      absentCompensation += axisReads
        .filter((read) => !read.compensationReference && !read.compensationId).length;
      resolvedCompensation += axisReads.filter((read) => read.compensationId).length;

      const blockers: PanelBlocker[] = references.map((entry) => ({
        reason: "unresolved_compensation" as const,
        detail: entry.detail,
      }));
      if (boundIds.length > 1) {
        blockers.push({
          reason: "unresolved_compensation",
          detail: `Panel axes bind to different compensation matrices (${boundIds.join(", ")}), so no single compensation state applies to this panel.`,
        });
      }
      for (const read of axisReads) {
        if (!read.transformMissing) continue;
        blockers.push({
          reason: "unresolved_transform",
          detail: `Sample ${firstBindable.sampleId} defines no transform for "${read.transformMissing}", so the axis scale and its parameters are unknown.`,
        });
      }

      const compensation = {
        ...(boundIds.length === 1 ? { id: boundIds[0] } : {}),
        ...(references[0] ? { unresolved: references[0] } : {}),
      };
      const sources: LayoutPanelSource[] = [];
      let failure: PanelStatus | null = null;
      for (const layer of layers) {
        const read = readSource(layer, input, compensation);
        if (read.ok) sources.push(read.source);
        else if (!failure) failure = read.status;
      }
      if (failure || sources.length === 0) {
        unresolve(failure ?? { state: "unresolved", reason: "unknown_sample", detail: "No DataLayer could be bound." });
        return;
      }

      // Binding a sample and a population is not enough to draw the data: a panel
      // with an unbound compensation reference or an unknown transform is kept as
      // partial so a renderer shows a labelled placeholder instead of a plot.
      const status: PanelStatus = blockers.length > 0
        ? { state: "partial", blockers }
        : { state: "resolved" };
      if (blockers.length > 0) {
        for (const blocker of blockers) {
          blockedByReason[blocker.reason] = (blockedByReason[blocker.reason] ?? 0) + 1;
        }
        warnings.push(`Layout "${name}" panel ${panelId}: ${blockers.map((entry) => entry.detail).join(" ")}`);
      }

      const plotType = plotTypeFor(graph);
      panels.push({
        ...base,
        sources,
        x: xRead.axis,
        ...(yRead?.ok && plotType !== "histogram" ? { y: yRead.axis } : {}),
        ...(plotType ? { plotType } : {}),
        status,
      });
      if (status.state === "partial") panelsPartial += 1;
      else panelsResolved += 1;
      // Partial panels are bound, so they still inform layout classification.
      resolvedDescriptors.push({
        samples: sources.map((source) => source.sample),
        paths: layers.map((layer) => stringAttr(layer, "path") ?? ""),
      });
    });

    layouts.push({
      id: `flowjo_layout_${layoutIndex + 1}_${name}`.replace(/[^A-Za-z0-9._-]+/g, "_"),
      name,
      kind: classifyKind(resolvedDescriptors),
      canvas: {
        width: numberAttr(print, "width") ?? 612,
        height: numberAttr(print, "height") ?? 792,
      },
      panels,
      source: "flowjo_wsp",
      _flowjo: {
        Layout: Object.fromEntries(Object.entries(layoutNode)
          .filter(([, value]) => typeof value === "string" || typeof value === "number")),
        ...(print ? { PrintLayout: print } : {}),
      },
    });
  });

  return {
    layouts,
    warnings,
    panelsTotal,
    panelsResolved,
    panelsPartial,
    panelsUnresolved: panelsTotal - panelsResolved - panelsPartial,
    unresolvedByReason,
    blockedByReason,
    compensationReferences: {
      resolved: resolvedCompensation,
      unresolved: unresolvedCompensation,
      absent: absentCompensation,
    },
  };
}
