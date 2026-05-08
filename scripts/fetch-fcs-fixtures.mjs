#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const manifestPath = resolve("testdata/fixtures/manifest.json");
const downloadDir = resolve("testdata/fixtures/downloaded");
const cacheDir = resolve(".datalox/cache/fixture-sources");

async function exists(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function digest(input) {
  return createHash("sha256").update(input).digest("hex");
}

async function download(url, targetPath) {
  await fs.mkdir(dirname(targetPath), { recursive: true });
  await execFileAsync("curl", ["-L", "--fail", "--silent", "--show-error", url, "-o", targetPath]);
}

async function extractOne(archivePath, packagePath, targetPath) {
  const tempDir = await fs.mkdtemp(join(cacheDir, "extract-"));
  try {
    await execFileAsync("tar", ["-xzf", archivePath, "-C", tempDir, packagePath]);
    await fs.mkdir(dirname(targetPath), { recursive: true });
    await fs.copyFile(join(tempDir, packagePath), targetPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
await fs.mkdir(cacheDir, { recursive: true });
await fs.mkdir(downloadDir, { recursive: true });

let copied = 0;
for (const fixture of manifest.fixtures) {
  if (!fixture.sourceUrl || !fixture.packagePath) continue;
  const targetPath = resolve(fixture.path);
  if (await exists(targetPath)) continue;
  const archivePath = join(cacheDir, `${digest(fixture.sourceUrl)}.tar.gz`);
  if (!(await exists(archivePath))) {
    await download(fixture.sourceUrl, archivePath);
  }
  await extractOne(archivePath, fixture.packagePath, targetPath);
  copied += 1;
  process.stdout.write(`${fixture.id} -> ${fixture.path}\n`);
}

process.stdout.write(JSON.stringify({
  ok: true,
  copied,
  manifestPath,
  downloadDir,
}, null, 2) + "\n");
