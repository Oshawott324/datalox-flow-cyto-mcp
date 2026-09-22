#!/usr/bin/env node
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  estimateCompensationFromControls,
  getPopulationTable,
  openFcsArtifact,
  propagateGates,
  readWorkspace,
  suggestApoptosisQuadrants,
  upsertCompensationMatrix,
  upsertGate,
  validateWorkspace,
} from "../dist/src/core/index.js";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const defaultDataDir = String.raw`C:\Users\fangxf\Research Tools\Flow data\7_Apoptosis_cwq`;
const defaultWorkspaceRoot = path.join(repoRoot, ".tmp", "flowcyto-apoptosis-demo-runs");

const sampleFiles = [
  ["compensation_bl1", "Apoptosis-DC2.4_Compensation_BL1-A.fcs"],
  ["compensation_bl3", "Apoptosis-DC2.4_Compensation_BL3-A.fcs"],
  ["unstain", "Apoptosis-DC2.4_Group_unstain.fcs"],
  ["positive", "Apoptosis-DC2.4_Group_positive.fcs"],
  ["group_1", "Apoptosis-DC2.4_Group_1.fcs"],
  ["group_2", "Apoptosis-DC2.4_Group_2.fcs"],
  ["group_3", "Apoptosis-DC2.4_Group_3.fcs"],
  ["group_5", "Apoptosis-DC2.4_Group_5.fcs"],
  ["group_6", "Apoptosis-DC2.4_Group_6.fcs"],
];

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(`Demo validation failed: ${message}`);
}

function spilloverCoefficient(compensation, sourceIndex, destinationIndex) {
  return compensation?.matrix?.[sourceIndex]?.[destinationIndex];
}

function timestampSlug(date = new Date()) {
  const component = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    component(date.getMonth() + 1),
    component(date.getDate()),
    "_",
    component(date.getHours()),
    component(date.getMinutes()),
    component(date.getSeconds()),
    "_",
    String(date.getMilliseconds()).padStart(3, "0"),
  ].join("");
}

