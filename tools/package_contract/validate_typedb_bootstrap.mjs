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
    kind: schemaAssets.has(assetPath) ? "schema" : "write",
  }));
}

function rewriteChunk(text, keyword, variablePrefix) {
  let chunk = text.replace(/^#.*\n/gm, "");
  chunk = chunk.replace(new RegExp(`^\\s*${keyword}\\s*\\n`, "i"), "");
  chunk = chunk.replace(/\$([A-Za-z][A-Za-z0-9_]*)/g, `\$${variablePrefix}_$1`);
  return chunk.trim();
}

function splitWriteChunk(chunk, maxBlocks = 25) {
  const trimmed = chunk.trim();
  if (!/^put\b/m.test(trimmed)) {
    return [trimmed];
  }

  const declaredVariablesForBlock = (block) =>
    [...block.matchAll(/\$([A-Za-z][A-Za-z0-9_]*)\s+isa\b/g)].map((match) => match[1]);

  const collectLeadingPreamble = (blocks) => {
    const preamble = [];
    let index = 0;

    while (index < blocks.length) {
      const block = blocks[index];
      const declared = declaredVariablesForBlock(block);
      if (declared.length === 0) break;

      const laterBlocks = blocks.slice(index + 1);
      const shared = declared.some((name) => laterBlocks.some((later) => later.includes(`$${name}`)));
      if (!shared) break;

      preamble.push(block);
      index += 1;
    }

    return { preamble, payload: blocks.slice(index) };
  };

  const blocks = trimmed
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.length > 1) {
    const grouped = [];
    const { preamble, payload: payloadBlocks } = collectLeadingPreamble(blocks);

    for (let index = 0; index < payloadBlocks.length; index += maxBlocks) {
      const group = payloadBlocks.slice(index, index + maxBlocks);
      grouped.push((preamble.length > 0 ? [...preamble, ...group] : group).join("\n\n").trim());
    }
    return grouped;
  }

  const statements = trimmed.match(/[\s\S]*?;/g) ?? [];
  if (statements.length === 0) {
    return [trimmed];
  }

  const statementBlocks = [];
  for (let index = 0; index < statements.length; index++) {
    const current = statements[index].trim();
    const declaredVariables = [...current.matchAll(/\$([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1]);
    const blockStatements = [current];
    const next = statements[index + 1]?.trim();
    if (
      next &&
      next.startsWith("put (") &&
      declaredVariables.some((name) => next.includes(`$${name}`))
    ) {
      blockStatements.push(next);
      index += 1;
    }
    statementBlocks.push(blockStatements.join("\n"));
  }

  const { preamble, payload: payloadStatements } = collectLeadingPreamble(statementBlocks);
  const grouped = [];
  for (let index = 0; index < payloadStatements.length; index += maxBlocks) {
    const group = payloadStatements.slice(index, index + maxBlocks).map((statement) => statement.trim());
    grouped.push((preamble.length > 0 ? [...preamble, ...group] : group).join("\n").trim());
  }
  return grouped;
}

async function writeMergedQueryFile(keyword, assets, outPath) {
  const chunks = [];

  for (const [index, asset] of assets.entries()) {
    let text = await fs.readFile(path.join(asset.packageRoot, asset.relativePath), "utf8");
    text = rewriteChunk(text, keyword, `${keyword}${index + 1}`);
    if (text) chunks.push(text);
  }

  // If chunks contain put-prefixed statements, emit them directly
  // (each put is a self-contained write statement, no insert wrapper needed)
  const hasPut = chunks.some((chunk) => /^put /m.test(chunk));
  const merged = hasPut
    ? `${chunks.join("\n\n")}\n`
    : `${keyword}\n\n${chunks.join("\n\n")}\n`;
  await fs.writeFile(outPath, merged, "utf8");
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
    server.on("error", reject);
  });
}

