import { App, TFile, TFolder, normalizePath } from "obsidian";

/** One question and its answer, as it goes into a research note. */
export interface ResearchTurn {
	question: string;
	answer: string;
	/** The passage the question was asked about, when it was asked about one. */
	selection?: string | null;
	/** Which model or agent answered, so a mixed conversation stays attributable. */
	agent?: string;
}

export interface SaveOptions {
	source: TFile;
	folder: string;
	backlinkHeading: string;
	/** Set once this conversation has a note, so further turns append to it. */
	existingPath: string | null;
	/** How many of the turns are already in that note. */
	alreadySaved: number;
}

const CONTENTS_HEADING = "## Contents";

/**
 * Saves a conversation as its own note and links it from the note it is about, so
 * the research is findable from the source rather than living in a closed panel.
 * Called again with more turns, it appends only the new ones.
 */
export async function saveResearch(app: App, options: SaveOptions, turns: ResearchTurn[]): Promise<TFile> {
	const fresh = turns.slice(options.alreadySaved);

	if (options.existingPath) {
		const existing = app.vault.getAbstractFileByPath(options.existingPath);
		if (existing instanceof TFile) {
			if (fresh.length) {
				await app.vault.process(existing, (content) =>
					withContents(`${content.trimEnd()}\n\n${fresh.map(section).join("\n\n")}\n`),
				);
			}
			return existing;
		}
	}

	const folder = options.folder.trim() ? normalizePath(options.folder.trim()) : options.source.parent?.path ?? "";
	await ensureFolder(app, folder);

	const link = app.fileManager.generateMarkdownLink(options.source, folder);
	const body = withContents(
		["---", `source: "${link.replace(/"/g, '\\"')}"`, `created: ${localTimestamp()}`, "---", "", turns.map(section).join("\n\n"), ""].join(
			"\n",
		),
	);

	const path = await uniquePath(app, folder, `${options.source.basename} — ${slug(turns[0].question)}`);
	const note = await app.vault.create(path, body);
	await addBacklink(app, options.source, note, turns[0].question, options.backlinkHeading);
	return note;
}

function section(turn: ResearchTurn): string {
	const parts = [`## ${heading(turn.question)}`];
	if (turn.selection?.trim()) parts.push(quote(turn.selection.trim()));
	parts.push(demoteHeadings(turn.answer.trim()));
	if (turn.agent) parts.push(`*Answered by ${turn.agent}.*`);
	return parts.join("\n\n");
}

/** The passage a question was asked about, kept with it so the answer still reads. */
function quote(selection: string): string {
	return selection
		.split("\n")
		.map((line) => `> ${line}`.trimEnd())
		.join("\n");
}

/**
 * A table of contents of same-note heading links, rebuilt on every save. Only worth
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

	const questions = lines
		.filter((line) => /^##\s/.test(line) && line.trim() !== CONTENTS_HEADING)
		.map((line) => line.replace(/^##\s+/, "").trim());
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
	let inFence = false;
	return markdown
		.split("\n")
		.map((line) => {
			if (/^\s*(```|~~~)/.test(line)) {
				inFence = !inFence;
				return line;
			}
			if (inFence) return line;
			return /^(#{1,5})\s/.test(line) ? `#${line}` : line;
		})
		.join("\n");
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** `#`, `[`, `]` and `|` in a heading break the [[#heading]] links in the contents. */
function heading(question: string): string {
	return oneLine(question.replace(/[#[\]|^]/g, "")) || "Question";
}

/** Local time, because an ISO string would record a question asked at 16:37 as 14:37. */
function localTimestamp(): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** Link the research note from the note it is about, under its own heading. */
async function addBacklink(app: App, source: TFile, note: TFile, question: string, headingLine: string): Promise<void> {
	// The question is the link text, so the bullet does not repeat it after a dash,
	// and a question too long for the filename still reads in full here.
	const link = app.fileManager.generateMarkdownLink(note, source.path, undefined, oneLine(question));
	const entry = `- ${link}`;
	const wanted = headingLine.trim() || "## Research";
	const level = wanted.match(/^#+/)?.[0].length ?? 2;

	await app.vault.process(source, (content) => {
		const lines = content.split("\n");
		const start = lines.findIndex((line) => line.trim().toLowerCase() === wanted.toLowerCase());
		if (start === -1) {
			return `${content.trimEnd()}\n\n${wanted}\n\n${entry}\n`;
		}
		// Append at the end of that section, which is the next heading of the same or higher level.
		let end = lines.length;
		for (let i = start + 1; i < lines.length; i++) {
			const match = lines[i].match(/^(#+)\s/);
			if (match && match[1].length <= level) {
				end = i;
				break;
			}
		}
		while (end > start + 1 && lines[end - 1].trim() === "") end--;
		lines.splice(end, 0, entry);
		return lines.join("\n");
	});
}

async function ensureFolder(app: App, folder: string): Promise<void> {
	if (!folder) return;
	if (app.vault.getAbstractFileByPath(folder) instanceof TFolder) return;
	await app.vault.createFolder(folder).catch(() => {
		// Another save may have created it first.
	});
}

async function uniquePath(app: App, folder: string, base: string): Promise<string> {
	const prefix = folder ? `${folder}/` : "";
	for (let n = 0; ; n++) {
		const path = normalizePath(`${prefix}${base}${n ? ` ${n + 1}` : ""}.md`);
		if (!app.vault.getAbstractFileByPath(path)) return path;
	}
}

/**
 * Obsidian rejects these characters in filenames, long names are unreadable in the
 * explorer, and a trailing period would land next to the one before "md".
 */
function slug(question: string): string {
	const cleaned = oneLine(question.replace(/[/\\:*?"<>|#^[\]]/g, ""));
	const capped = cleaned.length > 50 ? `${cleaned.slice(0, 50).trimEnd()}…` : cleaned;
	return capped.replace(/[.\s]+$/, "") || "research";
}