function relativeForWorkspace(workspaceDir, filePath) {
  const relative = path.relative(workspaceDir, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : path.resolve(filePath);
}

function focusedPromptText({ workspacePath, dataDir }) {
  const treatmentSamples = ["group_1", "group_2", "group_3", "group_5", "group_6", "positive"];
  return `Use Flowcyto MCP to run an apoptosis demo from this prepared workspace:

${workspacePath}

This is a focused compensation-and-quadrant demo of an AI agent operating a stateful scientific tool. Inspect real FCS data, derive compensation from controls, propose a reviewed apoptosis gate, propagate it across samples, and return auditable population statistics. Keep the narration concise enough for a broad AI audience, but use the correct cytometry terms. State clearly that this focused take applies the quadrant at the root population; a full biological analysis should first establish the intended morphology and singlet parent populations.

Follow the Flowcyto MCP contract exactly:

1. Use the prepared workspace directly. Do not call open_fcs again. During compensation, inspection, and gate proposal, use render_plot_image/render_plot only and do not open a gate editor.
2. Estimate compensation from the single-stain controls using:
   - compensation_bl1 for Annexin X-FITC-A
   - compensation_bl3 for PI-PerCP-Cy5.5-A
   - unstain as the negative reference
   - event_selection: { type: "primary_channel_top_percentile", percentile: 90 }
   Compare the derived Annexin-to-PI spillover coefficient with the embedded group_1 matrix. Show the values and ask before saving the derived matrix.
3. After approval, save the matrix as derived_single_stain and use that compensation_id for every subsequent render, suggestion, and population call.
4. Inspect FSC-A vs SSC-A for ${treatmentSamples.join(", ")} using render_plot_image only. Flag morphology outliers and anomalous event counts without treating acquired event count as cell recovery.
5. Render compensated Annexin X-FITC-A vs PI-PerCP-Cy5.5-A for group_1 and confirm whether a prominent residual diagonal remains.
6. Call suggest_apoptosis_quadrants with:
   - sample_id: group_1
   - annexin_channel: Annexin X-FITC-A
   - death_channel: PI-PerCP-Cy5.5-A
   - negative_control.sample_id: unstain
   - negative_percentile: 99
   - compensation_id: derived_single_stain
   This returns one coupled quadrant gate with four named populations.
7. Show the thresholds and preliminary quadrant percentages. Ask once: "Approve this coupled quadrant gate to write and propagate?"
8. After approval, call upsert_gate with the returned nextAction arguments. Propagate the single quadrant gate id to group_2, group_3, group_5, group_6, and positive.
9. Open exactly one gate editor with reuse_session=true on group_1, parent root, Annexin X-FITC-A vs PI-PerCP-Cy5.5-A. Keep the coupled quadrant cross visible. The center moves both thresholds; each arm adjusts one threshold. Any edit is one gate and one save.
10. Run get_population_table with sample_ids ${treatmentSamples.join(", ")}, column_key="name_path", and compensation_id="derived_single_stain".
11. Summarize the final table as Sample | Viable | Early apoptotic | Late apoptotic/dead | Membrane damaged. Note whether positive shows the expected apoptosis phenotype.
12. Close by explaining that the agent used controlled tools, revision-safe writes, one human approval for the gate, coupled geometry, propagation, and replayable population evidence.

Do not infer channels or controls from filenames. Use the explicit channels and sample IDs above.

Local data folder, for reference only:
${dataDir}
`;
}

function fullWorkflowPromptText({ workspacePath, dataDir }) {
  const allAnalysisSamples = ["group_1", "group_2", "group_3", "group_5", "group_6", "positive", "unstain"];
  return `Use Flowcyto MCP to rehearse a full apoptosis hierarchy from this fresh prepared workspace:

${workspacePath}

The launcher created a new timestamped workspace for this attempt. Do not open the source FCS files into another workspace and do not reuse gates from another run. Use the explicit sample IDs and channels below; never infer controls or identities from filenames.

Experiment contract:
- Annexin channel: Annexin X-FITC-A
- PI channel: PI-PerCP-Cy5.5-A
- Negative threshold control: unstain
- Positive apoptosis control: positive
- Representative gate-proposal sample: group_1
- Single-stain controls: compensation_bl1 for Annexin and compensation_bl3 for PI
- Derived compensation ID: derived_single_stain

Live editor policy:
- During compensation, inspection, and read-only proposals, use render_plot_image/render_plot only.
- Open at most one native gate editor after gates have been written.
- Keep the editor on the compensated Annexin/PI quadrant view unless I ask to inspect an upstream gate.

Phase 0 — derive compensation:
1. Estimate compensation from compensation_bl1 and compensation_bl3 with unstain as the negative reference. Use event_selection { type: "primary_channel_top_percentile", percentile: 90 } immediately; do not run an unfiltered estimate first.
2. Show the derived Annexin-to-PI spillover coefficient beside the embedded group_1 value. Do not apply the embedded matrix.
3. Ask before saving. After approval, save the reviewed matrix as derived_single_stain and pass that compensation_id to every subsequent render, apoptosis suggestion, editor, and population call.

Phase 1 — inspect all samples without opening an editor:
1. Render FSC-A vs SSC-A for ${allAnalysisSamples.join(", ")} with matched bounds where supported.
2. Flag morphology outliers and anomalous acquired event counts. Do not describe acquired event count as cell recovery.
3. Render group_1 Annexin vs PI both uncompensated and with derived_single_stain. State whether compensation reduces the diagonal pattern.

Phase 2 — establish the upstream Group 1 hierarchy:
1. Render group_1 FSC-A vs SSC-A and propose a conservative non-debris main-cell polygon. Preserve lower-FSC apoptotic cells; do not turn this into a live-cell gate. There is currently no dedicated main-cell suggestion tool, so label the geometry as agent-proposed from plot context and show its coordinates before asking approval.
2. After approval, write the main-cell gate, then report its exact retained percentage from the stored workspace.
3. Call suggest_singlet_gate for group_1 on FSC-A vs FSC-H with the stored main-cell gate as parent. Show the polygon and proposed retained percentage, ask approval, then write it.
4. Propagate only the reviewed main-cell and singlet gates to group_2, group_3, group_5, group_6, positive, and unstain. Include both source gate IDs so hierarchy is preserved. Read the resulting workspace or propagation result to obtain the actual propagated unstain singlet population ID; do not invent it.

Phase 3 — propose the coupled quadrant without writing it:
1. Call suggest_apoptosis_quadrants with:
   - sample_id: group_1
   - parent_gate_id: the stored group_1 singlet gate ID
   - annexin_channel: Annexin X-FITC-A
   - death_channel: PI-PerCP-Cy5.5-A
   - negative_control: { sample_id: "unstain", parent_gate_id: the propagated unstain singlet gate ID }
   - threshold_method: negative_control_percentile
   - negative_percentile: 99
   - compensation_id: derived_single_stain
2. Show both thresholds and the four preliminary group_1 percentages in a review table.
3. Ask once: "Approve these coupled quadrant thresholds to write and propagate?"

Phase 4 — finish after quadrant approval:
1. Write the returned single quadrant gate to group_1 with its upsert_gate next action.
2. Propagate the complete reviewed source hierarchy — main-cell, singlet, and quadrant gate IDs — to group_2, group_3, group_5, group_6, positive, and unstain. The current propagation contract requires selected parent gates; deterministic target IDs update the already propagated upstream gates rather than creating a second hierarchy.
3. Open exactly one native gate editor with reuse_session=true on group_1 at the compensated Annexin/PI view. Keep the coupled cross visible; the center moves both thresholds and each arm moves one threshold.
4. Call get_population_table for ${allAnalysisSamples.join(", ")} with column_key="name_path" and compensation_id="derived_single_stain".
5. Return Sample | Viable | Early apoptotic | Late apoptotic/dead | Membrane damaged. Confirm that positive has the expected high-apoptosis phenotype and that unstain is predominantly viable. Briefly interpret treatment differences without overstating biological conclusions.

This full-workflow rehearsal is less deterministic than the focused prompt because the main-cell polygon is still agent-proposed from plot context. Do not hide that limitation in the narration.

Local data folder, for reference only:
${dataDir}
`;
}

async function main() {
  const dataDir = path.resolve(argValue("--data-dir", defaultDataDir));
  const requestedWorkspaceDir = argValue("--workspace-dir", "");
  const workspaceDir = requestedWorkspaceDir
    ? path.resolve(requestedWorkspaceDir)
    : path.join(defaultWorkspaceRoot, `analysis_review_${timestampSlug()}`);
  const runAnalysis = hasFlag("--run-analysis");
  const force = hasFlag("--force");
  const workspacePath = path.join(workspaceDir, "flowcyto.workspace.json");

  if (force) await rm(workspaceDir, { recursive: true, force: true });
  if (!force) {
    try {
      await access(workspacePath);
      throw new Error(`Workspace already exists at ${workspacePath}. Choose a new --workspace-dir or pass --force explicitly.`);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  await mkdir(workspaceDir, { recursive: true });

  const workspace = {
    version: 1,
    revision: 0,
    samples: sampleFiles.map(([id, file]) => ({
      id,
      path: relativeForWorkspace(workspaceDir, path.join(dataDir, file)),
    })),
    views: [],
    gates: [],
  };
  await writeFile(workspacePath, `${JSON.stringify(workspace, null, 2)}\n`, "utf8");

  const validation = await validateWorkspace(workspacePath);
  if (!validation.ok) {
    console.error(JSON.stringify(validation, null, 2));
    process.exitCode = 1;
    return;
  }

  const mcpConfig = {
    mcpServers: {
      flowcyto: {
        command: "node",
        args: [path.join(repoRoot, "dist", "src", "mcp", "server.js")],
      },
    },
  };
  await writeFile(path.join(workspaceDir, ".mcp.json"), `${JSON.stringify(mcpConfig, null, 2)}\n`, "utf8");
  const focusedPromptPath = path.join(workspaceDir, "demo-prompt-focused.txt");
  const fullWorkflowPromptPath = path.join(workspaceDir, "demo-prompt-full-workflow.txt");
  await writeFile(focusedPromptPath, focusedPromptText({ workspacePath, dataDir }), "utf8");
  await writeFile(fullWorkflowPromptPath, fullWorkflowPromptText({ workspacePath, dataDir }), "utf8");
  await writeFile(path.join(workspaceDir, "demo-prompt.txt"), focusedPromptText({ workspacePath, dataDir }), "utf8");

  const opened = await openFcsArtifact({ path: path.join(dataDir, "Apoptosis-DC2.4_Group_1.fcs"), workspaceDir, sampleId: "group_1" });
  const embeddedCompensationId = opened.compensationSummary.suggestedCompensationId ?? "fcs_spillover_group_1";
  const compensationId = "derived_single_stain";

  let analysisSummary = null;
  if (runAnalysis) {
    const estimated = await estimateCompensationFromControls({
      id: compensationId,
      name: "Derived single-stain compensation",
      channels: ["Annexin X-FITC-A", "PI-PerCP-Cy5.5-A"],
      controls: [
        { path: path.join(dataDir, "Apoptosis-DC2.4_Compensation_BL1-A.fcs"), channel: "Annexin X-FITC-A" },
        { path: path.join(dataDir, "Apoptosis-DC2.4_Compensation_BL3-A.fcs"), channel: "PI-PerCP-Cy5.5-A" },
      ],
      unstainedPath: path.join(dataDir, "Apoptosis-DC2.4_Group_unstain.fcs"),
      eventSelection: { type: "primary_channel_top_percentile", percentile: 90 },
    });
    const beforeCompensation = await readWorkspace(workspacePath);
    await upsertCompensationMatrix({
      workspacePath,
      compensation: estimated.compensation,
      expectedRevision: beforeCompensation.revision,
    });
    const suggested = await suggestApoptosisQuadrants({
      workspacePath,
      sampleId: "group_1",
      annexinChannel: "Annexin X-FITC-A",
      deathChannel: "PI-PerCP-Cy5.5-A",
      negativeControl: { sampleId: "unstain" },
      negativePercentile: 99,
      compensationId,
    });
    requireCondition(suggested.gate.type === "quadrant", "apoptosis suggestion did not return one quadrant gate");
    requireCondition(suggested.gate.quadrants.length === 4, "quadrant gate does not define four populations");
    const beforeWrite = await readWorkspace(workspacePath);
    const write = await upsertGate({
      workspacePath,
      gate: suggested.gate,
      expectedRevision: beforeWrite.revision,
    });
    if (!write.ok) throw new Error(`Unable to write suggested gates: ${JSON.stringify(write.errors)}`);
    const afterWrite = await readWorkspace(workspacePath);
    const propagated = await propagateGates({
      workspacePath,
      sourceGateIds: [suggested.gate.id],
      targetSampleIds: ["group_2", "group_3", "group_5", "group_6", "positive"],
      expectedRevision: afterWrite.revision,
    });
    if (!propagated.ok) throw new Error(`Unable to propagate gates: ${JSON.stringify(propagated.errors)}`);
    requireCondition(propagated.propagatedCount === 5, `expected 5 propagated gates, received ${propagated.propagatedCount}`);
    const table = await getPopulationTable({
      workspacePath,
      sampleIds: ["group_1", "group_2", "group_3", "group_5", "group_6", "positive"],
      compensationId,
      columnKey: "name_path",
    });
    requireCondition(table.columns.length === 4, `expected 4 aligned population columns, received ${table.columns.length}`);
    requireCondition(table.rows.length === 6, `expected 6 population rows, received ${table.rows.length}`);
    const positiveRow = table.rows.find((row) => row.sampleId === "positive");
    const groupOneRow = table.rows.find((row) => row.sampleId === "group_1");
    const lateColumn = table.columns.find((column) => column.name.startsWith("Late apoptotic/dead"));
    requireCondition(positiveRow && groupOneRow && lateColumn, "population table is missing expected samples or late-apoptotic column");
    requireCondition(
      positiveRow.gates[lateColumn.key].percentOfParent > groupOneRow.gates[lateColumn.key].percentOfParent,
      "positive control does not exceed group_1 in the late-apoptotic/dead population",
    );
    const analyzedWorkspace = await readWorkspace(workspacePath);
    const embeddedCompensation = analyzedWorkspace.compensations?.find((matrix) => matrix.id === embeddedCompensationId);
    requireCondition(embeddedCompensation, `embedded compensation ${embeddedCompensationId} was not found`);
    analysisSummary = {
      compensation: estimated.compensation,
      embeddedCompensationId,
      annexinToPiComparison: {
        embedded: spilloverCoefficient(embeddedCompensation, 0, 1),
        derived: spilloverCoefficient(estimated.compensation, 0, 1),
      },
      thresholds: suggested.thresholds,
      quadrantGateId: suggested.gate.id,
      summary: suggested.summary,
      propagatedCount: propagated.propagatedCount,
      columns: table.columns,
      rows: table.rows,
    };
    await writeFile(path.join(workspaceDir, "expected-analysis.json"), `${JSON.stringify(analysisSummary, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify({
    ok: true,
    workspaceDir,
    workspacePath,
    mcpConfigPath: path.join(workspaceDir, ".mcp.json"),
    promptPath: path.join(workspaceDir, "demo-prompt.txt"),
    focusedPromptPath,
    fullWorkflowPromptPath,
    compensationId: runAnalysis ? compensationId : embeddedCompensationId,
    sampleIds: sampleFiles.map(([id]) => id),
    analysis: analysisSummary ? path.join(workspaceDir, "expected-analysis.json") : null,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
