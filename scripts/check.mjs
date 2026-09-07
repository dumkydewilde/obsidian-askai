#!/usr/bin/env node
// The parts that are worth pinning down without spending agent tokens: pulling the
// blocks the agent appends back out of an answer, mid-stream and once finished, and
// the conversation-note format — written, read back, and read back after an edit.
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
	entryPoints: [join(root, "src/trailing.ts"), join(root, "src/markdown.ts"), join(root, "src/document.ts")],
	bundle: true,
	format: "esm",
	platform: "node",
	outdir,
	logLevel: "warning",
});
const { splitTrailing, stripTrailing } = await import(pathToFileURL(join(outdir, "trailing.js")).href);
const { splitBlocks, alignBlocks } = await import(pathToFileURL(join(outdir, "markdown.js")).href);
const { formatConversation, appendTurns, setFields, parseConversation, safeName } = await import(
	pathToFileURL(join(outdir, "document.js")).href
);

let failed = 0;
function check(name, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failed++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
	if (!ok) console.log(`       want ${JSON.stringify(expected)}\n       got  ${JSON.stringify(actual)}`);
}

const answer = "The index is only consulted above 100k rows.\n\n## Sources\n\n- [[Lance notes]]";

check("no block", splitTrailing(answer), { answer, suggestions: [], title: "" });

check(
	"block at the end",
	splitTrailing(`${answer}\n\n\`\`\`follow-ups\nWhat builds the index?\nHow big does it get?\n\`\`\`\n`),
	{ answer, suggestions: ["What builds the index?", "How big does it get?"], title: "" },
);

check(
	"bulleted, numbered, and over the cap",
	splitTrailing(`${answer}\n\n\`\`\`follow-ups\n- One?\n2. Two?\n* Three?\n+ Four?\n\`\`\``).suggestions,
	["One?", "Two?", "Three?"],
);

check(
	"spelt followups, four backticks",
	splitTrailing(`${answer}\n\n\`\`\`\`followups\nOne?\n\`\`\`\``).suggestions,
	["One?"],
);

check("a fenced sql block is left alone", splitTrailing("Text\n\n```sql\nSELECT 1;\n```").suggestions, []);

check(
	"a code block that mentions follow-ups is left alone",
	splitTrailing("Text\n\n```\nfollow-ups are nice\n```").suggestions,
	[],
);

// Mid-stream: the block must never flash up as a code block before it is complete.
check("streaming, fence only", stripTrailing(`${answer}\n\n\`\`\``), answer);
check("streaming, tag half typed", stripTrailing(`${answer}\n\n\`\`\`follow`), answer);
check("streaming, tag complete", stripTrailing(`${answer}\n\n\`\`\`follow-ups`), answer);
check("streaming, first question in", stripTrailing(`${answer}\n\n\`\`\`follow-ups\nWhat builds it?`), answer);
check("streaming, block closed", stripTrailing(`${answer}\n\n\`\`\`follow-ups\nWhat builds it?\n\`\`\``), answer);
check("streaming, mid-answer prose", stripTrailing("Half a sen"), "Half a sen");
check("streaming, an sql block still renders", stripTrailing("Text\n\n```sql\nSELECT"), "Text\n\n```sql\nSELECT");

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
	alignBlocks(["The index is in Lance notes.", "Second one."],
		"The index is in [[Lance notes#Sources]].\n\nSecond one."),
	["The index is in [[Lance notes#Sources]].", "Second one."],
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

// The agent names the conversation in a second block, on its first answer only.
check(
	"a title block",
	splitTrailing(`${answer}\n\n\`\`\`title\nVector index cutoff\n\`\`\``),
	{ answer, suggestions: [], title: "Vector index cutoff" },
);

check(
	"both blocks, title last",
	splitTrailing(`${answer}\n\n\`\`\`follow-ups\nWhat builds it?\n\`\`\`\n\n\`\`\`title\nVector index\n\`\`\``),
	{ answer, suggestions: ["What builds it?"], title: "Vector index" },
);

check("streaming, title tag half typed", stripTrailing(`${answer}\n\n\`\`\`tit`), answer);
check("streaming, title block open", stripTrailing(`${answer}\n\n\`\`\`title\nVector`), answer);

