import { describe, expect, it } from "vitest";
import { gateIdToNamePath, namePathToGateId } from "../src/core/gate-path.js";
import type { FlowcytoWorkspace, WorkspaceGate } from "../src/core/types.js";

const gate = (id: string, name: string | undefined, parent = "root", sample = "a"): WorkspaceGate =>
  ({ id, name, parent, sample, type: "range", x: "X", min: 0, max: 1 });
const workspace = (gates: WorkspaceGate[]): FlowcytoWorkspace => ({
  version: 1, revision: 0, samples: [{ id: "a", path: "a.fcs" }, { id: "b", path: "b.fcs" }], views: [], gates,
});

describe("sample-scoped gate paths", () => {
  it("round-trips root and repeated names at different depths without crossing samples", () => {
    const w = workspace([gate("a1", "Single Cells"), gate("a2", "Single Cells", "a1"), gate("b1", "Single Cells", "root", "b")]);
    for (const [id, path] of [["root", ""], ["a1", "Single Cells"], ["a2", "Single Cells/Single Cells"]]) {
      expect(gateIdToNamePath(w, "a", id)).toEqual({ status: "ok", path });
      expect(namePathToGateId(w, "a", path)).toEqual({ status: "resolved", gateId: id });
    }
    expect(gateIdToNamePath(w, "b", "a1")).toEqual({ status: "unknown_gate", gateId: "a1" });
  });
  it("rejects ambiguous sibling names in both directions", () => {
    const w = workspace([gate("a1", "Cells"), gate("a2", "Cells")]);
    const error = { status: "ambiguous", candidates: ["a1", "a2"], atSegment: "Cells", depth: 0 };
    expect(namePathToGateId(w, "a", "Cells")).toEqual(error);
    expect(gateIdToNamePath(w, "a", "a1")).toEqual(error);
  });
  it("rejects slash-containing names even when they collide with valid nested paths", () => {
    const w = workspace([gate("a1", "A"), gate("a2", "B", "a1"), gate("slash", "A/B")]);
    expect(namePathToGateId(w, "a", "A/B").status).toBe("unsupported_name");
    expect(gateIdToNamePath(w, "a", "slash").status).toBe("unsupported_name");
    expect(gateIdToNamePath(w, "a", "a2").status).toBe("unsupported_name");
  });
  it("returns typed errors for unknown samples, missing paths, orphan parents and cycles", () => {
    const w = workspace([gate("orphan", "Orphan", "missing"), gate("cycle", "Cycle", "cycle")]);
    expect(namePathToGateId(w, "unknown", "").status).toBe("unknown_sample");
    expect(gateIdToNamePath(w, "unknown", "root").status).toBe("unknown_sample");
    expect(namePathToGateId(w, "a", "Missing")).toEqual({ status: "not_found", atSegment: "Missing", depth: 0 });
    expect(gateIdToNamePath(w, "a", "orphan")).toEqual({ status: "unknown_gate", gateId: "missing" });
    expect(gateIdToNamePath(w, "a", "cycle").status).toBe("cycle");
  });
  it("uses IDs only for absent names and rejects empty names", () => {
    const w = workspace([gate("id", undefined), gate("empty", "")]);
    expect(namePathToGateId(w, "a", "id")).toEqual({ status: "resolved", gateId: "id" });
    expect(gateIdToNamePath(w, "a", "empty").status).toBe("unsupported_name");
  });
  it("resolves quadrant populations at the parent level, not the quadrant container", () => {
    const w = workspace([{
      id: "quadrants", name: "Quadrants", sample: "a", parent: "root", type: "quadrant",
      x: "X", y: "Y", xThreshold: 1, yThreshold: 1,
      quadrants: [{ id: "positive", name: "Positive", x: "+", y: "+" }],
    }, gate("child", "Child", "positive")]);
    expect(namePathToGateId(w, "a", "Positive/Child")).toEqual({ status: "resolved", gateId: "child" });
    expect(gateIdToNamePath(w, "a", "child")).toEqual({ status: "ok", path: "Positive/Child" });
    expect(namePathToGateId(w, "a", "Quadrants").status).toBe("not_found");
  });
});
