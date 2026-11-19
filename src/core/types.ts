export type AxisScale = "linear" | "log" | "arcsinh" | "biex";

export type FlowcytoSample = {
  id: string;
  path: string;
};

export type CompensationKeyword = "$SPILLOVER" | "SPILLOVER" | "$COMP" | "COMP" | "$SPILL" | "SPILL";

export type CompensationMatrix = {
  id: string;
  name?: string;
  source: "fcs_keyword" | "controls" | "manual";
  sample?: string;
  keyword?: CompensationKeyword;
  channels: string[];
  // matrix[i][j] = fraction of fluorochrome i's signal appearing in detector j.
  // Row = source fluorochrome, column = destination detector. This matches the FCS
  // $SPILLOVER/SPILL keyword layout and flowCore's spillover() output, so matrices
  // from embedded keywords and from single-stain controls are directly comparable.
  // Apply as Xcomp = Xraw * inv(S), implemented as solve(S.T, Xraw.T).T.
  // Verified against numpy in testdata/fixtures/compensation-reference.json; see
  // docs/compensation-numeric-validation-2026-09-04.md for the worked example.
  matrix: number[][];
};

export type CompensationStatus = {
  detectedAsPreCompensated: boolean;
  signals: string[];
  embeddedMatrixFound: boolean;
  suggestedCompensationId?: string;
  recommendation: string;
};

export type CompensationDiagnostics = {
  keywordsScanned: CompensationKeyword[];
  keywordsFound: string[];
  unparsedKeywordCandidates: string[];
  availableChannels: string[];
  matrixChannels?: string[];
  alignmentWarnings?: string[];
};

export type AppliedCompensation = {
  applied: boolean;
  id?: string;
  source?: CompensationMatrix["source"];
  channels?: string[];
  warnings?: string[];
};

export type FlowcytoView = {
  id: string;
  sample: string;
  parent: string;
  x: string;
  y: string;
  scale: {
    x: AxisScale;
    y: AxisScale;
  };
};

export type GateBase = {
  id: string;
  name?: string;
  sample: string;
  parent: string;
  enabled?: boolean;
};

export type PolygonGate = GateBase & {
  type: "polygon";
  x: string;
  y: string;
  vertices: Array<[number, number]>;
};

export type RectGate = GateBase & {
  type: "rect";
  x: string;
  y: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
};

export type RangeGate = GateBase & {
  type: "range";
  x: string;
  min: number;
  max: number;
};

export type QuadrantSign = "-" | "+";

export type QuadrantPopulation = {
  id: string;
  name?: string;
  x: QuadrantSign;
  y: QuadrantSign;
};

export type QuadrantGate = GateBase & {
  type: "quadrant";
  x: string;
  y: string;
  xThreshold: number;
  yThreshold: number;
  quadrants: QuadrantPopulation[];
};

export type QuadrantRegionGate = GateBase & {
  type: "quadrant_region";
  quadrantGateId: string;
  x: string;
  y: string;
  xThreshold: number;
  yThreshold: number;
  xSign: QuadrantSign;
  ySign: QuadrantSign;
};

export type WorkspaceGate = PolygonGate | RectGate | RangeGate | QuadrantGate;
export type EvaluableGate = PolygonGate | RectGate | RangeGate | QuadrantRegionGate;

// Explicit axis range in data space. Scale type alone does not make two panels
// comparable, so panels carry bounds and may share them through an AxisBoundsGroup.
export type AxisBounds = {
  min: number;
  max: number;
};

// Parameters for a parameterized scale. A matching AxisScale name is not enough:
// two "biex" axes with different parameters are different transforms, so axes
// joining a bounds group under biex or arcsinh must state these and agree.
export type AxisTransformParams = {
  cofactor?: number;                 // arcsinh
  maxRange?: number;                 // biex
  pos?: number;
  neg?: number;
  width?: number;
  length?: number;
};

export type PanelAxis = {
  channel: string;
  scale?: AxisScale;
  transform?: AxisTransformParams;
  bounds?: AxisBounds;
  // Id of an AxisBoundsGroup on the owning layout. The group supplies the bounds
  // and constrains every member to one parameter and one transform. Channel
  // identity is checked against FCS metadata, so a detector name and its marker
  // alias for the same parameter may share a group.
  boundsGroup?: string;
};

