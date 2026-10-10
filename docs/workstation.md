# Flowcyto Workstation

Flowcyto Workstation is a FlowJo-style desktop for a flowcyto workspace,
served to a web browser:

```
flowcyto workstation <path/to/flowcyto.workspace.json> [--host 127.0.0.1] [--port 0]
```

It prints the address to open. Every change is written to the workspace file
as it is made; there is nothing to save separately.

## The workspace window

* **Ribbon.** Tabs File, Edit, Workspace and Tools hold the commands below.
  Hovering a button shows its shortcut.
* **Groups pane.** *All Samples* plus any groups you create, with each group's
  size and role. Click a group to list its samples; double-click to edit it.
  Graph windows step through the samples of the selected group.
* **Samples pane.** One row per sample, with its event count and the
  compensation matrix applied to it. Click ▸ (or press →) to show the
  population tree. For each population, *Statistic* is its frequency of the
  parent population in percent and *#Cells* its event count.
  * Double-click a sample or population (or press Enter) to open a graph window.
  * Right-click for Open Graph, Rename (F2), Copy to Group, Delete (Del), and,
    on samples, Apply Matrix and Create Group from Selection.
  * Ctrl-click and Shift-click select several samples.
  * Drag a population onto a group in the Groups pane, or onto another sample,
    to copy that gate there.

**Copy to Group** copies the population's gate, every gate below it and any
gates above it that the target sample lacks. Gates are matched across samples
by their names along the path from the sample: a gate whose path already
exists in the target is replaced by the copy, keeping its place in the tree.
Copied gates are independent: editing one later does not change the others.

## Graph windows

A graph window shows the events of one population of one sample.

* **Axes.** Click an axis label to choose its parameter; choose *Histogram* on
  the Y axis for a one-parameter plot. Parameters shown compensated are
  labelled `Comp-`. The **T** button next to each axis switches it between
  Linear, Log and Biex, or opens **Customize Axis** (range, and the width of
  the linear region of a biex axis). Axis settings apply to that parameter in
  every sample, and change only how plots are drawn.
* **Plot type** (bottom left): Pseudocolor, Dot Plot, Density or Histogram.
* **Navigation.** ◀ and ▶ move to the previous or next sample of the group,
  showing the population with the same name path; ▲ goes to the parent
  population. The sample name in the bar below the tools lists the group's
  samples; the population names after it go to that population.
* **Undo and redo** (↶ ↷, Ctrl+Z, Ctrl+Y) undo gate creation, edits, deletion
  and renaming.

### Drawing gates

Choose a tool, then draw on the plot. When a gate is finished, name it in the
**Gate Name** dialog.

| Tool | How to draw |
| --- | --- |
| ▭ Rectangle | Press, drag and release. |
| ⬠ Polygon | Click each vertex; double-click, press Enter or click the first vertex to close. |
| ✎ Freehand | Press and trace the outline; release to close. |
| ⊞ Quadrant | Click the centre. Quadrants are named Q1 (top left) to Q4 (bottom left) with their signs. |
| ↔ Range (histograms) | Press, drag across the range and release. |
| ⊥ Bisector (histograms) | Click the split point. Creates two ranges, L and R. |

A vertex or edge placed on or beyond the edge of the plot is open-ended: it
takes in every event past that edge, including events piled up on it.

Each gate on the plot shows its name and the percentage of the plotted
population inside it. Gates drawn here are children of the plotted population.

### Editing gates

* Click a gate to select it; drag inside it to move it; drag its square
  handles to move vertices, corners, a quadrant's centre or a range's ends.
* Arrow keys nudge the selected gate by one pixel (Shift: ten).
* Delete removes the selected gate and every population below it.
* Double-click inside a gate to open a graph window of that population.
* Right-click a gate for Open Graph, Rename and Delete.

### Manual Gate Definition (Ctrl+G)

**Graph ▸ Manually Enter Gate…** (Ctrl+G) creates a gate from typed limits:
a rectangle on a two-parameter plot, or a range on a histogram. Each axis has
a lower and an upper limit in one of two units:

* **Intensity**: values on the axis scale (the dialog starts at the axis
  range). `inf` and `-inf` make a side open-ended.
* **Percentile**: the limits are the values below which that percentage of
  the plotted population lies, worked out once when you press OK.

**Make Quad Gates** turns the lower limits into the centre of a quadrant gate.

## Compensation

Compensation matrices hold spillover values: the row is the fluorochrome, the
column the detector it spills into, and each row's diagonal is 1 (100 %).
Applying a matrix to a sample shows that sample's data compensated in every
plot and statistic.

* **Tools ▸ Compensation** works a matrix out from single-stain controls. For
  each parameter, choose its control sample (the workstation suggests the
  tube whose name names the fluorochrome) and, from populations gated in the
  workspace, the positive (stained) and negative (unstained) populations. The
  negative population can come from another tube, such as an unstained
  control. **Calculate** divides the difference between the medians of the
  two populations in every detector by the same difference in the control's
  own detector. Name the matrix and press **Save Matrix**, then **Apply
  Matrix** to samples or groups.
* **Tools ▸ Matrix Editor** lists the workspace's matrices. Matrices read
  from FCS files (acquisition matrices) cannot be changed; **Edit** makes an
  editable copy. **+ New** starts an identity matrix over the fluorescence
  parameters. Click a cell to type a value, or use ↑ and ↓ (Shift for larger
  steps, Ctrl or Alt for smaller). Values can be shown as percentages or
  fractions. **Save** stores the matrix; **Apply Matrix** applies it.
* **Tools ▸ Apply Matrix**, a sample's right-click menu, or a group's
  right-click menu apply a matrix, or remove compensation.

## The journal

Next to the workspace file, `<name>.journal.jsonl` records every change the
workstation writes: one line per revision, with the operation, how it was made
(for example `draw:rect`, `manual`, `edit:handle`, `copy`, `matrix-editor`)
and the SHA-256 of the workspace as written. A line with action `open` marks
each time the workstation opens the workspace, and whether the file still
matched the last write it recorded. An unbroken run of revisions, each in the
journal, ending in the file on disk, shows that every change was made in the
workstation.

## Differences from FlowJo

The workstation follows FlowJo's layout and workflow, but it is not FlowJo
and does not read or write FlowJo `.wsp` files. Among the differences:
compensation controls are not gated automatically (gate the positive and
negative populations yourself); there are no ellipse, spider, curly-quadrant
or auto gates, no layout or table editor, and no percentile "control gates"
that recalculate per sample; a biex axis is an arcsinh scale with a set
linear width rather than FlowJo's logicle parameters.
