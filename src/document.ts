/**
 * The file format for a conversation, and reading it back. A conversation is a note in
 * the vault — you can edit it, move it, delete it — so the format is plain `## question`
 * sections rather than anything you would not want to touch, and the parser puts
 * anything it does not recognise into the answer instead of dropping it.
 *
 * No Obsidian imports: `npm run check` runs this without an app.
 */

export interface DocTurn {
	question: string;
	answer: string;
	/** The passage the question was asked about, when it was asked about one. */
	selection?: string | null;
	/** The line under the question: which model, how long, tokens in and out. */
	footer?: string;
}

/** What the markdown cannot carry: which agent holds the thread, and which thread. */
export interface DocFields {
	/** A wikilink to the note the conversation is about. */
	source: string;
	agent: string;
	session: string;
	created: string;
	updated: string;
	/** The next questions offered under the newest answer. */
	suggestions: string[];
}

export interface ParsedConversation {
	agent: string;
	session: string;
	created: string;
	updated: string;
	suggestions: string[];
	/** Anything written above the first question, kept and shown rather than dropped. */
	preamble: string;
	turns: DocTurn[];
}

export const CONVERSATION_TYPE = "ask-ai-conversation";
const CONTENTS_HEADING = "## Contents";
const ANSWERED_BY = /^\*Answered by (.+)\*$/;

/** A whole conversation note, for the first write. */
export function formatConversation(fields: DocFields, turns: DocTurn[]): string {
	return withContents(`${frontmatter(fields)}\n${turns.map(section).join("\n\n")}\n`);
}

/** Later answers are appended, so an edit to an earlier one is never overwritten. */
export function appendTurns(content: string, turns: DocTurn[]): string {
	if (!turns.length) return content;
	return withContents(`${content.trimEnd()}\n\n${turns.map(section).join("\n\n")}\n`);
}

/**
 * Rewrite the frontmatter keys this plugin owns, leaving any other key — a tag, a
 * status, whatever the vault's own conventions add — where it is.
 */
export function setFields(content: string, fields: Partial<DocFields>): string {
	const { body, lines } = splitFrontmatter(content);
	// Rewritten in place where the key is already there, so hand-ordering survives;
	// anything new goes on the end.
	const merged: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const key = ownedKey(lines[i]);
		if (!key || !(key in fields)) {
			merged.push(lines[i]);
			continue;
		}
		merged.push(...fieldLines(key, fields));
		// A list's items are lines of their own, and belong to the key being replaced.
		while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) i++;
	}
	for (const key of Object.keys(fields) as (keyof DocFields)[]) {
		if (!lines.some((line) => ownedKey(line) === key)) merged.push(...fieldLines(key, fields));
	}
	if (!lines.length) merged.unshift(`type: ${CONVERSATION_TYPE}`);
	return `---\n${merged.join("\n")}\n---\n\n${body.replace(/^\n+/, "")}`;
}

/**
 * The conversation as it is on disk. Forgiving on purpose: a heading it cannot place
 * still becomes a question, a section with no answer still becomes a turn, and prose
 * above the first question is kept rather than thrown away.
 */
export function parseConversation(content: string): ParsedConversation {
	const { body, lines } = splitFrontmatter(content);
	const front = readFrontmatter(lines);

	const sections = splitSections(body);
	const preamble = sections.preamble.trim();
	const turns: DocTurn[] = [];
	for (const { heading, lines: sectionLines } of sections.sections) {
		if (heading.trim().toLowerCase() === "contents") continue;
		turns.push(readSection(heading, sectionLines));
	}

	return {
		agent: front.agent ?? "",
		session: front.session ?? "",
		created: front.created ?? "",
		updated: front.updated ?? front.created ?? "",
		suggestions: front.follow_ups ?? [],
		preamble,
		turns,
	};
}

/** Whether a file is one of ours, from its frontmatter as Obsidian parsed it. */
export function isConversation(frontmatter: Record<string, unknown> | undefined): boolean {
	return frontmatter?.type === CONVERSATION_TYPE;
}

