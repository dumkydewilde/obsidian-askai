#!/usr/bin/env node
// Prints what the system prompt actually produces. The smoke suite proves the plumbing
// around an answer; this shows the answer itself, which is the only way to judge a
// change to the prompt. Runs the prompt against a real CLI over a fixed vault and a
// fixed set of questions, and writes one file per answer.
//
//   npm run answers                          the prompt in src/prompt.ts, every question
//   npm run answers -- draft.txt             a prompt you are trying, from a file
//   npm run answers -- current draft.txt     both, same questions, to read side by side
//   npm run answers -- --provider codex      a CLI other than claude
//   npm run answers -- --only 2-mixed        one question
//
// Answers land in .answers/<variant>--<question>.md. Costs a few cents per run.

import { mkdtemp, writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// A vault small enough to read in a minute, with the shapes a citation can take: a
// heading worth linking to, a wikilink to follow, and a note holding one bare fact.
const NOTES = {
	"Column stores.md": `---
tags: [storage]
---
# Column stores

## Why columns

A column store keeps each column contiguous on disk, so a query that touches three
columns of a hundred reads three columns of a hundred. Row stores read the whole row.

## Compression

Contiguous values of one type compress far better than a mixed row does. We measured
4.1x on the events table with zstd, against 1.6x for the same data as JSON rows.

## Where it hurts

Point updates. Rewriting one field means touching every column file that row lives in.
See [[Parquet]] for the file format we settled on.
`,
	"Parquet.md": `# Parquet

## Row groups

Parquet splits a file into row groups, each holding a chunk of every column. A reader
skips a whole row group when its min/max statistics rule the predicate out.

## Footer

The schema and the statistics live in a footer at the end of the file, so a reader
fetches the tail first and then only the pages it needs.
`,
	"Ingest notes.md": `# Ingest notes

Nightly load runs at 03:00 UTC. It writes one Parquet file per hour, no compaction yet.
`,
};

// One question per way an answer can be grounded, because that is what the prompt's
// rules about citation and length are actually about.
const QUESTIONS = [
	{
		id: "1-vault-only",
		note: "Column stores.md",
		text: "Why does this note say columnar data compresses better, and what number did we measure?",
	},
	{
		id: "2-mixed",
		note: "Column stores.md",
		text: "How does the compression story here compare to ORC?",
	},
	{
		id: "3-outside",
		note: "Ingest notes.md",
		text: "Should we compact these hourly files, and at what point does it start to matter?",
	},
	{
		id: "4-no-vault",
		note: "Ingest notes.md",
		text: "What is the usual way to give a nightly batch job idempotent retries?",
	},
	{
		id: "5-one-fact",
		note: "Parquet.md",
		text: "Where do the statistics live in a Parquet file?",
	},
];

const args = process.argv.slice(2);
function flag(name, fallback) {
	const at = args.indexOf(`--${name}`);
	if (at === -1) return fallback;
	return args.splice(at, 2)[1] ?? fallback;
}
const provider = flag("provider", "claude");
const only = flag("only", "").split(",").filter(Boolean);
const questions = only.length ? QUESTIONS.filter((question) => only.includes(question.id)) : QUESTIONS;
if (!questions.length) {
	console.error(`no such question. try: ${QUESTIONS.map((question) => question.id).join(", ")}`);
	process.exit(1);
}

// Exercise the real source, not a hand-copied version of it.
const outdir = await mkdtemp(join(tmpdir(), "ask-ai-answers-build-"));
await esbuild.build({
	entryPoints: [join(root, "src/runner.ts"), join(root, "src/prompt.ts")],
	bundle: true,
	format: "esm",
	platform: "node",
	outdir,
	logLevel: "warning",
});
const { runAgent } = await import(pathToFileURL(join(outdir, "runner.js")).href);
const { DEFAULT_SYSTEM_PROMPT } = await import(pathToFileURL(join(outdir, "prompt.js")).href);

const variants = await Promise.all(
	(args.length ? args : ["current"]).map(async (arg) => ({
		name: arg === "current" ? "current" : basename(arg).replace(/\.[^.]+$/, ""),
		prompt: (arg === "current" ? DEFAULT_SYSTEM_PROMPT : await readFile(arg, "utf8")).trim(),
	})),
);

const settings = {
	provider,
	paths: { claude: "", codex: "", gemini: "", custom: "" },
	customArgs: "run {prompt}",
	extraPath: "~/.local/bin:/opt/homebrew/bin:/usr/local/bin",
	models: { claude: "", codex: "", gemini: "", custom: "" },
	effort: "",
	web: false,
	surface: "modal",
	conversationLocation: "folder",
	conversationFolder: "askai-conversations",
	conversationSubfolder: true,
	keepInVault: true,
	backlinkHeading: "## Research",
	systemPrompt: "",
	timeoutSeconds: 300,
};

const answers = join(root, ".answers");
await mkdir(answers, { recursive: true });

// A vault each, so a question that follows a wikilink cannot see another one's state.
async function run(variant, question) {
	const vault = await mkdtemp(join(tmpdir(), "ask-ai-answers-vault-"));
	for (const [name, body] of Object.entries(NOTES)) await writeFile(join(vault, name), body);
	try {
		const { answer } = await runAgent(
			{ ...settings, systemPrompt: variant.prompt },
			{
				vaultPath: vault,
				prompt: `Note: ${question.note}\n\nQuestion: ${question.text}`,
				provider,
				newSessionId: crypto.randomUUID(),
				firstTurn: true,
				model: "",
				effort: "",
				web: false,
			},
			{ onAnswer: () => {}, onTool: () => {} },
			new AbortController().signal,
		);
		await writeFile(join(answers, `${variant.name}--${question.id}.md`), answer);
		console.log(`ok   ${variant.name} ${question.id}  ${answer.split(/\s+/).length} words`);
	} catch (error) {
		console.log(`FAIL ${variant.name} ${question.id}  ${error.message}`);
	} finally {
		await rm(vault, { recursive: true, force: true });
	}
}

await Promise.all(variants.flatMap((variant) => questions.map((question) => run(variant, question))));
await rm(outdir, { recursive: true, force: true });
console.log(`\n.answers/`);
