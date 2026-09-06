#!/usr/bin/env node
// The parts that are worth pinning down without spending agent tokens: pulling the
// agent's suggested follow-ups back out of an answer, mid-stream and once finished.
//
//   npm run check

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = await mkdtemp(join(tmpdir(), "ask-ai-check-"));
await esbuild.build({
	entryPoints: [join(root, "src/suggestions.ts"), join(root, "src/markdown.ts")],
	bundle: true,
	format: "esm",
	platform: "node",
	outdir,
	logLevel: "warning",
});
const { splitSuggestions, stripSuggestions } = await import(pathToFileURL(join(outdir, "suggestions.js")).href);
const { splitBlocks, alignBlocks } = await import(pathToFileURL(join(outdir, "markdown.js")).href);

let failed = 0;
function check(name, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failed++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
	if (!ok) console.log(`       want ${JSON.stringify(expected)}\n       got  ${JSON.stringify(actual)}`);
}

const answer = "The index is only consulted above 100k rows.\n\n## Sources\n\n- [[Lance notes]]";

check("no block", splitSuggestions(answer), { answer, suggestions: [] });

check(
	"block at the end",
	splitSuggestions(`${answer}\n\n\`\`\`follow-ups\nWhat builds the index?\nHow big does it get?\n\`\`\`\n`),
	{ answer, suggestions: ["What builds the index?", "How big does it get?"] },
);

check(
	"bulleted, numbered, and over the cap",
	splitSuggestions(`${answer}\n\n\`\`\`follow-ups\n- One?\n2. Two?\n* Three?\n+ Four?\n\`\`\``).suggestions,
	["One?", "Two?", "Three?"],
);

check(
	"spelt followups, four backticks",
	splitSuggestions(`${answer}\n\n\`\`\`\`followups\nOne?\n\`\`\`\``).suggestions,
	["One?"],
);

check("a fenced sql block is left alone", splitSuggestions("Text\n\n```sql\nSELECT 1;\n```").suggestions, []);

check(
	"a code block that mentions follow-ups is left alone",
	splitSuggestions("Text\n\n```\nfollow-ups are nice\n```").suggestions,
	[],
);

// Mid-stream: the block must never flash up as a code block before it is complete.
check("streaming, fence only", stripSuggestions(`${answer}\n\n\`\`\``), answer);
check("streaming, tag half typed", stripSuggestions(`${answer}\n\n\`\`\`follow`), answer);
check("streaming, tag complete", stripSuggestions(`${answer}\n\n\`\`\`follow-ups`), answer);
check("streaming, first question in", stripSuggestions(`${answer}\n\n\`\`\`follow-ups\nWhat builds it?`), answer);
check("streaming, block closed", stripSuggestions(`${answer}\n\n\`\`\`follow-ups\nWhat builds it?\n\`\`\``), answer);
check("streaming, mid-answer prose", stripSuggestions("Half a sen"), "Half a sen");
check("streaming, an sql block still renders", stripSuggestions("Text\n\n```sql\nSELECT"), "Text\n\n```sql\nSELECT");

// Copying one block of an answer has to hand back that block's markdown, not its text.
check(
	"blocks split on blank lines",
	splitBlocks("One.\n\nTwo.\n\n\nThree."),
	["One.", "Two.", "Three."],
);

check(
	"a fence is one block, blank lines and all",
	splitBlocks("Before\n\n```sql\nSELECT 1;\n\nSELECT 2;\n```\n\nAfter"),
	["Before", "```sql\nSELECT 1;\n\nSELECT 2;\n```", "After"],
);

check(
	"a longer fence closes an inner one",
	splitBlocks("````\n```\nnested\n```\n````"),
	["````\n```\nnested\n```\n````"],
);

check(
	"a paragraph keeps its wikilink",
	alignBlocks(["The index is in LanceDB and motherduck research.", "Second one."],
		"The index is in [[LanceDB and motherduck research#Sources]].\n\nSecond one."),
	["The index is in [[LanceDB and motherduck research#Sources]].", "Second one."],
);

check(
	"a rendered list matches its source",
	alignBlocks(["one two"], "- one\n- two"),
	["- one\n- two"],
);

check(
	"an element with no matching block keeps its own text",
	alignBlocks(["Something else entirely"], "A paragraph.\n\nAnother."),
	["Something else entirely"],
);

check(
	"blocks stay in step after one that does not match",
	alignBlocks(["First.", "unrenderable", "Third."], "First.\n\nSecond.\n\nThird."),
	["First.", "unrenderable", "Third."],
);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
