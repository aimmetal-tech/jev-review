import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { needsNpmPublish, readReleaseInfo } from "../scripts/release-info.ts";

function fixture(t: TestContext, version = "0.0.1") {
  const root = mkdtempSync(join(tmpdir(), "jev-release-info-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "jev-review", version, license: "MIT" }));
  writeFileSync(join(root, "CHANGELOG.md"), `# Changes\n\n## [Unreleased]\n\nFuture work\n\n## [${version}] - 2026-10-10\n\nRelease notes\n\n## [0.0.0]\n\nOlder notes\n`);
  return root;
}

test("release metadata requires an exact version tag and isolates its changelog section", t => {
  const root = fixture(t);
  assert.deepEqual(readReleaseInfo(root, "v0.0.1"), {
    version: "0.0.1", filename: "jev-review-0.0.1.tgz", npmTag: "latest", prerelease: false, notes: "Release notes",
  });
  for (const tag of ["v0.1.0", "main", "0.0.1", "v0.0.1\ninjected=true"]) {
    assert.throws(() => readReleaseInfo(root, tag), /tag must match/);
  }
});
test("prereleases use next and mark the GitHub release as a prerelease", t => {
  assert.equal(readReleaseInfo(fixture(t, "0.0.2-beta.1"), "v0.0.2-beta.1").npmTag, "next");
  assert.equal(readReleaseInfo(fixture(t, "0.0.2-beta.1"), "v0.0.2-beta.1").prerelease, true);
});
test("missing or empty release notes block publishing", t => {
  const root = fixture(t);
  for (const text of ["# Changes\n\n## [Unreleased]\n\nFuture work\n", "# Changes\n\n## [0.0.1]\n\n## [0.0.0]\n\nOld notes\n"]) {
    writeFileSync(join(root, "CHANGELOG.md"), text);
    assert.throws(() => readReleaseInfo(root, "v0.0.1"), /CHANGELOG/);
  }
});
test("incorrect package identity or license cannot be published by the release workflow", t => {
  const root = fixture(t);
  for (const metadata of [{ name: "other-package", version: "0.0.1", license: "MIT" }, { name: "jev-review", version: "0.0.1", license: "UNLICENSED" }]) {
    writeFileSync(join(root, "package.json"), JSON.stringify(metadata));
    assert.throws(() => readReleaseInfo(root, "v0.0.1"), /jev-review with the MIT/);
  }
});
test("npm retry skips only a byte-identical version and permits a missing version", async () => {
  assert.equal(await needsNpmPublish(new Response(null, { status: 404 }), "sha512-example"), true);
  assert.equal(await needsNpmPublish(Response.json({ dist: { integrity: "sha512-example" } }), "sha512-example"), false);
  await assert.rejects(needsNpmPublish(Response.json({ dist: { integrity: "sha512-different" } }), "sha512-example"), /different bytes/);
  await assert.rejects(needsNpmPublish(Response.json({}), "sha512-example"), /different bytes/);
});
test("npm outages or malformed registry responses do not become permission to publish", async () => {
  await assert.rejects(needsNpmPublish(new Response(null, { status: 503 }), "sha512-example"), /HTTP 503/);
  await assert.rejects(needsNpmPublish(new Response("not JSON"), "sha512-example"));
});