/* ---------------- writing ---------------- */

function frontmatter(fields: DocFields): string {
	const lines = [
		"---",
		// A property a Base can filter on, so conversations can be listed as a table
		// without a folder query.
		`type: ${CONVERSATION_TYPE}`,
		...(["source", "agent", "session", "created", "updated", "suggestions"] as (keyof DocFields)[]).flatMap((key) =>
			fieldLines(key, fields),
		),
		"---",
		"",
	];
	return lines.join("\n");
}

const KEYS: Record<string, keyof DocFields> = {
	source: "source",
	agent: "agent",
	session: "session",
	created: "created",
	updated: "updated",
	follow_ups: "suggestions",
};

/** The frontmatter key a line sets, when it is one this plugin writes. */
function ownedKey(line: string): keyof DocFields | null {
	const name = line.match(/^([A-Za-z_][\w-]*):/)?.[1];
	return name && name in KEYS ? KEYS[name] : null;
}

function fieldLines(key: keyof DocFields, fields: Partial<DocFields>): string[] {
	const value = fields[key];
	if (value === undefined) return [];
	if (key === "suggestions") {
		const list = value as string[];
		return list.length ? ["follow_ups:", ...list.map((item) => `  - ${quote(item)}`)] : [];
	}
	return [`${key}: ${quote(String(value))}`];
}

/**
 * Quoted unless it is plainly safe, because a question ends in "?" and can hold ":".
 * Timestamps are left bare so Obsidian reads `updated` as a date rather than a string.
 */
