import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const repository = "generaltranslation/inlang";
const packages = [
  {
    "name": "@inlang/cli",
    "directory": "packages/cli"
  },
  {
    "name": "@inlang/sdk",
    "directory": "packages/sdk"
  },
  {
    "name": "@inlang/marketplace-manifest",
    "directory": "packages/marketplace-manifest"
  },
  {
    "name": "@inlang/recommend-sherlock",
    "directory": "packages/recommendations/recommend-sherlock"
  },
  {
    "name": "@inlang/editor-component",
    "directory": "packages/ui-components/editor-component"
  },
  {
    "name": "@inlang/settings-component",
    "directory": "packages/ui-components/settings-component"
  },
  {
    "name": "@inlang/plugin-icu1",
    "directory": "packages/plugins/icu1"
  },
  {
    "name": "@inlang/plugin-t-function-matcher",
    "directory": "packages/plugins/t-function-matcher"
  },
  {
    "name": "@inlang/plugin-apple-strings",
    "directory": "packages/plugins/apple-strings"
  },
  {
    "name": "@inlang/plugin-i18next",
    "directory": "packages/plugins/i18next"
  },
  {
    "name": "@inlang/plugin-apple-xcstrings",
    "directory": "packages/plugins/apple-xcstrings"
  },
  {
    "name": "@inlang/plugin-m-function-matcher",
    "directory": "packages/plugins/m-function-matcher"
  },
  {
    "name": "@inlang/plugin-json",
    "directory": "packages/plugins/json"
  },
  {
    "name": "@inlang/plugin-android",
    "directory": "packages/plugins/android"
  },
  {
    "name": "@inlang/plugin-message-format",
    "directory": "packages/plugins/inlang-message-format"
  },
  {
    "name": "@inlang/plugin-next-intl",
    "directory": "packages/plugins/next-intl"
  }
];

// This allowlist deliberately excludes private examples, websites, and retired packages.
for (const entry of packages) {
  const manifest = JSON.parse(await readFile(path.join(root, entry.directory, "package.json"), "utf8"));
  assert.equal(manifest.name, entry.name);
  assert.notEqual(manifest.private, true);
  assert.equal(manifest.publishConfig?.access, "public");
  assert.equal(manifest.repository?.url.replace(/\.git$/, ""), `https://github.com/${repository}`);
}

if (process.argv.includes("--build")) {
  if (packages.some((entry) => entry.directory === ".")) {
    const rootBuild = spawnSync("pnpm", ["run", "build"], { cwd: root, stdio: "inherit" });
    assert.equal(rootBuild.status, 0, "Root package build failed");
  }
  const filters = packages.flatMap((entry) => ["--filter", `${entry.name}...`]);
  const result = spawnSync("pnpm", ["--recursive", ...filters, "--if-present", "--workspace-concurrency=2", "run", "build"], {
    cwd: root,
    env: { ...process.env, NX_NO_CLOUD: "true" },
    stdio: "inherit",
  });
  assert.equal(result.status, 0, "Published-package build failed");
} else if (process.argv.includes("--pack")) {
  const destination = await mkdtemp(path.join(tmpdir(), "inlang-package-verification-"));
  for (const entry of packages) {
    const before = new Set(await readdir(destination));
    const result = spawnSync("pnpm", ["pack", "--pack-destination", destination], {
      cwd: path.join(root, entry.directory),
      stdio: "inherit",
    });
    assert.equal(result.status, 0, `Packaging failed: ${entry.name}`);
    const archives = (await readdir(destination)).filter((name) => name.endsWith(".tgz") && !before.has(name));
    assert.equal(archives.length, 1, `Expected one new archive: ${entry.name}`);
    const archive = path.join(destination, archives[0]);
    const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
    assert.equal(listing.status, 0);
    const files = new Set(listing.stdout.trim().split("\n"));
    const extract = spawnSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" });
    assert.equal(extract.status, 0);
    const packed = JSON.parse(extract.stdout);
    const source = JSON.parse(await readFile(path.join(root, entry.directory, "package.json"), "utf8"));
    assert.equal(packed.name, entry.name);
    assert.equal(packed.version, source.version);
    assert.equal(packed.repository?.url.replace(/\.git$/, ""), `https://github.com/${repository}`);
    const collect = (value) => typeof value === "string" ? [value] :
      value && typeof value === "object" ? Object.values(value).flatMap(collect) : [];
    const targets = [packed.main, packed.module, packed.types, packed.typings,
      packed.unpkg, packed.jsdelivr, ...collect(packed.exports), ...collect(packed.bin)].filter(Boolean);
    for (const target of targets) {
      assert.ok(!target.includes("*"), `Add explicit wildcard archive validation: ${entry.name} ${target}`);
      assert.ok(files.has(`package/${target.replace(/^\.\//, "")}`), `Missing package entry: ${entry.name} ${target}`);
    }
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      assert.ok(!Object.values(packed[field] || {}).some((version) => version.startsWith("workspace:")), `Unresolved workspace dependency: ${entry.name}`);
    }
    console.log(`PASS ${entry.name}@${packed.version}: archive identity, repository, entry points, and workspace dependencies.`);
  }
  assert.equal((await readdir(destination)).filter((name) => name.endsWith(".tgz")).length, packages.length);
  console.log(`Verified ${packages.length} package archives without publishing.`);
} else if (process.argv.includes("--metadata-only")) {
  console.log(`Verified ${packages.length} package identities and repository URLs.`);
} else {
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  assert.ok(process.env.ACTIONS_ID_TOKEN_REQUEST_URL, "GitHub-hosted OIDC is required");
  assert.ok(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, "Missing GitHub OIDC authorization");
  let failures = 0;
  for (const entry of packages) {
    const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
    url.searchParams.set("audience", "npm:registry.npmjs.org");
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
      signal: AbortSignal.timeout(30_000),
    });
    assert.ok(response.ok, `OIDC request failed (HTTP ${response.status})`);
    const { value: idToken } = await response.json();
    assert.ok(idToken);
    const exchange = await fetch(`https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/${encodeURIComponent(entry.name)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${idToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (exchange.status !== 201) {
      // Error bodies can contain request context. Never print bearer tokens or raw bodies.
      console.error(`BLOCKED ${entry.name}: npm OIDC exchange HTTP ${exchange.status}`);
      failures++;
      await exchange.body?.cancel();
      continue;
    }
    const credential = await exchange.json();
    assert.equal(credential.token_type, "oidc");
    assert.ok(credential.token);
    console.log(`PASS ${entry.name}: npm accepted this workflow's trusted-publisher identity (no publish).`);
  }
  assert.equal(failures, 0, `${failures} package trusted publishers require configuration`);
}
