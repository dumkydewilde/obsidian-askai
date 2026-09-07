import { ItemView, TAbstractFile, TFile, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import type { AskOptions } from "./conversation";
import type AskAiPlugin from "./main";
import { NoteHost } from "./notehost";

export const ASK_VIEW_TYPE = "ask-ai-view";

/** Notes nothing was asked about are free to rebuild, so only a few are kept around. */
const MAX_IDLE_NOTES = 8;

/**
 * Hosts a note's conversations in the sidebar, showing whichever note is open.
 * Switching notes puts that note's conversations back exactly as you left them, still
 * running if one was running, rather than throwing them away.
 */
export class AskView extends ItemView {
	private hosts = new Map<string, NoteHost>();
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
		setTooltip(reset, "New conversation about this note");
		reset.setAttr("aria-label", "New conversation about this note");
		reset.addEventListener("click", () => void this.startNew());
		this.bodyEl = this.contentEl.createDiv({ cls: "ask-ai-body" });
		this.placeholderEl = this.bodyEl.createDiv({
			cls: "ask-ai-placeholder",
			text: "Open a note to ask about it.",
		});

		this.clearStatusBar();
		this.registerEvent(this.app.workspace.on("resize", () => this.clearStatusBar()));
		this.registerEvent(this.app.workspace.on("file-open", (file) => this.show(file)));
		// A conversation is a note, so the list of them is whatever is in the vault: a file
		// created, renamed or deleted anywhere may be one of the open note's conversations.
		const refresh = () => this.current()?.scheduleRefresh();
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.rekey(file, oldPath);
				refresh();
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.forget(file.path);
				refresh();
			}),
		);
		this.registerEvent(this.app.vault.on("create", refresh));
		// Not straight away: onOpen can run while the workspace is still being restored,
		// and the note this pane is supposed to be about is whichever one ends up open.
		this.app.workspace.onLayoutReady(() => this.show(this.app.workspace.getActiveFile()));
	}

	override async onClose(): Promise<void> {
		for (const host of this.hosts.values()) host.destroy();
		this.hosts.clear();
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

	show(file: TFile | null): NoteHost | null {
		try {
			return this.showOrThrow(file);
		} catch (error) {
			console.error("Ask AI failed to open a conversation", error);
			this.bodyEl.createEl("pre", { cls: "ask-ai-crash", text: describe(error) });
			return null;
		}
	}

	/** Show this note's conversations, starting a first one if it has none. */
	private showOrThrow(file: TFile | null): NoteHost | null {
		if (!file || file.extension !== "md") return this.current();
		if (file.path === this.activePath) return this.current();

		if (this.activePath) this.hosts.get(this.activePath)?.el.addClass("ask-ai-hidden");

		this.placeholderEl.addClass("ask-ai-hidden");
		this.noteTitleEl.setText(file.basename);
		this.activePath = file.path;

		const existing = this.hosts.get(file.path);
		if (existing) {
			existing.el.removeClass("ask-ai-hidden");
			existing.scheduleRefresh();
			this.prune();
			return existing;
		}

		const el = this.bodyEl.createDiv({ cls: "ask-ai-note-host" });
		const host = new NoteHost(this.app, this.plugin, this, file, el);
		this.hosts.set(file.path, host);
		void host.load();
		this.prune();
		return host;
	}

	/** Show this note's conversations and run a question in the open one. */
	async ask(file: TFile, options: AskOptions, question: string, selection: string | null): Promise<void> {
		const host = this.show(file);
		await host?.ask(options, question, selection);
	}

	/** A second conversation about the same note, rather than adding to the open one. */
	async startNew(): Promise<void> {
		await this.current()?.startNew();
	}

	/** Put the caret in the question box of whichever note is showing. */
	focusInput(): void {
		this.current()?.focusInput();
	}

	private current(): NoteHost | null {
		return this.activePath ? this.hosts.get(this.activePath) ?? null : null;
	}

	/** A conversation is about a note, not a path, so it follows the note when it moves. */
	private rekey(file: TAbstractFile, oldPath: string): void {
		const host = this.hosts.get(oldPath);
		if (!host) return;
		this.hosts.delete(oldPath);
		this.hosts.set(file.path, host);
		if (this.activePath === oldPath) {
			this.activePath = file.path;
			if (file instanceof TFile) this.noteTitleEl.setText(file.basename);
		}
	}

	private forget(path: string): void {
		const host = this.hosts.get(path);
		if (!host) return;
		host.destroy();
		host.el.remove();
		this.hosts.delete(path);
		if (this.activePath !== path) return;
		this.activePath = null;
		this.noteTitleEl.setText("Ask AI");
		this.placeholderEl.removeClass("ask-ai-hidden");
	}

	/** Drop notes nobody asked anything about. One with a conversation is never dropped. */
	private prune(): void {
		for (const [path, host] of this.hosts) {
			if (this.hosts.size <= MAX_IDLE_NOTES) return;
			if (path === this.activePath || !host.isEmpty) continue;
			host.destroy();
			host.el.remove();
			this.hosts.delete(path);
		}
	}
}

function describe(error: unknown): string {
	if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
	return String(error);
}
