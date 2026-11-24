import type { FlowcytoWorkspace } from "./types.js";

export type PathResolution =
  | { status: "resolved"; gateId: string }
  | { status: "unknown_sample"; sampleId: string }
  | { status: "ambiguous"; candidates: string[]; atSegment: string; depth: number }
  | { status: "not_found" | "unsupported_name"; atSegment: string; depth: number };

export type PathEncoding =
  | { status: "ok"; path: string }
  | { status: "unknown_sample"; sampleId: string }
  | { status: "unknown_gate" | "cycle"; gateId: string }
  | { status: "unsupported_name"; gateId: string; name: string }
  | { status: "ambiguous"; candidates: string[]; atSegment: string; depth: number };

function populations(workspace: FlowcytoWorkspace, sampleId: string) {
  return workspace.gates.filter((gate) => gate.sample === sampleId).flatMap((gate) =>
    gate.type === "quadrant"
      ? gate.quadrants.map((population) => ({
        id: population.id, name: population.name ?? population.id, parent: gate.parent,
      }))
      : [{ id: gate.id, name: gate.name ?? gate.id, parent: gate.parent }]);
}

export function namePathToGateId(
  workspace: FlowcytoWorkspace, sampleId: string, path: string,
): PathResolution {
  if (!workspace.samples.some((sample) => sample.id === sampleId)) return { status: "unknown_sample", sampleId };
  if (path === "") return { status: "resolved", gateId: "root" };
  const nodes = populations(workspace, sampleId);
  const segments = path.split("/");
  let parent = "root";
  for (let depth = 0; depth < segments.length; depth += 1) {
    const atSegment = segments[depth];
    const children = nodes.filter((node) => node.parent === parent);
    const remaining = segments.slice(depth).join("/");
    // A slash-containing sibling can collide with a valid nested path. Do not guess.
    if (children.some((node) => node.name.includes("/") &&
      (remaining === node.name || remaining.startsWith(`${node.name}/`)))) {
      return { status: "unsupported_name", atSegment, depth };
    }
    const matches = children.filter((node) => node.name === atSegment && node.name !== "");
    if (matches.length === 0) return { status: "not_found", atSegment, depth };
    if (matches.length > 1) return { status: "ambiguous", candidates: matches.map((node) => node.id), atSegment, depth };
    parent = matches[0].id;
  }
  return { status: "resolved", gateId: parent };
}

export function gateIdToNamePath(
  workspace: FlowcytoWorkspace, sampleId: string, gateId: string,
): PathEncoding {
  if (!workspace.samples.some((sample) => sample.id === sampleId)) return { status: "unknown_sample", sampleId };
  const nodes = populations(workspace, sampleId);
  const segments: string[] = [];
  const visited = new Set<string>();
  let current = gateId;
  while (current !== "root") {
    if (visited.has(current)) return { status: "cycle", gateId: current };
    visited.add(current);
    const node = nodes.find((entry) => entry.id === current);
    if (!node) return { status: "unknown_gate", gateId: current };
    if (node.name === "" || node.name.includes("/")) return { status: "unsupported_name", gateId: current, name: node.name };
    segments.unshift(node.name);
    current = node.parent;
  }
  const path = segments.join("/");
  const resolution = namePathToGateId(workspace, sampleId, path);
  if (resolution.status === "ambiguous") return resolution;
  if (resolution.status === "unsupported_name") return { status: "unsupported_name", gateId, name: path };
  return { status: "ok", path };
}
