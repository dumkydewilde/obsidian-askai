#!/usr/bin/env node
// Copy the built plugin into a vault, for installing without BRAT and for
// iterating while developing.
//
//   npm run install-local -- "/path/to/vault"
//
// Then enable "Ask AI" under Settings, Community plugins. On later
// runs, reload the vault window (Cmd+R) to pick up the new build.

import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vault = process.argv[2];

if (!vault) {
	console.error('Usage: npm run install-local -- "/path/to/vault"');
	process.exit(2);
}

const obsidianDir = join(resolve(vault), ".obsidian");
try {
	await stat(obsidianDir);
} catch {
	console.error(`${obsidianDir} does not exist. Is that path an Obsidian vault?`);
	process.exit(1);
}

const target = join(obsidianDir, "plugins", "ask-ai");
await mkdir(target, { recursive: true });

for (const file of ["main.js", "manifest.json", "styles.css"]) {
	try {
		await copyFile(join(root, file), join(target, file));
	} catch (error) {
		if (file === "main.js") {
			console.error("main.js is missing. Run `npm run build` first.");
			process.exit(1);
		}
		throw error;
	}
}

console.log(`Installed to ${target}`);
console.log("Enable it under Settings, Community plugins, or reload the window if it is already enabled.");
