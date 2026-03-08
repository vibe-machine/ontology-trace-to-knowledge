import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "../..");

const GENERATOR = {
  name: "trace-to-knowledge-package-refresh",
  version: "0.1.0",
};

function escapeTypeQL(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function sha256File(filePath) {
  const buffer = await fs.readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function renderHeader({ repoUrl, tag, commit, sourceArtifacts, manifestPath, generator }) {
  return [
    "# Provenance bootstrap",
    `# upstream-repo: ${repoUrl}`,
    `# upstream-tag: ${tag}`,
    `# upstream-commit: ${commit}`,
    "# source-artifacts:",
    ...sourceArtifacts.map((artifact) => `# - ${artifact.path}`),
    `# manifest: ${manifestPath}`,
    `# generator: ${generator.name}/${generator.version}`,
    "",
  ].join("\n");
}

function collectDeclarations(schemaText) {
  const resources = [];
  const lines = schemaText.split("\n");
  let commentBuffer = [];

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();

    if (!line) {
      commentBuffer = [];
      continue;
    }

    if (line.startsWith("#")) {
      const comment = line.replace(/^#\s?/, "").trim();
      if (comment && !/^[-]+$/.test(comment)) commentBuffer.push(comment);
      continue;
    }

    const attributeMatch = line.match(/^attribute\s+([A-Za-z][A-Za-z0-9_]*)\s*,\s*value\s+([A-Za-z][A-Za-z0-9_]*)\s*;/);
    if (attributeMatch) {
      resources.push({
        kind: "attribute",
        typeLabel: attributeMatch[1],
        valueType: attributeMatch[2],
        comments: commentBuffer,
      });
      commentBuffer = [];
      continue;
    }

    const entityMatch = line.match(/^entity\s+([A-Za-z][A-Za-z0-9_]*)(?:\s+sub\s+([A-Za-z][A-Za-z0-9_]*))?/);
    if (entityMatch) {
      resources.push({
        kind: "entity",
        typeLabel: entityMatch[1],
        supertype: entityMatch[2] ?? null,
        comments: commentBuffer,
      });
      commentBuffer = [];
      while (!lines[index].includes(";") && index < lines.length - 1) index += 1;
      continue;
    }

    const relationMatch = line.match(/^relation\s+([A-Za-z][A-Za-z0-9_]*)/);
    if (relationMatch) {
      resources.push({
        kind: "relation",
        typeLabel: relationMatch[1],
        comments: commentBuffer,
      });
      commentBuffer = [];
      while (!lines[index].includes(";") && index < lines.length - 1) index += 1;
    }
  }

  return resources;
}

function buildDefinition(resource) {
  const comments = resource.comments.filter(Boolean);
  if (comments.length > 0) return comments.join(" ");

  if (resource.kind === "attribute") {
    return `Auto-generated attribute extracted from the Trace-to-Knowledge schema.`;
  }
  if (resource.kind === "entity") {
    return `Auto-generated entity extracted from the Trace-to-Knowledge schema.`;
  }
  return `Auto-generated relation extracted from the Trace-to-Knowledge schema.`;
}

function buildScopeNote(resource) {
  if (resource.kind === "attribute" && resource.valueType) {
    return `value type: ${resource.valueType}`;
  }
  if (resource.kind === "entity" && resource.supertype) {
    return `subtype of ${resource.supertype}`;
  }
  return null;
}

function renderSchemaDocs(meta, resources) {
  const lines = [
    renderHeader(meta),
    "insert",
    "",
    "$module isa SchemaModule,",
    `  has moduleKey "${escapeTypeQL(meta.packageName)}",`,
    `  has moduleName "${escapeTypeQL(meta.moduleName)}",`,
    `  has moduleKind "${escapeTypeQL(meta.moduleKind)}";`,
    "",
  ];

  resources.forEach((resource, index) => {
    const variable = `$r${index + 1}`;
    const docKey = `${meta.repoUrl}#${resource.typeLabel}`;
    const definition = buildDefinition(resource);
    const scopeNote = buildScopeNote(resource);
    lines.push(`${variable} isa SchemaResource,`);
    lines.push(`  has docKey "${escapeTypeQL(docKey)}",`);
    lines.push(`  has iri "${escapeTypeQL(docKey)}",`);
    lines.push(`  has typeLabel "${escapeTypeQL(resource.typeLabel)}",`);
    lines.push(`  has kind "${escapeTypeQL(resource.kind)}",`);
    lines.push(`  has prefLabel "${escapeTypeQL(resource.typeLabel)}",`);
    lines.push(`  has definition "${escapeTypeQL(definition)}"${scopeNote ? "," : ";"} `);
    if (scopeNote) {
      lines.push(`  has scopeNote "${escapeTypeQL(scopeNote)}";`);
    }
    lines.push(`(resource: ${variable}, module: $module) isa inModule;`);
    lines.push("");
  });

  return lines.join("\n").replace(/; \n/g, ";\n");
}

function renderProvenanceData(manifest, manifestPath, provenancePath) {
  const buildKey = `${manifest.package.name}@${manifest.package.version}:${manifest.upstream.commit}`;
  const lines = [
    renderHeader({
      repoUrl: manifest.upstream.repoUrl,
      tag: manifest.upstream.tag,
      commit: manifest.upstream.commit,
      sourceArtifacts: manifest.upstream.sourceArtifacts,
      manifestPath,
      generator: manifest.generator,
    }),
    "insert",
    "",
    "$build isa OntologyPackageBuild,",
    `  has buildKey "${escapeTypeQL(buildKey)}",`,
    `  has packageName "${escapeTypeQL(manifest.package.name)}",`,
    `  has packageVersion "${escapeTypeQL(manifest.package.version)}",`,
    `  has upstreamRepoUrl "${escapeTypeQL(manifest.upstream.repoUrl)}",`,
    `  has upstreamTag "${escapeTypeQL(manifest.upstream.tag)}",`,
    `  has upstreamCommit "${escapeTypeQL(manifest.upstream.commit)}",`,
    `  has manifestPath "${escapeTypeQL(manifestPath)}",`,
    `  has generatorName "${escapeTypeQL(manifest.generator.name)}",`,
    `  has generatorVersion "${escapeTypeQL(manifest.generator.version)}",`,
    `  has generatedAt "${escapeTypeQL(manifest.generator.generatedAt)}";`,
    "",
  ];

  manifest.upstream.sourceArtifacts.forEach((artifact, index) => {
    const variable = `$s${index + 1}`;
    lines.push(`${variable} isa SourceArtifactRecord,`);
    lines.push(`  has sourcePath "${escapeTypeQL(artifact.path)}",`);
    lines.push(`  has sourceSha256 "${escapeTypeQL(artifact.sha256)}";`);
    lines.push(`(build: $build, sourceArtifact: ${variable}) isa buildHasSourceArtifact;`);
    lines.push("");
  });

  const generatedArtifacts = manifest.artifacts.filter((artifact) => artifact.path !== provenancePath);
  generatedArtifacts.forEach((artifact, index) => {
    const variable = `$g${index + 1}`;
    lines.push(`${variable} isa GeneratedArtifactRecord,`);
    lines.push(`  has artifactPath "${escapeTypeQL(artifact.path)}",`);
    lines.push(`  has artifactKind "${escapeTypeQL(artifact.kind)}",`);
    lines.push(`  has artifactSha256 "${escapeTypeQL(artifact.sha256)}";`);
    lines.push(`(build: $build, generatedArtifact: ${variable}) isa buildHasGeneratedArtifact;`);
    lines.push("");
  });

  return lines.join("\n").trimEnd() + "\n";
}

async function main() {
  const packagePath = path.join(root, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
  const manifestPath = packageJson.provenance.manifest;
  const schemaPath = "schema/traceToKnowledge.tql";
  const docsPath = "data/trace-to-knowledge-schema-docs.tql";
  const provenancePath = "data/trace-to-knowledge-provenance.tql";
  const manifestSchemaPath = "manifests/package-manifest.schema.json";
  const sourcePaths = ["package.json", schemaPath, "tools/package_contract/refresh_package_contract.mjs"];

  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const generatedAt = new Date().toISOString();
  const sourceArtifacts = [];
  for (const relativePath of sourcePaths) {
    sourceArtifacts.push({
      path: relativePath,
      sha256: await sha256File(path.join(root, relativePath)),
    });
  }

  const schemaText = await fs.readFile(path.join(root, schemaPath), "utf8");
  const resources = collectDeclarations(schemaText);
  const headerMeta = {
    repoUrl: packageJson.source,
    tag: `v${packageJson.version}`,
    commit,
    sourceArtifacts,
    manifestPath,
    generator: GENERATOR,
    packageName: packageJson.name,
    moduleName: packageJson.displayName,
    moduleKind: "hand-authored-package",
  };

  const docsText = renderSchemaDocs(headerMeta, resources);
  await fs.writeFile(path.join(root, docsPath), docsText, "utf8");

  const manifest = {
    manifestVersion: "1.0.0",
    package: {
      name: packageJson.name,
      version: packageJson.version,
    },
    upstream: {
      repoUrl: packageJson.source,
      tag: `v${packageJson.version}`,
      commit,
      sourceArtifacts,
    },
    generator: {
      ...GENERATOR,
      generatedAt,
    },
    artifacts: [
      {
        kind: "documentation",
        path: docsPath,
        sha256: sha256Text(docsText),
      },
      {
        kind: "manifest-schema",
        path: manifestSchemaPath,
        sha256: await sha256File(path.join(root, manifestSchemaPath)),
      },
      {
        kind: "provenance-seeds",
        path: provenancePath,
        sha256: "",
      },
    ],
  };

  const provenanceText = renderProvenanceData(manifest, manifestPath, provenancePath);
  manifest.artifacts = manifest.artifacts.map((artifact) =>
    artifact.path === provenancePath ? { ...artifact, sha256: sha256Text(provenanceText) } : artifact,
  );

  await fs.writeFile(path.join(root, manifestPath), jsonText(manifest), "utf8");
  await fs.writeFile(path.join(root, provenancePath), provenanceText, "utf8");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