// A title becomes a filename, and — with a folder per note — a note's name becomes a
// folder name. "a note with a question mark?" is a legal note name and an illegal
// folder name, which is what put this through safeName as well.
check("a question mark is dropped", safeName("a note with a question mark?"), "a note with a question mark");
check("so are the characters Obsidian rejects", safeName('a/b\\c:d*e?f"g<h>i|j#k^l[m]n'), "abcdefghijklmn");
check("a trailing period would double up with the one before md", safeName("Version 1."), "Version 1");
check("a long title is capped", safeName("x".repeat(80)).length, 61);
check("nothing left is still a name", safeName("###"), "conversation");

// A conversation is a note you can edit, so the format has to survive the round trip.
const fields = {
	source: '[[Lance notes]]',
	agent: "claude",
	session: "9c0f-1",
	created: "2026-09-07T10:04",
	updated: "2026-09-07T10:04",
	suggestions: ["Why is it per mode?"],
};
const turns = [
	{
		question: "What does CUTOFF do?",
		answer: "It is the per-mode similarity floor.\n\n## Sources\n\n- [[Lance notes#Cutoff]]",
		selection: "CUTOFF = 0.82",
		footer: "claude-opus-5 · 3.7s · 10.8k in · 173 out",
	},
];

const written = formatConversation(fields, turns);
check("the question is an H2", /^## What does CUTOFF do\?$/m.test(written), true);
check("the answer's own headings drop a level", /^### Sources$/m.test(written), true);
check("the selection is quoted", /^> CUTOFF = 0\.82$/m.test(written), true);
check("the follow-ups are frontmatter", /^follow_ups:\n {2}- "Why is it per mode\?"$/m.test(written), true);
check("one question needs no contents list", !written.includes("## Contents"), true);

const read = parseConversation(written);
check("frontmatter round-trips", { agent: read.agent, session: read.session, suggestions: read.suggestions }, {
	agent: "claude",
	session: "9c0f-1",
	suggestions: ["Why is it per mode?"],
});
check("turns round-trip", read.turns, turns);

const two = appendTurns(written, [{ question: "And above it?", answer: "Everything is returned.", footer: "Codex" }]);
const fenced = appendTurns(written, [
	{ question: "Show me the schema", answer: "```md\n## not a question\n```" },
]);
check("a fenced heading stays out of the contents", !/#not a question|# not a question\]\]/.test(fenced), true);
check("a fenced heading is not a contents entry", (fenced.match(/^- \[\[#/gm) ?? []).length, 2);

check("a second question grows a contents list", /^## Contents\n\n- \[\[#What does CUTOFF do\?\]\]\n- \[\[#And above it\?\]\]$/m.test(two), true);
check("appending keeps both turns", parseConversation(two).turns.length, 2);

const restamped = setFields(two, { updated: "2026-09-07T11:00", suggestions: ["Only this one?"] });
check("updated is rewritten in place", parseConversation(restamped).updated, "2026-09-07T11:00");
check("a timestamp is left bare, so it reads as a date", /^updated: 2026-09-07T11:00$/m.test(restamped), true);
// The items are lines of their own: replacing the key has to take them with it.
check("the old follow-ups are replaced, not joined", parseConversation(restamped).suggestions, ["Only this one?"]);
check("emptied follow-ups are dropped", parseConversation(setFields(two, { suggestions: [] })).suggestions, []);
check("a key of your own is left alone", setFields(two + "", { updated: "x" }).includes("type: ask-ai-conversation"), true);
check(
	"other frontmatter survives",
	setFields(two.replace("type: ask-ai-conversation", "type: ask-ai-conversation\ntags:\n  - research"), {
		updated: "x",
	}).includes("  - research"),
	true,
);

// Edited by hand: a heading with no answer, prose above the first question, a question
// whose answer someone rewrote. None of it may be dropped on the way back in.
const edited = [
	"---",
	"type: ask-ai-conversation",
	"session: abc",
	"---",
	"",
	"My own note about this thread.",
	"",
	"## What does CUTOFF do?",
	"",
	"Rewritten by hand.",
	"",
	"## A question I typed myself",
	"",
	"## Another",
	"",
	"With a fenced block:",
	"",
	"```md",
	"## not a question",
	"```",
	"",
].join("\n");
const parsed = parseConversation(edited);
check("prose above the first question is kept", parsed.preamble, "My own note about this thread.");
check("a hand-edited answer is read as the answer", parsed.turns[0].answer, "Rewritten by hand.");
check("a heading with no answer is still a turn", parsed.turns[1], {
	question: "A question I typed myself",
	answer: "",
	selection: null,
	footer: undefined,
});
check("a heading inside a fence is not a question", parsed.turns.length, 3);
check("the fenced heading stays in the answer", parsed.turns[2].answer.includes("## not a question"), true);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
