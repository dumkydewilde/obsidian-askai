import { App, TFile, TFolder, normalizePath } from "obsidian";
import {
	appendTurns,
	formatConversation,
	isConversation,
	oneLine,
	parseConversation,
	safeName,
	setFields,
	type DocFields,
	type DocTurn,
	type ParsedConversation,
} from "./document";

/** Where a conversation note goes, and what links to it. */
export interface StoreOptions {
	/** "folder" puts every conversation under `folder`; "note" beside the note it is about. */
	location: "folder" | "note";
	folder: string;
	/** A folder per note inside that, so a note with five conversations is five files deep. */
	subfolder: boolean;
	/** Heading in the source note that links to conversations are collected under. */
	backlinkHeading: string;
}

/**
 * Every conversation about a note, newest first. Found by frontmatter rather than by
 * folder, so moving a conversation, or the note, does not lose it: the walk is over
 * Obsidian's in-memory metadata cache, not the disk.
 */
export function conversationsFor(app: App, source: TFile): TFile[] {
	const found: { file: TFile; updated: number; mtime: number }[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!isConversation(frontmatter)) continue;
		const link = linkpath(String(frontmatter?.source ?? ""));
		if (!link) continue;
		if (app.metadataCache.getFirstLinkpathDest(link, file.path)?.path !== source.path) continue;
		found.push({
			file,
			updated: Date.parse(String(frontmatter?.updated ?? "")) || file.stat.mtime,
			mtime: file.stat.mtime,
		});
	}
	// The frontmatter stamp is to the minute, so two conversations in the same minute
	// would otherwise land in whatever order the vault listed them.
	return found.sort((a, b) => b.updated - a.updated || b.mtime - a.mtime).map((entry) => entry.file);
}

/** The target of `source: "[[Some note|alias]]"`, however it was written. */
function linkpath(value: string): string {
	const inner = value.match(/\[\[([^\]]+)\]\]/)?.[1] ?? value;
	return inner.split("|")[0].split("#")[0].trim();
}

export async function readConversation(app: App, file: TFile): Promise<ParsedConversation> {
	return parseConversation(await app.vault.cachedRead(file));
}

/**
 * The name a conversation is filed under. In a folder of its own it is the title on
 * its own; flat, the note comes first so a folder of conversations sorts by note.
 */
export function conversationName(options: StoreOptions, source: TFile, title: string): string {
	const name = safeName(title);
	return options.subfolder ? name : `${safeName(source.basename)} — ${name}`;
}

/** And back, so a renamed file still reads as a title in the list. */
export function titleOf(file: TFile, source: TFile): string {
	// Against the sanitised name, because that is the one the filename carries.
	const prefix = `${safeName(source.basename)} — `;
	return file.basename.startsWith(prefix) ? file.basename.slice(prefix.length) : file.basename;
}

export function folderFor(options: StoreOptions, source: TFile): string {
	const base = options.location === "folder" ? options.folder.trim() : source.parent?.path ?? "";
	// Through safeName: a note called "using lancedb with motherduck?" is a legal note
	// name and an illegal folder name, and the folder is named after the note.
	const parts = [base, options.subfolder ? safeName(source.basename) : ""].filter(Boolean);
	return parts.length ? normalizePath(parts.join("/")) : "";
}

export async function createConversation(
	app: App,
	options: StoreOptions,
	source: TFile,
	title: string,
	/** Everything but the link back, which depends on where the file lands. */
	fields: Omit<DocFields, "source">,
	turns: DocTurn[],
): Promise<TFile> {
	const folder = folderFor(options, source);
	await ensureFolder(app, folder);
	const path = await uniquePath(app, folder, conversationName(options, source, title));
	const link = app.fileManager.generateMarkdownLink(source, folder);
	const note = await app.vault.create(path, formatConversation({ ...fields, source: link }, turns));
	await addBacklink(app, source, note, title, options.backlinkHeading);
	return note;
}

/** New answers are appended, so an edit to an earlier one is never overwritten. */
export async function appendConversation(
	app: App,
	file: TFile,
	fields: Partial<DocFields>,
	turns: DocTurn[],
): Promise<void> {
	await app.vault.process(file, (content) => setFields(appendTurns(content, turns), fields));
}

async function ensureFolder(app: App, folder: string): Promise<void> {
	if (!folder) return;
	// Every parent, because "askai-conversations/Some note" is two folders on a first run.
	const parts = folder.split("/");
	for (let i = 1; i <= parts.length; i++) {
		const path = parts.slice(0, i).join("/");
		if (app.vault.getAbstractFileByPath(path) instanceof TFolder) continue;
		await app.vault.createFolder(path).catch(() => {
			// Another save may have created it first.
		});
	}
}

async function uniquePath(app: App, folder: string, base: string): Promise<string> {
	const prefix = folder ? `${folder}/` : "";
	for (let n = 0; ; n++) {
		const path = normalizePath(`${prefix}${base}${n ? ` ${n + 1}` : ""}.md`);
		if (!app.vault.getAbstractFileByPath(path)) return path;
	}
}

/** Link the conversation from the note it is about, under its own heading. */
async function addBacklink(app: App, source: TFile, note: TFile, title: string, headingLine: string): Promise<void> {
	// An alias only when it says something the filename does not — which it does in a
	// folder per note, where the file is named after the note as well as the title.
	const alias = oneLine(title) === note.basename ? undefined : oneLine(title);
	const link = app.fileManager.generateMarkdownLink(note, source.path, undefined, alias);
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

/** Local time, because an ISO string would record a question asked at 16:37 as 14:37. */
export function localTimestamp(): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}
