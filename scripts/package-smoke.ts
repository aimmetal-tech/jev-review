import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.resolve("jev-review/package.json")));
const metadata = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
assert.equal(metadata.name, "jev-review");
assert.equal(metadata.license, "MIT");
assert.match(readFileSync(resolve(root, "LICENSE"), "utf8"), /^MIT License/);
assert.match(readFileSync(resolve(root, "dsh/cordis.patch.yml"), "utf8"), /name: 'jev-review\/dsh'/);
for (const resource of ["jev-review/dsh/icon", "jev-review/dsh/locale/en.json", "jev-review/dsh/locale/zh.json"]) {
  assert.ok(existsSync(fileURLToPath(import.meta.resolve(resource))), resource);
}

const piEntry = resolve(root, metadata.pi.extensions[0]);
const loaderUrl = new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
const { loadExtensions } = await import(loaderUrl.href);
const loaded = await loadExtensions([piEntry], process.cwd());
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);
for (const event of ["tool_call", "session_start", "user_bash"]) {
  assert.ok(loaded.extensions[0].handlers.has(event), event);
}
assert.ok(loaded.extensions[0].commands.has("jev"));
const dshModule = "jev-review/dsh";
const dsh = await import(dshModule);
assert.equal(typeof dsh.apply, "function");
assert.equal(typeof dsh.Config, "function");
console.log(`Installed jev-review@${metadata.version}: Pi loader, DSH export, and package resources passed.`);
