#!/usr/bin/env node
// Carry a version bump from package.json into the two files Obsidian actually reads.
// npm only knows about package.json, and the release workflow refuses to build a tag
// whose manifest disagrees with it, so without this a bump tags a release that never
// ships. Run by npm as the `version` lifecycle script, after package.json is bumped
// and before the commit is made:
//
//   npm version minor && git push --follow-tags
//
// manifest.json is what Obsidian installs against. versions.json is what it consults
// on an older app: it maps each plugin version to the oldest Obsidian that runs it,
// so a vault too old for the newest build is offered the newest build it can use.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Read rather than trusting npm_package_version, so running it by hand does the same
// thing as npm running it.
const read = async (name) => JSON.parse(await readFile(join(root, name), "utf8"));
// Two spaces and a trailing newline, which is how all three are already written.
const write = (name, value) => writeFile(join(root, name), `${JSON.stringify(value, null, 2)}\n`);

const { version } = await read("package.json");
const manifest = await read("manifest.json");
const versions = await read("versions.json");

if (manifest.version === version) {
	console.log(`manifest.json is already ${version}`);
	process.exit(0);
}

manifest.version = version;
versions[version] = manifest.minAppVersion;

await write("manifest.json", manifest);
await write("versions.json", versions);

console.log(`${version}, needing Obsidian ${manifest.minAppVersion} — manifest.json and versions.json`);
