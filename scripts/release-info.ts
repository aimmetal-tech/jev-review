import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface ReleaseInfo {
  version: string;
  filename: string;
  npmTag: "latest" | "next";
  prerelease: boolean;
  notes: string;
}

/** A tag may only release the exact version and notes checked into that tag. */
export function readReleaseInfo(root: string, tag: string): ReleaseInfo {
  const metadata = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  if (metadata.name !== "jev-review" || metadata.license !== "MIT") {
    throw new Error("Release package must be jev-review with the MIT license");
  }
  const version: unknown = metadata.version;
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version) || tag !== `v${version}`) {
    throw new Error("Release tag must match package.json version (v<version>)");
  }
  const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8").replace(/\r\n/g, "\n");
  const heading = new RegExp(`^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\](?:[^\\n]*)$`, "m").exec(changelog);
  if (!heading) throw new Error(`Missing CHANGELOG.md section for ${version}`);
  const notes = changelog.slice(heading.index + heading[0].length).split(/\n## /)[0].trim();
  if (!notes) throw new Error(`Empty CHANGELOG.md section for ${version}`);
  const prerelease = version.includes("-");
  return { version, filename: `jev-review-${version}.tgz`, npmTag: prerelease ? "next" : "latest", prerelease, notes };
}

/** Retry only an unpublished version; an existing version must contain the same bytes. */
export async function needsNpmPublish(response: Response, expectedIntegrity: string): Promise<boolean> {
  if (response.status === 404) return true;
  if (!response.ok) throw new Error(`Cannot verify npm release: HTTP ${response.status}`);
  const metadata = await response.json();
  if (metadata?.dist?.integrity !== expectedIntegrity) {
    throw new Error("The npm version already exists with different bytes; choose a new version");
  }
  return false;
}

async function main() {
  const root = process.cwd();
  const tag = process.env.RELEASE_TAG ?? process.argv[2];
  if (!tag) throw new Error("Set RELEASE_TAG or pass a v<version> tag");
  const info = readReleaseInfo(root, tag);
  mkdirSync(resolve(root, ".release"), { recursive: true });
  writeFileSync(resolve(root, ".release/notes.md"), `${info.notes}\n`);
  const outputs = [
    `version=${info.version}`, `filename=${info.filename}`, `npm_tag=${info.npmTag}`, `prerelease=${info.prerelease}`,
  ];
  if (process.argv.includes("--publish-status")) {
    const bytes = readFileSync(resolve(root, ".release", info.filename));
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const response = await fetch(`https://registry.npmjs.org/jev-review/${encodeURIComponent(info.version)}`, {
      redirect: "error", signal: AbortSignal.timeout(30000),
    });
    outputs.push(`publish_needed=${await needsNpmPublish(response, integrity)}`);
  }
  const output = `${outputs.join("\n")}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
