import { ItemView, TAbstractFile, TFile, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import { Conversation, type AskOptions } from "./conversation";
import type AskAiPlugin from "./main";

export const ASK_VIEW_TYPE = "ask-ai-view";

/** Untouched conversations are free to rebuild, so only a few are kept around. */
const MAX_IDLE_CONVERSATIONS = 8;

interface Hosted {
	conversation: Conversation;
	el: HTMLElement;
}

/**
 * Hosts one conversation per note in the sidebar, showing whichever note is open.
 * Switching notes puts that note's conversation back exactly as you left it, still
 * running if it was running, rather than throwing it away.
 */
export class AskView extends ItemView {
	private conversations = new Map<string, Hosted>();
	private activePath: string | null = null;
	private bodyEl!: HTMLElement;
	/**
	 * Not `titleEl`. ItemView already has one, `ItemView.load()` calls setText on it
	 * before onOpen ever runs, and a field declared here is defined as undefined after
	 * super() — so the name alone left the pane blank with the error in a console
	 * nobody had open. The same trap as Modal's `title` and `selection`.
	 */
	private noteTitleEl!: HTMLElement;
	private placeholderEl!: HTMLElement;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: AskAiPlugin,
	) {
		super(leaf);
	}

	override getViewType(): string {
		return ASK_VIEW_TYPE;
	}

	override getDisplayText(): string {
		return "Ask AI";
	}

	override getIcon(): string {
		return "message-square";
	}

	override async onOpen(): Promise<void> {
		// A view whose onOpen throws is a blank pane, with the reason only in a developer
		// console nobody has open. Painting it into the pane is the difference between
		// "the plugin is broken" and knowing which line broke it.
		try {
			this.build();
		} catch (error) {
			console.error("Ask AI failed to open its sidebar", error);
			this.contentEl.empty();
			this.contentEl.createEl("pre", { cls: "ask-ai-crash", text: describe(error) });
		}
	}

	private build(): void {
		this.contentEl.addClass("ask-ai-view");
		// The tab header is drawn from getDisplayText once, and the call to refresh it
		// is not in the public API, so the note being discussed is named here instead.
		const header = this.contentEl.createDiv({ cls: "ask-ai-view-header" });
		this.noteTitleEl = header.createDiv({ cls: "ask-ai-view-title", text: "Ask AI" });
		const reset = header.createEl("button", { cls: "clickable-icon ask-ai-icon-button" });
		setIcon(reset, "message-square-plus");
		setTooltip(reset, "Start over on this note");
		reset.setAttr("aria-label", "Start over on this note");
		reset.addEventListener("click", () => void this.reset());
		this.bodyEl = this.contentEl.createDiv({ cls: "ask-ai-body" });
		this.placeholderEl = this.bodyEl.createDiv({
			cls: "ask-ai-placeholder",
			text: "Open a note to ask about it.",
		});

		this.clearStatusBar();
		this.registerEvent(this.app.workspace.on("resize", () => this.clearStatusBar()));
		this.registerEvent(this.app.workspace.on("file-open", (file) => this.show(file)));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.rekey(file, oldPath)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.forget(file.path)));
		// Not straight away: onOpen can run while the workspace is still being restored,
		// and the note this pane is supposed to be about is whichever one ends up open.
		this.app.workspace.onLayoutReady(() => this.show(this.app.workspace.getActiveFile()));
	}

	override async onClose(): Promise<void> {
		for (const { conversation } of this.conversations.values()) conversation.destroy();
		this.conversations.clear();
		this.activePath = null;
	}

	/**
	 * Obsidian's status bar is fixed to the bottom-right of the window, which is exactly
	 * where this pane's footer sits, and its own panes clear it with a flat 32px. Measure
	 * it instead: the footer then sits right on top of it, and against nothing at all when
	 * the status bar is hidden or in a popout window that has none.
	 */
	private clearStatusBar(): void {
		const bar = this.contentEl.doc.body.querySelector<HTMLElement>(".status-bar");
		const overlaps = bar && bar.win.getComputedStyle(bar).position === "fixed";
		this.contentEl.style.setProperty("--ask-ai-bottom-clearance", `${overlaps ? bar.offsetHeight : 0}px`);
	}

	show(file: TFile | null): Conversation | null {
		try {
			return this.showOrThrow(file);
		} catch (error) {
			console.error("Ask AI failed to open a conversation", error);
			this.bodyEl.createEl("pre", { cls: "ask-ai-crash", text: describe(error) });
			return null;
		}
	}

	/** Show this note's conversation, starting one if it does not have one yet. */
	private showOrThrow(file: TFile | null): Conversation | null {
		if (!file || file.extension !== "md") return this.current();
		if (file.path === this.activePath) return this.current();

		if (this.activePath) this.conversations.get(this.activePath)?.el.addClass("ask-ai-hidden");

		this.placeholderEl.addClass("ask-ai-hidden");
		this.noteTitleEl.setText(file.basename);
		this.activePath = file.path;

		const existing = this.conversations.get(file.path);
		if (existing) {
			existing.el.removeClass("ask-ai-hidden");
			this.prune();
			return existing.conversation;
		}

		const el = this.bodyEl.createDiv({ cls: "ask-ai-host" });
		const conversation = new Conversation(
			this.app,
			this.plugin,
			this,
			file,
			this.plugin.settings.sessions[file.path] ?? null,
			this.plugin.askOptions(file),
		);
		conversation.mount(el);
		this.conversations.set(file.path, { conversation, el });
		this.prune();
		return conversation;
	}

	/** Show this note's conversation and run a question in it. */
	async ask(file: TFile, options: AskOptions, question: string, selection: string | null): Promise<void> {
		const conversation = this.show(file);
		if (!conversation) return;
		conversation.setOptions(options);
		await conversation.ask(question, selection);
	}

	/**
	 * Throw away this note's conversation and the session behind it, so the next
	 * question starts the agent over rather than resuming what is on screen.
	 */
	async reset(): Promise<void> {
		const path = this.activePath;
		const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
		if (!path || !(file instanceof TFile)) return;
		this.forget(path);
		await this.plugin.forgetSession(path);
		this.placeholderEl.addClass("ask-ai-hidden");
		this.show(file)?.focusInput();
	}

	/** Put the caret in the question box of whichever note is showing. */
	focusInput(): void {
		this.current()?.focusInput();
	}

	private current(): Conversation | null {
		return this.activePath ? this.conversations.get(this.activePath)?.conversation ?? null : null;
	}

	/** A conversation is about a note, not a path, so it follows the note when it moves. */
	private rekey(file: TAbstractFile, oldPath: string): void {
		const entry = this.conversations.get(oldPath);
		if (!entry) return;
		this.conversations.delete(oldPath);
		this.conversations.set(file.path, entry);
		if (this.activePath === oldPath) {
			this.activePath = file.path;
			if (file instanceof TFile) this.noteTitleEl.setText(file.basename);
		}
	}

	private forget(path: string): void {
		const entry = this.conversations.get(path);
		if (!entry) return;
		entry.conversation.destroy();
		entry.el.remove();
		this.conversations.delete(path);
		if (this.activePath !== path) return;
		this.activePath = null;
		this.noteTitleEl.setText("Ask AI");
		this.placeholderEl.removeClass("ask-ai-hidden");
	}

	/** Drop conversations nobody asked anything in. One with turns is never dropped. */
	private prune(): void {
		for (const [path, entry] of this.conversations) {
			if (this.conversations.size <= MAX_IDLE_CONVERSATIONS) return;
			if (path === this.activePath || !entry.conversation.isEmpty) continue;
			entry.conversation.destroy();
			entry.el.remove();
			this.conversations.delete(path);
		}
	}
}

function describe(error: unknown): string {
	if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
	return String(error);
}
