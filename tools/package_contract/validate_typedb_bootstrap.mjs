import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "../..");
const workspaceRoot = path.resolve(root, "..");

async function resolveTypedbBinary() {
  const candidates = [
    process.env.TYPEDB_BIN,
    ...(process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, "typedb")),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error("TypeDB executable not found on PATH. Install it or set TYPEDB_BIN.");
}

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readJson(basePath, relativePath) {
  return JSON.parse(await fs.readFile(path.join(basePath, relativePath), "utf8"));
}

function packageRepoPath(name) {
  return path.join(workspaceRoot, `ontology-${name}`);
}

async function resolvePackageOrder(packageRoot, seen = new Set(), visiting = new Set()) {
  const manifest = await readJson(packageRoot, "package.json");
  const packageName = manifest.name;

  if (seen.has(packageName)) return [];
  if (visiting.has(packageName)) {
    throw new Error(`cyclic ontology dependency detected at ${packageName}`);
  }

  visiting.add(packageName);
  const ordered = [];
  for (const dependency of manifest.dependencies ?? []) {
    const dependencyRoot = packageRepoPath(dependency.name);
    await fs.access(path.join(dependencyRoot, "package.json"));
    ordered.push(...await resolvePackageOrder(dependencyRoot, seen, visiting));
  }
  visiting.delete(packageName);

  if (!seen.has(packageName)) {
    seen.add(packageName);
    ordered.push({ root: packageRoot, manifest });
  }
  return ordered;
}

function resolveModuleRepoUrl(manifest) {
  return manifest.source?.repoUrl
    ?? (typeof manifest.source === "string" ? manifest.source : null)
    ?? manifest.upstream?.repoUrl
    ?? manifest.upstream?.repo
    ?? null;
}

function classifyAssemblyAssets(manifest) {
  const schemaAssets = new Set((manifest.schemas ?? []).map((schema) => schema.file));
  return (manifest.assembly?.loadOrder ?? []).map((assetPath) => ({
    relativePath: assetPath,
    kind: schemaAssets.has(assetPath) ? "schema" : "write"
  }));
}

