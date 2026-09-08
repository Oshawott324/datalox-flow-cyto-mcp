#!/usr/bin/env Rscript
#
# generate-flowjo-biex-reference.R
#
# Generates numeric reference fixtures for the FlowJo biex transform using
# flowWorkspace::flowjo_biexp(). Output is written to:
#   testdata/fixtures/biex-transform-reference.json
#
# This script must be run in an R environment with flowWorkspace installed.
# It does NOT need a live FlowJo installation — flowWorkspace reimplements
# the biex spline internally.
#
# Usage:
#   Rscript scripts/generate-flowjo-biex-reference.R
#
# Requirements:
#   install.packages("BiocManager")
#   BiocManager::install("flowWorkspace")
#   install.packages("jsonlite")
#
# The output JSON is the acceptance target for src/core/biex-transform.ts.
# A clean-room TypeScript implementation is considered correct if it matches
# every case in this file within the stated tolerance (see "toleranceAbsolute"
# in each case).
#
# MIT-licensing note: this script only calls the public flowWorkspace API and
# records numeric inputs and outputs. It does not incorporate any flowWorkspace
# or cytolib source code. The output JSON is measurement data, not a derived
# work, and is safe to commit in this MIT-licensed repository.

library(flowWorkspace)
library(jsonlite)

# ---------------------------------------------------------------------------
# Parameter sets to validate.
#
# Each entry maps directly to a <transforms:biex ...> element in a FlowJo .wsp:
#   length     = transforms:length
#   maxRange   = transforms:maxRange  (called maxValue in flowjo_biexp)
#   pos        = transforms:pos
#   neg        = transforms:neg
#   width      = transforms:width     (called widthBasis in flowjo_biexp)
# ---------------------------------------------------------------------------
parameter_sets <- list(
  list(
    label    = "flowjo_defaults",
    notes    = "FlowJo 10 factory defaults for a 18-bit instrument",
    length   = 256,
    maxRange = 262144,
    pos      = 4.5,
    neg      = 0,
    width    = -10
  ),
  list(
    label    = "flowjo_defaults_neg1",
    notes    = "FlowJo 10 defaults with 1 negative decade (common for PI/viability)",
    length   = 256,
    maxRange = 262144,
    pos      = 4.5,
    neg      = 1,
    width    = -10
  ),
  list(
    label    = "fixture_wsp_biex",
    notes    = "Parameters from testdata/fixtures/flowjo/transform-log-fasinh.wsp BIEX-A gate",
    length   = 256,
    maxRange = 214748,
    pos      = 4.3319291278,
    neg      = 0,
    width    = -10
  ),
  list(
    label    = "aurora_style",
    notes    = "Typical Aurora 5-laser parameters seen in cytometry literature",
    length   = 256,
    maxRange = 262144,
    pos      = 4.0,
    neg      = 0,
    width    = -10
  ),
  list(
    label    = "narrow_width",
    notes    = "Wider linear region (less negative widthBasis) — edge case for root-finder",
    length   = 256,
    maxRange = 262144,
    pos      = 4.5,
    neg      = 0,
    width    = -100
  )
)

# ---------------------------------------------------------------------------
# Input data values: span the full range including negative (important for
# biex, which is symmetric around zero unlike log). Include boundary values
# that exercise the linear, transition, and logarithmic regions of the curve.
# ---------------------------------------------------------------------------
inputs <- c(
  -262144, -100000, -50000, -10000, -5000, -1000, -500, -100, -50, -10,
  -5, -1, 0, 1, 5, 10, 50, 100, 500, 1000, 5000, 10000,
  50000, 100000, 200000, 250000, 262143
)

# ---------------------------------------------------------------------------
# Generate cases
# ---------------------------------------------------------------------------
cases <- list()

for (params in parameter_sets) {
  # flowWorkspace uses "widthBasis" for what the .wsp calls "width"
  forward <- flowjo_biexp(
    channelRange = params$length,
    maxValue   = params$maxRange,
    pos        = params$pos,
    neg        = params$neg,
    widthBasis = params$width
  )
  inverse <- flowjo_biexp(
    channelRange = params$length,
    maxValue   = params$maxRange,
    pos        = params$pos,
    neg        = params$neg,
    widthBasis = params$width,
    inverse    = TRUE
  )

  display   <- forward(inputs)
  roundTrip <- inverse(display)

  maxErr <- max(abs(roundTrip - inputs), na.rm = TRUE)
  # Tight tolerance: the TypeScript implementation must meet the same bar
  toleranceAbsolute <- max(1e-6, maxErr * 10)

  cases[[length(cases) + 1]] <- list(
    label = params$label,
    notes = params$notes,
    parameters = list(
      length   = params$length,
      maxRange = params$maxRange,
      pos      = params$pos,
      neg      = params$neg,
      width    = params$width
    ),
    wspAttributeNames = list(
      length   = "transforms:length",
      maxRange = "transforms:maxRange",
      pos      = "transforms:pos",
      neg      = "transforms:neg",
      width    = "transforms:width"
    ),
    inputs            = inputs,
    display           = display,
    roundTrip         = roundTrip,
    roundTripMaxError = maxErr,
    toleranceAbsolute = toleranceAbsolute
  )
}

# ---------------------------------------------------------------------------
# Write JSON
# ---------------------------------------------------------------------------
result <- list(
  generator            = "flowWorkspace::flowjo_biexp",
  flowWorkspaceVersion = as.character(packageVersion("flowWorkspace")),
  generatedAt          = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  description          = paste(
    "Numeric reference fixtures for the FlowJo biex transform.",
    "Each case records forward (data->display) and inverse (display->data) values",
    "for a specific parameter set. A clean-room TypeScript implementation is",
    "accepted if it matches 'display' within 'toleranceAbsolute' for every case.",
    "Do not implement biex from these numbers alone — also validate against a",
    "real FlowJo .wsp file opened in FlowJo 10 to confirm gate positioning."
  ),
  cases = cases
)

script_dir <- tryCatch(
  dirname(sys.frame(1)$ofile),
  error = function(e) getwd()
)
repo_root   <- normalizePath(file.path(script_dir, ".."), mustWork = FALSE)
output_path <- file.path(repo_root, "testdata", "fixtures", "biex-transform-reference.json")

dir.create(dirname(output_path), showWarnings = FALSE, recursive = TRUE)
jsonlite::write_json(result, output_path, auto_unbox = TRUE, digits = 15, pretty = TRUE)
cat(sprintf("Wrote %s\n", output_path))
cat(sprintf("Cases: %d\n", length(cases)))
for (case in cases) {
  cat(sprintf("  %-30s  round-trip max err = %.2e\n", case$label, case$roundTripMaxError))
}
