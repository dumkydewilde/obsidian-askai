#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runGit = promisify(execFile);
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const fail = (message) => {
	throw new Error(message);
};

const parseVersion = (value, label) => {
	if (typeof value !== "string") fail(`${label} must be a stable SemVer version`);
	const match = semver.exec(value);
	if (!match) fail(`${label} must be a stable SemVer version, got ${JSON.stringify(value)}`);
	return match.slice(1).map(Number);
};

const compareVersions = (left, right) => {
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) return left[index] - right[index];
	}
	return 0;
};

const readJson = async (name) => JSON.parse(await readFile(join(root, name), "utf8"));

const baseRevision = process.argv[2] === "--base" ? process.argv[3] : undefined;
if (!baseRevision || process.argv.length !== 4) {
	fail("usage: node scripts/check-version.mjs --base <git revision>");
}

const packageJson = await readJson("package.json");
const manifest = await readJson("manifest.json");
const lockfile = await readJson("package-lock.json");
const versions = await readJson("versions.json");

const currentVersion = packageJson.version;
const versionSources = [
	["manifest.json", manifest.version],
	["package-lock.json", lockfile.version],
	["package-lock.json packages[\"\"]", lockfile.packages?.[""].version],
];

for (const [name, version] of versionSources) {
	if (version !== currentVersion) {
		fail(`${name} has version ${JSON.stringify(version)}, expected ${JSON.stringify(currentVersion)}`);
	}
}

const currentParts = parseVersion(currentVersion, "package.json version");
if (typeof manifest.minAppVersion !== "string") fail("manifest.json minAppVersion must be a string");
if (versions[currentVersion] !== manifest.minAppVersion) {
	fail(
		`versions.json maps ${JSON.stringify(currentVersion)} to ${JSON.stringify(versions[currentVersion])}, expected ${JSON.stringify(manifest.minAppVersion)}`,
	);
}

const { stdout: basePackageJson } = await runGit("git", ["show", `${baseRevision}:package.json`], { cwd: root });
const baseVersion = JSON.parse(basePackageJson).version;
const baseParts = parseVersion(baseVersion, "base package.json version");
if (compareVersions(currentParts, baseParts) <= 0) {
	fail(`package.json version ${currentVersion} must be newer than base version ${baseVersion}`);
}

const { stdout: baseVersionsJson } = await runGit("git", ["show", `${baseRevision}:versions.json`], { cwd: root });
const baseVersions = JSON.parse(baseVersionsJson);
for (const [version, minAppVersion] of Object.entries(baseVersions)) {
	if (versions[version] !== minAppVersion) {
		fail(
			`versions.json changes inherited ${JSON.stringify(version)} from ${JSON.stringify(minAppVersion)} to ${JSON.stringify(versions[version])}`,
		);
	}
}

console.log(`version metadata is valid: ${baseVersion} -> ${currentVersion}`);
