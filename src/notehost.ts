import { App, Component, TFile, setIcon, setTooltip } from "obsidian";
import { Conversation, newRecord, type AskOptions, type ConversationRecord } from "./conversation";
import type AskAiPlugin from "./main";
import { conversationsFor, readConversation, titleOf } from "./store";

/** One of a note's conversations: a row in the list, and the pane once it is opened. */
interface Entry {
	id: string;
	/** Null for one that has not been written yet. */
	file: TFile | null;
	title: string;
	/** When it was last asked in, which is the order the list is in. */
	updated: number;
	/** How many questions are in it, off the metadata cache rather than by reading it. */
	count: number;
	conversation: Conversation | null;
	el: HTMLElement | null;
}

/**
 * Every conversation about one note. They are files in the vault, so this finds them
 * rather than remembering them: the list is whatever is on disk, and one of them is
 * open below it. A note with a single conversation shows no list at all.
 */
export class NoteHost {
	private listEl!: HTMLElement;
	private stackEl!: HTMLElement;
	private entries: Entry[] = [];
	private activeId: string | null = null;
	private nextId = 0;
	private refreshTimer: number | null = null;
	private loaded: Promise<void> | null = null;

	constructor(
		private app: App,
		private plugin: AskAiPlugin,
		private component: Component,
		private file: TFile,
		public readonly el: HTMLElement,
	) {}

	/** Idempotent, so anything that needs the first conversation mounted can await it. */
	load(): Promise<void> {
		return (this.loaded ??= this.build());
	}

	private async build(): Promise<void> {
		this.listEl = this.el.createDiv({ cls: "ask-ai-list" });
		this.stackEl = this.el.createDiv({ cls: "ask-ai-stack" });
		this.discover();
		await this.activate(this.entries[0]?.id ?? this.draft().id);
	}

	/** Nothing here worth keeping, so the sidebar can drop it and rebuild it for free. */
	get isEmpty(): boolean {
		return !this.entries.some((entry) => entry.file || !entry.conversation?.isEmpty);
	}

	current(): Conversation | null {
		return this.entries.find((entry) => entry.id === this.activeId)?.conversation ?? null;
	}

	focusInput(): void {
		this.current()?.focusInput();
	}

	destroy(): void {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		for (const entry of this.entries) entry.conversation?.destroy();
		this.entries = [];
	}

	/**
	 * Ask in whichever conversation is open, which is what a follow-up means — or in a
	 * conversation of its own, which is what asking about a passage means: an answer
	 * about three lines you highlighted has nothing to do with the thread already there.
	 */
	async ask(options: AskOptions, question: string, selection: string | null, fresh = false): Promise<void> {
		await this.load();
		if (fresh) await this.openBlank();
		const conversation = this.current();
		if (!conversation) return;
		conversation.setOptions(options);
		await conversation.ask(question, selection);
	}

	/** A second conversation about the same note, rather than adding to this one. */
	async startNew(): Promise<void> {
		await this.load();
		await this.openBlank();
		this.focusInput();
	}

	/** Open an empty conversation, reusing one that is already empty rather than piling up. */
	private async openBlank(): Promise<void> {
		const blank = this.entries.find((entry) => !entry.file && entry.conversation?.isEmpty !== false);
		await this.activate(blank?.id ?? this.draft().id);
	}