async function startTypedbServer(tempRoot) {
  const typedb = process.env.TYPEDB_BIN ?? path.join(process.env.HOME ?? "", ".typedb", "typedb");
  await fs.access(typedb);

  const grpcPort = await getFreePort();
  const httpPort = await getFreePort();
  const args = [
    "server",
    "--server.address",
    `127.0.0.1:${grpcPort}`,
    "--server.http.address",
    `127.0.0.1:${httpPort}`,
    "--storage.data-directory",
    path.join(tempRoot, "data"),
    "--logging.directory",
    path.join(tempRoot, "logs"),
    "--diagnostics.reporting.metrics",
    "false",
    "--diagnostics.reporting.errors",
    "false",
    "--diagnostics.monitoring.enabled",
    "false",
  ];

  const child = spawn(typedb, args, { cwd: tempRoot, stdio: ["ignore", "pipe", "pipe"] });

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

function runTypedbScript(typedb, grpcPort, scriptPath, cwd) {
  return spawnSync(
    typedb,
    [
      "console",
      `--address=127.0.0.1:${grpcPort}`,
      "--username=admin",
      "--password=password",
      "--tls-disabled",
      "--script",
      scriptPath,
    ],
    { cwd, encoding: "utf8" },
  );
}

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
  const mergedSchema = path.join(typedbTemp, "merged-schema.tql");
  const databaseName = `ontology_pkg_${process.pid}`;

  await writeMergedQueryFile("define", schemaAssets, mergedSchema);

  // Prepare individual data files with variable-prefix namespacing
  const dataFiles = [];
  for (const [index, asset] of writeAssets.entries()) {
    const text = await fs.readFile(path.join(asset.packageRoot, asset.relativePath), "utf8");
    const chunk = rewriteChunk(text, "insert", `write${index + 1}`);
    if (chunk) {
      for (const [fragmentIndex, fragment] of splitWriteChunk(chunk).entries()) {
        const dataFile = path.join(typedbTemp, `data-${index + 1}-${fragmentIndex + 1}.tql`);
        await fs.writeFile(dataFile, `${fragment}\n`, "utf8");
        dataFiles.push(dataFile);
      }
    }
  }

  let typedbServer;
  try {
    typedbServer = await startTypedbServer(typedbTemp);

    // Step 1: Create database and load schema
    const schemaScript = path.join(typedbTemp, "schema-script.tql");
    await fs.writeFile(schemaScript, `database create ${databaseName}\n\ntransaction schema ${databaseName}\n\nsource ${mergedSchema}\n\ncommit\n\nexit\n`, "utf8");
    const schemaResult = runTypedbScript(typedbServer.typedb, typedbServer.grpcPort, schemaScript, root);
    assertCondition(schemaResult.status === 0, `TypeDB schema load failed:\n${schemaResult.stdout}\n${schemaResult.stderr}`);

    // Step 2: Load each data file in its own write transaction
    for (const dataFile of dataFiles) {
      const loadScript = path.join(typedbTemp, `load-${path.basename(dataFile)}.tql`);
      await fs.writeFile(loadScript, `transaction write ${databaseName}\n\nsource ${dataFile}\n\ncommit\n\nexit\n`, "utf8");
      const load = runTypedbScript(typedbServer.typedb, typedbServer.grpcPort, loadScript, root);
      assertCondition(load.status === 0, `TypeDB data load failed for ${path.basename(dataFile)}:\n${load.stdout}\n${load.stderr}`);
    }

    for (const pkg of orderedPackages) {
      const packageName = pkg.manifest.name;
      const moduleRepoUrl = resolveModuleRepoUrl(pkg.manifest);
      assertCondition(typeof moduleRepoUrl === "string" && moduleRepoUrl.length > 0, `Missing module repo URL for ${packageName}`);
      const queryScript = path.join(typedbTemp, `query-${packageName}.tql`);
      await fs.writeFile(
        queryScript,
        `transaction read ${databaseName}\n\nmatch\n$module isa OntologyModule,\n  has moduleRepoUrl "${moduleRepoUrl}";\n$version isa OntologyModuleVersion;\n(version: $version, module: $module) isa ontologyModuleVersionOf;\nlimit 1;\n\nclose\n\nexit\n`,
        "utf8",
      );
      const query = runTypedbScript(typedbServer.typedb, typedbServer.grpcPort, queryScript, root);
      assertCondition(query.status === 0, `TypeDB provenance query failed for ${packageName}:\n${query.stdout}\n${query.stderr}`);
      assertCondition(
        query.stdout.includes("Finished. Total answers: 1"),
        `Expected OntologyModuleVersion row for ${packageName}:\n${query.stdout}`,
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