function quote(value: string): string {
	return /^[\w.@/:-]+$/.test(value) ? value : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function section(turn: DocTurn): string {
	const parts = [`## ${heading(turn.question)}`];
	if (turn.selection?.trim()) parts.push(blockquote(turn.selection.trim()));
	parts.push(demoteHeadings(turn.answer.trim()));
	if (turn.footer) parts.push(`*Answered by ${turn.footer}*`);
	return parts.join("\n\n");
}

/** The passage a question was asked about, kept with it so the answer still reads. */
function blockquote(selection: string): string {
	return selection
		.split("\n")
		.map((line) => `> ${line}`.trimEnd())
		.join("\n");
}

/**
 * A table of contents of same-note heading links, rebuilt on every write. Only worth
 * the space once a conversation has more than one question in it.
 */
function withContents(content: string): string {
	const lines = content.split("\n");
	const existing = lines.findIndex((line) => line.trim() === CONTENTS_HEADING);
	if (existing !== -1) {
		let end = existing + 1;
		while (end < lines.length && !/^##\s/.test(lines[end])) end++;
		lines.splice(existing, end - existing);
		while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
	}

	// Fence-aware, like the parser: a `## ` line inside a code block in an answer is not
	// a question, and listing it would put a link to nowhere in the contents.
	const questions: string[] = [];
	let inFence = false;
	for (const line of lines) {
		if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
		if (inFence || !/^##\s/.test(line) || line.trim() === CONTENTS_HEADING) continue;
		questions.push(line.replace(/^##\s+/, "").trim());
	}
	if (questions.length < 2) return `${lines.join("\n").trimEnd()}\n`;

	const toc = [CONTENTS_HEADING, "", ...questions.map((q) => `- [[#${q}]]`), ""];
	// After the frontmatter if there is one, otherwise at the very top.
	let insertAt = 0;
	if (lines[0]?.trim() === "---") {
		const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
		if (close !== -1) insertAt = close + 1;
	}
	while (lines[insertAt]?.trim() === "") insertAt++;
	lines.splice(insertAt, 0, ...toc);
	return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * The question is an H2, so the answer's own headings (its Sources section, most of
 * all) have to sit below that or the note's outline comes out flat, with every
 * answer's Sources as a sibling of every question.
 */
function demoteHeadings(markdown: string): string {
	return mapOutsideFences(markdown, (line) => (/^(#{1,5})\s/.test(line) ? `#${line}` : line));
}

function promoteHeadings(markdown: string): string {
	return mapOutsideFences(markdown, (line) => (/^(#{3,6})\s/.test(line) ? line.slice(1) : line));
}

function mapOutsideFences(markdown: string, fn: (line: string) => string): string {
	let inFence = false;
	return markdown
		.split("\n")
		.map((line) => {
			if (/^\s*(```|~~~)/.test(line)) {
				inFence = !inFence;
				return line;
			}
			return inFence ? line : fn(line);
		})
		.join("\n");
}

/** `#`, `[`, `]` and `|` in a heading break the [[#heading]] links in the contents. */
function heading(question: string): string {
	return oneLine(question.replace(/[#[\]|^]/g, "")) || "Question";
}

export function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/* ---------------- reading ---------------- */

function splitFrontmatter(content: string): { lines: string[]; body: string } {
	const normalised = content.replace(/\r\n/g, "\n");
	if (!normalised.startsWith("---\n")) return { lines: [], body: normalised };
	const end = normalised.indexOf("\n---", 3);
	if (end === -1) return { lines: [], body: normalised };
	const lines = normalised.slice(4, end + 1).split("\n").filter((line) => line !== "");
	const after = normalised.indexOf("\n", end + 1);
	return { lines, body: after === -1 ? "" : normalised.slice(after + 1) };
}

/** Enough YAML for what this plugin writes: scalars, and one list of strings. */
function readFrontmatter(lines: string[]): Record<string, any> {
	const out: Record<string, any> = {};
	let list: string[] | null = null;
	for (const line of lines) {
		const item = line.match(/^\s+-\s*(.*)$/);
		if (list && item) {
			const value = unquote(item[1]);
			if (value) list.push(value);
			continue;
		}
		list = null;
		const match = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
		if (!match) continue;
		const [, key, raw] = match;
		if (raw.trim() === "") {
			list = [];
			out[key] = list;
			continue;
		}
		out[key] = unquote(raw);
	}
	return out;
}

function unquote(value: string): string {
	const trimmed = value.trim();
	const quoted = trimmed.match(/^"([\s\S]*)"$/) ?? trimmed.match(/^'([\s\S]*)'$/);
	if (!quoted) return trimmed;
	return quoted[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/** `## ` headings outside code fences, because an answer can contain a fenced one. */
function splitSections(body: string): { preamble: string; sections: { heading: string; lines: string[] }[] } {
	const preamble: string[] = [];
	const sections: { heading: string; lines: string[] }[] = [];
	let current: { heading: string; lines: string[] } | null = null;
	let inFence = false;

	for (const line of body.split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
		const match = !inFence && line.match(/^##\s+(.*)$/);
		if (match) {
			current = { heading: match[1].trim(), lines: [] };
			sections.push(current);
			continue;
		}
		(current ? current.lines : preamble).push(line);
	}
	return { preamble: preamble.join("\n"), sections };
}

function readSection(question: string, lines: string[]): DocTurn {
	const body = [...lines];
	while (body.length && !body[0].trim()) body.shift();
	while (body.length && !body[body.length - 1].trim()) body.pop();

	let selection: string | null = null;
	if (body[0]?.startsWith(">")) {
		const quoted: string[] = [];
		while (body.length && body[0].startsWith(">")) quoted.push(body.shift()!.replace(/^>\s?/, ""));
		selection = quoted.join("\n").trim();
		while (body.length && !body[0].trim()) body.shift();
	}

	let footer: string | undefined;
	const last = body[body.length - 1]?.trim() ?? "";
	const answered = last.match(ANSWERED_BY);
	if (answered) {
		footer = answered[1].replace(/\.$/, "").trim();
		body.pop();
	}

	return {
		question,
		answer: promoteHeadings(body.join("\n").trim()),
		selection,
		footer,
	};
}
