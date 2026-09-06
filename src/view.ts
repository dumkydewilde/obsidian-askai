import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import { Conversation, type AskOptions } from "./conversation";
import type AskAiPlugin from "./main";
import type { StoredSession } from "./settings";

export const ASK_VIEW_TYPE = "ask-ai-view";

/**
 * Hosts a conversation in the sidebar, where it stays open beside the note instead
 * of covering it. One conversation at a time; asking about another note replaces it.
 */
export class AskView extends ItemView {
	private conversation: Conversation | null = null;
	private bodyEl!: HTMLElement;
	private headerEl!: HTMLElement;

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
		return this.conversation ? `Ask AI: ${this.conversation.file.basename}` : "Ask AI";
	}

	override getIcon(): string {
		return "message-square";
	}

	override async onOpen(): Promise<void> {
		this.contentEl.addClass("ask-ai-view");
		// The tab header is drawn from getDisplayText once, and the call to refresh it
		// is not in the public API, so the note being discussed is named here instead.
		this.headerEl = this.contentEl.createDiv({ cls: "ask-ai-view-header" });
		this.bodyEl = this.contentEl.createDiv({ cls: "ask-ai-body" });
		this.showPlaceholder();
	}

	override async onClose(): Promise<void> {
		this.conversation?.destroy();
		this.conversation = null;
	}

	private showPlaceholder(): void {
		this.headerEl.setText("Ask AI");
		this.bodyEl.empty();
		this.bodyEl.createDiv({
			cls: "ask-ai-placeholder",
			text: "Right-click inside a note and pick Ask AI, or run it from the command palette.",
		});
	}

	/** Replace whatever is here with a new conversation and run the first question. */
	async start(
		file: TFile,
		session: StoredSession | null,
		options: AskOptions,
		question: string,
		selection: string | null,
	): Promise<void> {
		this.conversation?.destroy();
		this.bodyEl.empty();

		const conversation = new Conversation(this.app, this.plugin, this, file, session, options, () => {
			// The sidebar stays open after inserting; only focus goes back to the editor.
		});
		this.conversation = conversation;
		this.headerEl.setText(file.basename);
		conversation.mount(this.bodyEl);
		await conversation.ask(question, selection);
	}
}