// A panel may plot several sources at once (overlay). Comparison layouts instead
// use one source per panel across several panels; both are the same primitive.
export type LayoutPanelSource = {
  sample: string;
  // Population plotted: a gate id, a quadrant population id, or "root".
  parent: string;
  // Optional child gate drawn on top of that population.
  gate?: string;
  // Compensation is per source, not per panel: overlaid samples can carry
  // different sample-specific matrices. Nothing is applied without an explicit id.
  compensationId?: string;
  // An explicit compensation reference found in an imported file that could not be
  // bound to a workspace matrix. Its presence means the compensation state is
  // UNKNOWN, which is not the same as uncompensated, so a renderer must not draw
  // this source as raw data. Absence of both fields means no reference was found,
  // which is also not a claim that the data is uncompensated.
  unresolvedCompensation?: { reference: string; detail: string };
  legend?: { color?: string; label?: string };
};

export type PanelUnresolvedReason =
  | "ambiguous_path"
  | "unknown_path"
  | "unknown_sample"
  | "unknown_parameter"
  | "unsupported_name"
  | "unsupported_feature";

// A panel that cannot be bound stays in the layout and stays visibly unresolved.
// Nothing is dropped silently, so a partial import reports as partial.
export type PanelStatus =
  | { state: "resolved" }
  | {
    state: "unresolved";
    reason: PanelUnresolvedReason;
    detail: string;
    candidates?: string[];
  };

export type LayoutPlotType = "pseudocolor" | "dot" | "contour" | "histogram";

export type LayoutPanelPosition = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type LayoutPanel = {
  id: string;
  // An unresolved panel carries no sources: a source needs a known sample and a
  // known population, and inventing either would be a plausible substitute for
  // evidence. The original reference is kept verbatim in _flowjo and summarized
  // in status.detail.
  sources: LayoutPanelSource[];
  x: PanelAxis;
  // Omit for a histogram.
  y?: PanelAxis;
  plotType?: LayoutPlotType;
  position: LayoutPanelPosition;
  title?: string;
  show?: {
    sampleName?: boolean;
    populationName?: boolean;
    count?: boolean;
    freq?: boolean;
  };
  status: PanelStatus;
  // Presentation-only state preserved from an imported file. Never a source of
  // truth: live sample mappings, population references, axes and geometry always
  // override it on export.
  _flowjo?: Record<string, unknown>;
};

export type AxisBoundsGroup = {
  id: string;
  // Every member axis must resolve, in its own sample's FCS metadata, to the same
  // parameter this channel resolves to, and must use this scale and transform.
  channel: string;
  scale: AxisScale;
  transform?: AxisTransformParams;
  bounds: AxisBounds;
};

export type LayoutKind = "gating_strategy" | "comparison" | "freeform";

export type FlowcytoLayout = {
  id: string;
  name: string;
  kind: LayoutKind;
  canvas: { width: number; height: number };
  panels: LayoutPanel[];
  boundsGroups?: AxisBoundsGroup[];
  source?: "generated" | "flowjo_wsp" | "manual";
  _flowjo?: Record<string, unknown>;
};

export type FlowcytoWorkspace = {
  version: 1;
  revision: number;
  samples: FlowcytoSample[];
  views: FlowcytoView[];
  gates: WorkspaceGate[];
  compensations?: CompensationMatrix[];
  compensationStatus?: Record<string, CompensationStatus>;
  layouts?: FlowcytoLayout[];
};

export type ValidationError = {
  path: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type ValidationResult = {
  ok: boolean;
  errors: ValidationError[];
};

export type WorkspaceSummary = {
  workspacePath: string;
  rootDir: string;
  sampleCount: number;
  gateCount: number;
  viewCount: number;
  samples: FlowcytoSample[];
};

export type SampleParameter = {
  name: string;
  index: number;
  detector?: string;
  marker?: string;
  range?: number;
};

export type SampleMetadata = {
  sampleId: string;
  path: string;
  eventCount: number | null;
  parameters: SampleParameter[];
  keywords: Record<string, string>;
};

export type PreviewColumns = {
  x: Float32Array | Float64Array;
  y: Float32Array | Float64Array;
  totalEvents: number;
  filteredEvents: number;
  compensation?: AppliedCompensation;
};

export type FcsColumns = {
  channels: string[];
  values: number[][];
  totalEvents: number;
  sampledEvents: number;
};

export type PreviewFormat = "auto" | "points" | "bins";

export type EventPreview = {
  sampleId: string;
  x: string;
  y: string;
  parent: string;
  format: "points" | "bins";
  scale: { x: AxisScale; y: AxisScale };
  totalEvents: number;
  filteredEvents: number;
  sampledEvents: number;
  compensation?: AppliedCompensation;
  points?: Array<[number, number]>;
  bins?: {
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
    width: number;
    height: number;
    counts: number[];
  };
};

export class FlowcytoError extends Error {
  readonly code: string;
  readonly path?: string;

  constructor(code: string, message: string, path?: string) {
    super(message);
    this.name = "FlowcytoError";
    this.code = code;
    this.path = path;
  }
}