function rewriteChunk(text, keyword, variablePrefix) {
  const sanitizedPrefix = variablePrefix.replace(/[^A-Za-z0-9_]+/g, "_");
  let chunk = text.replace(/^#.*\n/gm, "");
  chunk = chunk.replace(new RegExp(`^\\s*${keyword}\\s*\\n`, "i"), "");
  chunk = chunk.replace(/\$([A-Za-z][A-Za-z0-9_]*)/g, `\$${sanitizedPrefix}_$1`);
  return chunk.trim();
}

async function writeMergedQueryFile(keyword, assets, outPath) {
  const chunks = [];

  for (const [index, asset] of assets.entries()) {
    let text = await fs.readFile(path.join(asset.packageRoot, asset.relativePath), "utf8");
    text = rewriteChunk(text, keyword, `${keyword}${index + 1}`);
    if (text) chunks.push(text);
  }

  const hasPut = chunks.some((chunk) => /^put /m.test(chunk));
  const merged = hasPut
    ? `${chunks.join("\n\n")}\n`
    : `${keyword}\n\n${chunks.join("\n\n")}\n`;
  await fs.writeFile(outPath, merged, "utf8");
}

function declaredVariablesForBlock(block) {
  return [...block.matchAll(/\$([A-Za-z][A-Za-z0-9_]*)\s+isa\b/g)].map((match) => match[1]);
}

function referencedVariablesForBlock(block) {
  return [...block.matchAll(/\$([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1]);
}

function atomicWriteBlocks(trimmed) {
  const blocks = trimmed
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.length > 1) {
    return blocks;
  }

  const statements = trimmed.match(/[\s\S]*?;/g) ?? [];
  if (statements.length === 0) {
    return [trimmed];
  }

  const statementBlocks = [];
  for (let index = 0; index < statements.length; index++) {
    const current = statements[index].trim();
    const referencedVariables = referencedVariablesForBlock(current);
    const blockStatements = [current];
    const next = statements[index + 1]?.trim();
    if (
      next &&
      (next.startsWith("put (") || next.startsWith("match")) &&
      referencedVariables.some((name) => next.includes(`$${name}`))
    ) {
      blockStatements.push(next);
      index += 1;
    }
    statementBlocks.push(blockStatements.join("\n"));
  }

  return statementBlocks;
}

function contextualBlockChunks(blocks, maxBlocks = 5) {
  if (blocks.length <= maxBlocks) {
    return [blocks.join("\n\n").trim()].filter(Boolean);
  }

  const declarationIndexByVariable = new Map();
  blocks.forEach((block, index) => {
    for (const variable of declaredVariablesForBlock(block)) {
      if (!declarationIndexByVariable.has(variable)) {
        declarationIndexByVariable.set(variable, index);
      }
    }
  });

  const chunks = [];
  for (let start = 0; start < blocks.length; start += maxBlocks) {
    const end = Math.min(start + maxBlocks, blocks.length);
    const selectedIndexes = new Set();
    for (let index = start; index < end; index += 1) {
      selectedIndexes.add(index);
    }

    const contextIndexes = new Set();
    const pending = [];
    for (let index = start; index < end; index += 1) {
      for (const variable of referencedVariablesForBlock(blocks[index])) {
        const declarationIndex = declarationIndexByVariable.get(variable);
        if (declarationIndex !== undefined && declarationIndex < start) {
          pending.push(declarationIndex);
        }
      }
    }

    while (pending.length > 0) {
      const declarationIndex = pending.pop();
      if (declarationIndex === undefined || selectedIndexes.has(declarationIndex) || contextIndexes.has(declarationIndex)) {
        continue;
      }
      contextIndexes.add(declarationIndex);
      for (const variable of referencedVariablesForBlock(blocks[declarationIndex])) {
        const dependencyIndex = declarationIndexByVariable.get(variable);
        if (
          dependencyIndex !== undefined
          && dependencyIndex < start
          && !selectedIndexes.has(dependencyIndex)
          && !contextIndexes.has(dependencyIndex)
        ) {
          pending.push(dependencyIndex);
        }
      }
    }

    const orderedIndexes = [...contextIndexes, ...selectedIndexes].sort((lhs, rhs) => lhs - rhs);
    chunks.push(orderedIndexes.map((index) => blocks[index]).join("\n\n").trim());
  }

  return chunks.filter(Boolean);
}

function splitWriteChunk(chunk, maxBlocks = 5) {
  const trimmed = chunk.trim();
  if (!/^put\b/m.test(trimmed) && !/^match\b/m.test(trimmed)) {
    return [trimmed];
  }

  const blocks = atomicWriteBlocks(trimmed);
  return contextualBlockChunks(blocks, maxBlocks);
}

function chunkingError(output) {
  return output.includes("broken pipe")
    || output.includes("stream closed")
    || output.includes("h2 protocol error");
}

async function applyWriteChunk(typedb, grpcPort, tempDir, databaseName, chunk, context, maxBlocks = 5) {
  const chunks = splitWriteChunk(chunk, maxBlocks);

  for (const [index, writeChunk] of chunks.entries()) {
    const stem = `${context.replaceAll(/[^A-Za-z0-9_-]+/g, "_")}-${maxBlocks}-${index + 1}`;
    const dataFile = path.join(tempDir, `${stem}.tql`);
    await fs.writeFile(dataFile, `${writeChunk}\n`, "utf8");
    const loadScript = path.join(tempDir, `${stem}-load.tql`);
    await fs.writeFile(
      loadScript,
      `transaction write ${databaseName}\n\nsource ${dataFile}\n\ncommit\n\nexit\n`,
      "utf8"
    );

    const load = runTypedbScript(typedb, grpcPort, loadScript, root);
    if (load.status === 0) {
      continue;
    }

    const output = `${load.stdout}\n${load.stderr}`;
    if (maxBlocks > 1 && chunkingError(output)) {
      await applyWriteChunk(typedb, grpcPort, tempDir, databaseName, writeChunk, `${context}-retry-${index + 1}`, Math.max(1, Math.floor(maxBlocks / 2)));
      continue;
    }

    assertCondition(false, `TypeDB data chunk load failed (${context} chunk ${index + 1}):\n${output}`);
  }
}

// ── Native TypeDB server ────────────────────────────────────────────

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
    server.on("error", reject);
  });
}

