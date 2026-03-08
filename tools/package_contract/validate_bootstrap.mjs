import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "../..");

function hashText(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), "utf8"));
}

async function hashFile(relativePath) {
  const buffer = await fs.readFile(path.join(root, relativePath));
  return createHash("sha256").update(buffer).digest("hex");
}

async function main() {
  const packageJson = await readJson("package.json");
  const manifestPath = packageJson.provenance?.manifest;
  assertCondition(Boolean(manifestPath), "package.json missing provenance.manifest");

  const manifest = await readJson(manifestPath);
  assertCondition(packageJson.name === manifest.package.name, "package name mismatch");
  assertCondition(packageJson.version === manifest.package.version, "package version mismatch");
  assertCondition(!("domains" in packageJson), "legacy domains field should be removed");
  assertCondition(!("categorization" in packageJson), "legacy categorization field should be removed");
  assertCondition(
    !(packageJson.dependencies || []).some((dependency) => dependency.name === "typedoc"),
    "typedoc dependency should be removed"
  );

  for (const artifact of manifest.upstream.sourceArtifacts) {
    const actual = await hashFile(artifact.path);
    assertCondition(actual === artifact.sha256, `source artifact hash mismatch: ${artifact.path}`);
  }

  for (const artifact of manifest.artifacts) {
    const actual = await hashFile(artifact.path);
    assertCondition(actual === artifact.sha256, `generated artifact hash mismatch: ${artifact.path}`);
  }

  const headerFiles = manifest.artifacts.filter((artifact) => artifact.path.endsWith(".tql")).map((artifact) => artifact.path);

  const expectedHeader = `# manifest: ${manifestPath}`;
  for (const relativePath of new Set(headerFiles)) {
    const text = await fs.readFile(path.join(root, relativePath), "utf8");
    assertCondition(text.includes(expectedHeader), `missing manifest header in ${relativePath}`);
  }

  assertCondition(Array.isArray(packageJson.manifests) && packageJson.manifests.includes(manifestPath), "package.json manifests missing active manifest");
  assertCondition(await fs.stat(path.join(root, "docs/translation/README.md")).then(() => true).catch(() => false), "missing docs/translation/README.md");

  console.log("bootstrap validation ok");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