	/** The vault changed under us — a conversation was added, renamed or deleted. */
	scheduleRefresh(): void {
		if (this.refreshTimer !== null) return;
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			this.discover();
			// The open one may have been the note that was just deleted.
			if (!this.activeId) void this.activate(this.entries[0]?.id ?? this.draft().id);
			else this.renderList();
		}, 50);
	}

	private draft(): Entry {
		const entry: Entry = {
			id: `c${this.nextId++}`,
			file: null,
			title: "New conversation",
			updated: Date.now(),
			count: 0,
			conversation: null,
			el: null,
		};
		this.entries.unshift(entry);
		return entry;
	}

	/**
	 * Reconcile the list with the vault. Entries are matched by file, so the one that
	 * was just written keeps its open pane instead of being replaced by a row.
	 */
	private discover(): void {
		const files = conversationsFor(this.app, this.file);
		const kept: Entry[] = [];

		for (const file of files) {
			// By the conversation's own note as well as by the entry's, so the draft that
			// was just written keeps its open pane instead of turning into a second row.
			const existing = this.entries.find(
				(entry) => entry.file?.path === file.path || entry.conversation?.record.file?.path === file.path,
			);
			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
			const stamp = Date.parse(String(frontmatter?.updated ?? frontmatter?.created ?? "")) || file.stat.mtime;
			if (existing) {
				existing.file = file;
				existing.title = titleOf(file, this.file);
				existing.updated = stamp;
				existing.count = this.questionCount(file);
				kept.push(existing);
				continue;
			}
			kept.push({
				id: `c${this.nextId++}`,
				file,
				title: titleOf(file, this.file),
				updated: stamp,
				count: this.questionCount(file),
				conversation: null,
				el: null,
			});
		}

		// Drafts have no file to find, and a conversation whose note has been deleted
		// goes with it rather than lingering as a pane about a file that is not there.
		for (const entry of this.entries) {
			if (!entry.file) {
				kept.push(entry);
				continue;
			}
			if (kept.includes(entry)) continue;
			entry.conversation?.destroy();
			entry.el?.remove();
			if (entry.id === this.activeId) this.activeId = null;
		}

		kept.sort((a, b) => b.updated - a.updated);
		this.entries = kept;
	}

	/** The `##` headings Obsidian already parsed, minus the contents list. */
	private questionCount(file: TFile): number {
		const headings = this.app.metadataCache.getFileCache(file)?.headings ?? [];
		return headings.filter((heading) => heading.level === 2 && heading.heading.trim().toLowerCase() !== "contents")
			.length;
	}

	private async activate(id: string): Promise<void> {
		const entry = this.entries.find((candidate) => candidate.id === id);
		if (!entry) return;
		if (this.activeId && this.activeId !== id) {
			this.entries.find((candidate) => candidate.id === this.activeId)?.el?.addClass("ask-ai-hidden");
		}
		this.activeId = id;

		if (!entry.conversation) {
			const record = entry.file ? await this.read(entry.file) : newRecord();
			entry.el = this.stackEl.createDiv({ cls: "ask-ai-host" });
			entry.conversation = new Conversation(
				this.app,
				this.plugin,
				this.component,
				this.file,
				record,
				this.plugin.askOptions(record.agent),
				() => {
					this.discover();
					this.renderList();
				},
			);
			entry.conversation.mount(entry.el);
		}
		entry.el?.removeClass("ask-ai-hidden");
		this.renderList();
	}

	private async read(file: TFile): Promise<ConversationRecord> {
		const parsed = await readConversation(this.app, file);
		return { file, title: titleOf(file, this.file), ...parsed };
	}

	/**
	 * One row per conversation, the open one highlighted. Hidden entirely when there is
	 * only one, because a list of one is a row of chrome that says nothing.
	 */
	private renderList(): void {
		this.listEl.empty();
		this.listEl.toggleClass("ask-ai-hidden", this.entries.length < 2);
		if (this.entries.length < 2) return;

		for (const entry of this.entries) {
			const row = this.listEl.createDiv({ cls: "ask-ai-list-row" });
			row.toggleClass("is-active", entry.id === this.activeId);
			const icon = row.createSpan({ cls: "ask-ai-list-icon" });
			setIcon(icon, entry.id === this.activeId ? "chevron-down" : "chevron-right");
			row.createSpan({ cls: "ask-ai-list-title", text: entry.title });
			const meta = entry.file
				? `${entry.count || 1} · ${shortDate(entry.updated)}`
				: entry.conversation?.isEmpty === false
					? "unsaved"
					: "new";
			row.createSpan({ cls: "ask-ai-list-meta", text: meta });
			setTooltip(
				row,
				entry.file ? `${entry.count} ${entry.count === 1 ? "question" : "questions"} · ${entry.file.path}` : "Not saved yet",
			);
			row.addEventListener("click", () => void this.activate(entry.id));
		}
	}
}

function shortDate(stamp: number): string {
	const date = new Date(stamp);
	const today = new Date();
	const sameDay =
		date.getDate() === today.getDate() && date.getMonth() === today.getMonth() && date.getFullYear() === today.getFullYear();
	return sameDay
		? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
		: date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