async function startTypedbServer(tempRoot) {
  const typedb = await resolveTypedbBinary();
  const grpcPort = await getFreePort();
  const httpPort = await getFreePort();
  const child = spawn(typedb, [
    "server",
    "--server.address", `127.0.0.1:${grpcPort}`,
    "--server.http.address", `127.0.0.1:${httpPort}`,
    "--server.admin.enabled", "false",
    "--storage.data-directory", path.join(tempRoot, "data"),
    "--logging.directory", path.join(tempRoot, "logs"),
    "--diagnostics.reporting.metrics", "false",
    "--diagnostics.reporting.errors", "false",
    "--diagnostics.monitoring.enabled", "false",
  ], { cwd: tempRoot, stdio: ["ignore", "pipe", "pipe"] });

  await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      reject(new Error(`TypeDB server did not become ready.\n${output}`));
    }, 15000);
    function onData(chunk) {
      output += chunk.toString();
      if (output.includes("Ready!")) {
        clearTimeout(timeout);
        resolve();
      }
    }
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`TypeDB server exited early with code ${code}.\n${output}`));
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  console.log(`TypeDB server ready (host port: ${grpcPort})`);
  return { child, grpcPort, typedb };
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.on("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

/**
 * Run a TypeDB console script against the isolated native server.
 */
function runTypedbScript(typedb, grpcPort, scriptPath, cwd) {
  return spawnSync(typedb, [
    "console",
    `--address=127.0.0.1:${grpcPort}`,
    "--username=admin",
    "--password=password",
    "--tls-disabled",
    "--script", scriptPath
  ], { cwd, encoding: "utf8" });
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  const orderedPackages = await resolvePackageOrder(root);
  const orderedNames = orderedPackages.map((item) => item.manifest.name);
  console.log(`Package order: ${orderedNames.join(" -> ")}`);

  const schemaAssets = [];
  const writeAssets = [];
  for (const pkg of orderedPackages) {
    for (const asset of classifyAssemblyAssets(pkg.manifest)) {
      const entry = { packageRoot: pkg.root, relativePath: asset.relativePath };
      if (asset.kind === "schema") {
        schemaAssets.push(entry);
      } else {
        writeAssets.push(entry);
      }
    }
  }

  const typedbTemp = await fs.mkdtemp(path.join(os.tmpdir(), "ontology-package-bootstrap-"));
  const databaseName = `ontology_pkg_${process.pid}`;

  const mergedSchema = path.join(typedbTemp, "merged-schema.tql");
  await writeMergedQueryFile("define", schemaAssets, mergedSchema);

  let typedbServer;
  try {
    typedbServer = await startTypedbServer(typedbTemp);

    // Load schema
    const schemaScript = path.join(typedbTemp, "schema-script.tql");
    await fs.writeFile(
      schemaScript,
      `database create ${databaseName}\n\ntransaction schema ${databaseName}\n\nsource ${mergedSchema}\n\ncommit\n\nexit\n`,
      "utf8"
    );
    const schemaResult = runTypedbScript(typedbServer.typedb, typedbServer.grpcPort, schemaScript, root);
    assertCondition(schemaResult.status === 0, `TypeDB schema load failed:\n${schemaResult.stdout}\n${schemaResult.stderr}`);
    console.log("Schema loaded");

    // Load data files
    for (const [index, asset] of writeAssets.entries()) {
      const text = await fs.readFile(path.join(asset.packageRoot, asset.relativePath), "utf8");
      const chunk = rewriteChunk(text, "insert", `write${index + 1}`);
      if (!chunk) continue;
      console.log(`Loading write asset ${index + 1}/${writeAssets.length} (${asset.relativePath})`);
      await applyWriteChunk(typedbServer.typedb, typedbServer.grpcPort, typedbTemp, databaseName, chunk, `asset-${index + 1}`);
    }
    console.log("Data loaded");

    // Verify provenance records
    for (const pkg of orderedPackages) {
      const packageName = pkg.manifest.name;
      const moduleRepoUrl = resolveModuleRepoUrl(pkg.manifest);
      assertCondition(typeof moduleRepoUrl === "string" && moduleRepoUrl.length > 0, `Missing module repo URL for ${packageName}`);
      const queryScript = path.join(typedbTemp, `query-${packageName}.tql`);
      await fs.writeFile(
        queryScript,
        `transaction read ${databaseName}\n\nmatch\n$module isa OntologyModule,\n  has moduleRepoUrl "${moduleRepoUrl}";\n$version isa OntologyModuleVersion;\n(version: $version, module: $module) isa ontologyModuleVersionOf;\nlimit 1;\n\nclose\n\nexit\n`,
        "utf8"
      );
      const query = runTypedbScript(typedbServer.typedb, typedbServer.grpcPort, queryScript, root);
      assertCondition(query.status === 0, `TypeDB provenance query failed for ${packageName}:\n${query.stdout}\n${query.stderr}`);
      assertCondition(
        query.stdout.includes("Finished. Total answers: 1"),
        `Expected OntologyModuleVersion row for ${packageName}:\n${query.stdout}`
      );
    }
  } finally {
    await stopProcess(typedbServer?.child);
    await fs.rm(typedbTemp, { recursive: true, force: true });
  }

  console.log("typedb bootstrap validation ok");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
