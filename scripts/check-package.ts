import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { transform } from "esbuild";

const root = process.cwd();
const output = resolve(root, ".release");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run package verification with npm run check:package");
const temp = mkdtempSync(join(tmpdir(), "jev-review-package-"));

function run(command: string, args: string[], cwd: string, capture = false): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture) process.stderr.write(`${result.stdout ?? ""}${result.stderr ?? ""}`);
    throw new Error(`${command} failed (${result.status})`);
  }
  return result.stdout ?? "";
}

try {
  mkdirSync(output, { recursive: true });
  const [packed] = JSON.parse(run(process.execPath, [npmCli, "pack", "--json", "--silent", "--pack-destination", output], root, true));
  const metadata = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assert.equal(packed.name, "jev-review");
  assert.equal(packed.version, metadata.version);
  assert.equal(packed.filename, `jev-review-${metadata.version}.tgz`);
  const paths = new Set<string>(packed.files.map((file: { path: string }) => file.path));
  for (const path of ["package.json", "README.md", "LICENSE", "CHANGELOG.md", "docs/RELEASING.md", "src/adapters/pi.ts", "src/adapters/dsh.ts", "src/reviewer.ts", "dist/dsh.js", "dsh/cordis.patch.yml", "dsh/icon.svg", "dsh/locale/en.json", "dsh/locale/zh.json"]) {
    assert.ok(paths.has(path), `Missing package resource: ${path}`);
  }
  for (const path of paths) {
    assert.ok(!/(?:^|\/)(?:node_modules|test|scripts|\.github|\.git|\.env(?:\.[^/]*)?)(?:\/|$)/.test(path), `Unexpected package file: ${path}`);
  }
  const tarball = resolve(output, packed.filename);
  const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  writeFileSync(resolve(output, "SHA256SUMS"), `${sha256}  ${basename(tarball)}\n`);

  writeFileSync(join(temp, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const hosts = Object.entries(metadata.devDependencies as Record<string, string>)
    .filter(([name]) => name.startsWith("@deepseek-ai/") || name === "@earendil-works/pi-coding-agent")
    .map(([name, version]) => `${name}@${version}`);
  // Install the actual tarball in a clean directory, without the project's dev tools.
  run(process.execPath, [npmCli, "install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--package-lock=false", tarball, ...hosts], temp);
  const installed = resolve(temp, "node_modules/jev-review");
  const smoke = await transform(readFileSync(resolve(root, "scripts/package-smoke.ts"), "utf8"), { loader: "ts", format: "esm", target: "node22" });
  writeFileSync(join(temp, "package-smoke.mjs"), smoke.code);
  run(process.execPath, ["package-smoke.mjs"], temp);

  // Native Node type stripping is intentionally disabled inside node_modules.
  // Compile only the installed core used by the fixture to make its Choice responses.
  const fixtureCore = await transform(readFileSync(join(installed, "src/reviewer.ts"), "utf8"), { loader: "ts", format: "esm", target: "node22" });
  writeFileSync(join(temp, "fixture-reviewer.mjs"), fixtureCore.code);
  const nativeSource = readFileSync(resolve(root, "test/dsh-native.test.ts"), "utf8")
    .replace('"../src/adapters/dsh.ts"', '"jev-review/dsh"')
    .replace('"../src/reviewer.ts"', '"./fixture-reviewer.mjs"');
  const native = await transform(nativeSource, { loader: "ts", format: "esm", target: "node22" });
  writeFileSync(join(temp, "dsh-native-smoke.mjs"), native.code);
  run(process.execPath, ["--experimental-strip-types", "dsh-native-smoke.mjs"], temp);
  console.log(`Verified release archive: ${tarball}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
