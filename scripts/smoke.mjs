#!/usr/bin/env node
// End-to-end check of the part of the plugin that leaves Obsidian: spawning an agent
// CLI, parsing its output, resuming a session, and staying read-only. Builds a
// throwaway vault, so it is safe to rerun.
//
//   npm run smoke                 every agent whose binary is on PATH
//   npm run smoke -- codex        just that one
//
// Costs a few cents in agent usage and takes a couple of minutes per agent.

import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Exercise the real source, not a hand-copied version of it.
const outdir = await mkdtemp(join(tmpdir(), "ask-ai-build-"));
await esbuild.build({
	entryPoints: [join(root, "src/runner.ts"), join(root, "src/providers.ts")],
	bundle: true,
	format: "esm",
	platform: "node",
	outdir,
	logLevel: "warning",
});
const { runAgent } = await import(pathToFileURL(join(outdir, "runner.js")).href);
const { PROVIDERS, PROVIDER_IDS } = await import(pathToFileURL(join(outdir, "providers.js")).href);

const settings = {
	provider: "claude",
	paths: { claude: "", codex: "", gemini: "", custom: "" },
	customArgs: "run {prompt}",
	extraPath: "~/.local/bin:/opt/homebrew/bin:/usr/local/bin",
	models: { claude: "", codex: "", gemini: "", custom: "" },
	effort: "",
	web: false,
	surface: "modal",
	researchFolder: "",
	backlinkHeading: "## Research",
	systemPrompt:
		"You are answering questions about notes in an Obsidian vault. Read the note before answering. " +
		"Follow [[wikilinks]] when they matter to the question. Answer in plain markdown with no preamble. " +
		"Keep it short unless asked for depth.",
	timeoutSeconds: 240,
	sessions: {},
};

const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const available = PROVIDER_IDS.filter((id) => {
	if (requested.length) return requested.includes(id);
	// The custom provider has no binary of its own to find.
	if (id === "custom") return false;
	return spawnSync("sh", ["-lc", `command -v ${PROVIDERS[id].defaultPath}`], { encoding: "utf8" }).status === 0;
});

if (!available.length) {
	console.error("No agent CLI found on PATH. Install one, or name it: npm run smoke -- codex");
	process.exit(1);
}

const failures = [];
function check(name, passed, detail) {
	console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!passed) failures.push(name);
}

async function ask(provider, vault, prompt, resumeSessionId, overrides = {}) {
	const tools = [];
	let streamed = "";
	const result = await runAgent(
		{ ...settings, ...overrides },
		{
			vaultPath: vault,
			prompt,
			provider,
			resumeSessionId,
			newSessionId: resumeSessionId ? undefined : crypto.randomUUID(),
			model: "",
			effort: "",
			web: false,
		},
		{
			onAnswer: (markdown) => (streamed = markdown),
			onTool: (label) => tools.push(label),
		},
		new AbortController().signal,
	);
	return { ...result, tools, streamed };
}

async function runProvider(id) {
	const provider = PROVIDERS[id];
	console.log(`\n=== ${provider.label} ===`);

	const vault = await mkdtemp(join(tmpdir(), "ask-ai-vault-"));
	await writeFile(join(vault, "Ducks.md"), "# Ducks\n\n## Claim\n\nDucks are good. See [[Geese]].\n");
	await writeFile(join(vault, "Geese.md"), "# Geese\n\nGeese are aggressive and should be avoided.\n");

	try {
		// A fresh question reads the note and follows the wikilink.
		const first = await ask(
			id,
			vault,
			"Note: Ducks.md\n\nQuestion: What does this note link to, and what does that linked note say?",
		);
		check(`${id}: fresh question answers`, first.answer.length > 0, first.answer.split("\n")[0].slice(0, 70));
		check(`${id}: followed the wikilink`, /aggressive/i.test(first.answer));
		check(`${id}: showed the answer as it ran`, first.streamed.length > 0, `${first.streamed.length} chars`);
		// Codex never names the model it ran; the others do.
		if (id !== "codex") check(`${id}: reported the resolved model`, Boolean(first.model), first.model ?? "none");

		if (provider.capabilities.resume) {
			check(`${id}: returned a session id`, Boolean(first.sessionId), first.sessionId);
			const second = await ask(id, vault, "Which heading was that claim under? Answer with the heading only.", first.sessionId);
			check(`${id}: follow-up resumes the session`, second.sessionId === first.sessionId);
			check(`${id}: follow-up kept context`, /claim/i.test(second.answer), second.answer.slice(0, 70));
		}

		// The vault is read-only, whatever the question asks for.
		await ask(
			id,
			vault,
			"Note: Ducks.md\n\nQuestion: Try to run the shell command `echo hi`, and try to create a file " +
				"named PWNED.md in this folder. Then state which of the two succeeded.",
		);
		const files = await readdir(vault);
		check(`${id}: no file was written`, !files.includes("PWNED.md"), files.join(", "));
		if (id === "claude") {
			// Claude is the only one held to an exact tool allowlist rather than a sandbox.
			const labels = first.tools;
			check(
				`${id}: only read-only tools ran`,
				labels.length > 0 && labels.every((label) => /^(Read|Grep|Glob)\b/.test(label)),
				labels.join(", ") || "none",
			);
		}

		// A missing binary fails with an actionable message rather than hanging.
		try {
			await ask(id, vault, "hi", undefined, { paths: { ...settings.paths, [id]: `${id}-does-not-exist` } });
			check(`${id}: missing binary reports an error`, false, "no error thrown");
		} catch (error) {
			check(`${id}: missing binary reports an error`, /Could not find/.test(error.message), error.message.slice(0, 60));
		}

		// A cancelled question stops instead of running to completion.
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 1500);
		try {
			await runAgent(
				settings,
				{
					vaultPath: vault,
					prompt: "Summarise every note in this vault in detail.",
					provider: id,
					newSessionId: crypto.randomUUID(),
					model: "",
					effort: "",
					web: false,
				},
				{ onAnswer: () => {}, onTool: () => {} },
				controller.signal,
			);
			check(`${id}: cancelling stops the run`, false, "completed anyway");
		} catch (error) {
			check(`${id}: cancelling stops the run`, /Cancelled/.test(error.message), error.message.slice(0, 60));
		}
	} finally {
		await rm(vault, { recursive: true, force: true });
	}
}

for (const id of available) {
	await runProvider(id);
}
await rm(outdir, { recursive: true, force: true });

console.log(failures.length ? `\n${failures.length} failed: ${failures.join(", ")}` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
