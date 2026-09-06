#!/usr/bin/env node
// Pull the CSS the sidebar actually lands in — Obsidian's own app.css and the vault's
// theme — out of the installed app, so harness/index.html renders against the real
// cascade instead of a guess. Obsidian keeps app.css inside an asar archive.
//
//   node harness/prepare.mjs [/path/to/vault]

import { existsSync, mkdirSync, openSync, readSync, readFileSync, copyFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";

const assets = resolve(dirname(fileURLToPath(import.meta.url)), "assets");
mkdirSync(assets, { recursive: true });

/** The newest asar wins: Obsidian self-updates into Application Support, not /Applications. */
function findAsar() {
	const support = join(homedir(), "Library/Application Support/obsidian");
	const updates = existsSync(support)
		? readdirSync(support)
				.filter((name) => /^obsidian-[\d.]+\.asar$/.test(name))
				.sort()
				.map((name) => join(support, name))
		: [];
	const bundled = "/Applications/Obsidian.app/Contents/Resources/obsidian.asar";
	const candidate = updates.pop() ?? (existsSync(bundled) ? bundled : null);
	if (!candidate) throw new Error("No Obsidian asar found. Is Obsidian installed?");
	return candidate;
}

function readFromAsar(archive, name) {
	const fd = openSync(archive, "r");
	const prefix = Buffer.alloc(16);
	readSync(fd, prefix, 0, 16, 0);
	const headerSize = prefix.readUInt32LE(12);
	const headerBuffer = Buffer.alloc(headerSize);
	readSync(fd, headerBuffer, 0, headerSize, 16);
	const entry = JSON.parse(headerBuffer.toString("utf8")).files[name];
	if (!entry) throw new Error(`${name} is not in ${archive}`);
	const out = Buffer.alloc(Number(entry.size));
	readSync(fd, out, 0, out.length, 16 + headerSize + Number(entry.offset));
	return out;
}

const archive = findAsar();
writeFileSync(join(assets, "app.css"), readFromAsar(archive, "app.css"));
console.log(`app.css from ${archive}`);

const vaultsFile = join(homedir(), "Library/Application Support/obsidian/obsidian.json");
const vault =
	process.argv[2] ??
	Object.values(JSON.parse(readFileSync(vaultsFile, "utf8")).vaults).find((v) => v.open)?.path;

// The plugin's own settings, so the harness mounts against real note paths and a real
// remembered session rather than a shape somebody invented.
const settings = vault ? join(vault, ".obsidian/plugins/ask-ai/data.json") : null;
if (settings && existsSync(settings)) copyFileSync(settings, join(assets, "data.json"));
else writeFileSync(join(assets, "data.json"), JSON.stringify({ sessions: {} }));

let theme = "";
let fontSize = 16;
if (vault && existsSync(join(vault, ".obsidian/appearance.json"))) {
	const appearance = JSON.parse(readFileSync(join(vault, ".obsidian/appearance.json"), "utf8"));
	fontSize = appearance.baseFontSize ?? 16;
	const themeCss = join(vault, ".obsidian/themes", appearance.cssTheme ?? "", "theme.css");
	if (appearance.cssTheme && existsSync(themeCss)) {
		copyFileSync(themeCss, join(assets, "theme.css"));
		theme = appearance.cssTheme;
	}
}
if (!theme) writeFileSync(join(assets, "theme.css"), "/* no community theme */\n");
writeFileSync(join(assets, "vault.json"), JSON.stringify({ theme, fontSize, vault: vault ?? null }, null, 2));
console.log(`theme ${theme || "(default)"}, base font size ${fontSize}px`);
