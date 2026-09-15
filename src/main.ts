import { Editor, FileSystemAdapter, MarkdownView, Menu, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { newRecord, type AskOptions, type ConversationRecord } from "./conversation";
import { oneLine, safeName, type AskContext } from "./document";
import { imageEmbedAt, isImagePath } from "./embeds";
import { AnswerModal, QuestionModal } from "./modals";
import { isProviderId, PROVIDERS, type ProviderId } from "./providers";
import { conversationsFor, createConversation, localTimestamp, readConversation, titleOf } from "./store";
import { ASK_VIEW_TYPE, AskView } from "./view";
import { DEFAULT_SYSTEM_PROMPT, SUPERSEDED_SYSTEM_PROMPTS } from "./prompt";
import {
	AskAiSettingTab,
	effortFor,
	legacySessions,
	migrate,
	storeOptions,
	type AskAiSettings,
	type LegacySession,
} from "./settings";

export default class AskAiPlugin extends Plugin {
	// Plugin declares `settings?: unknown`; this narrows it without emitting a field
	// that would shadow the base property.
	declare settings: AskAiSettings;
	/** Conversations an older settings file was still holding, written out as notes below. */
	private legacy: Record<string, LegacySession> = {};
	/** What the last right-click landed on, for a menu item that depends on it. */
	private rightClicked: HTMLElement | null = null;

	override async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new AskAiSettingTab(this.app, this));
		this.registerView(ASK_VIEW_TYPE, (leaf: WorkspaceLeaf) => new AskView(leaf, this));

		this.addCommand({
			id: "ask-about-note",
			name: "Ask about this note",
			checkCallback: (checking) => {
				const file = this.activeFile();
				if (!file) return false;
				if (!checking) void this.startAsk(file, {}, { fresh: true });
				return true;
			},
		});

		this.addCommand({
			id: "ask-about-selection",
			name: "Ask about the selection",
			editorCheckCallback: (checking, editor, view) => {
				const file = view instanceof MarkdownView ? view.file : null;
				const selection = editor.getSelection().trim();
				if (!file || !selection) return false;
				if (!checking) void this.startAsk(file, { selection }, { fresh: true });
				return true;
			},
		});

		this.addCommand({
			id: "ask-about-image",
			name: "Ask about the image at the cursor",
			editorCheckCallback: (checking, editor, view) => {
				const file = view instanceof MarkdownView ? view.file : null;
				const image = file ? this.imageAtCursor(editor, file) : null;
				if (!file || !image) return false;
				if (!checking) void this.startAsk(file, { image }, { fresh: true });
				return true;
			},
		});

		this.addCommand({
			id: "open-sidebar",
			name: "Open the sidebar",
			// Opened deliberately, so the next thing wanted is almost always to type.
			callback: () => void this.revealSidebar().then((view) => view.focusInput()),
		});

		this.addCommand({
			id: "follow-up",
			name: "Follow up about this note",
			checkCallback: (checking) => {
				const file = this.activeFile();
				if (!file) return false;
				if (!checking) void this.startAsk(file, {}, { fresh: false });
				return true;
			},
		});

		// `editor-menu` says which editor was right-clicked, not what in it was. In live
		// preview an image is drawn as a widget the caret does not move into, so the click
		// is the only thing that knows which image you meant. Capture, so it has landed
		// before Obsidian builds the menu below.
		this.registerDomEvent(
			document,
			"contextmenu",
			(event) => {
				this.rightClicked = event.target instanceof HTMLElement ? event.target : null;
			},
			{ capture: true },
		);

		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, view) => {
				const file = view instanceof MarkdownView ? view.file : null;
				if (!file) return;
				const context = this.editorContext(editor, file);
				const about = context.selection ? "the selection" : context.image ? "this image" : "this note";

				menu.addItem((item) =>
					item
						.setTitle(`Ask AI about ${about}`)
						.setIcon(context.image ? "image" : "message-square")
						.onClick(() => void this.startAsk(file, context, { fresh: true })),
				);

				// Asking opens a conversation of its own, so this is the way to add to one
				// that is already going. In the sidebar that is the conversation on screen;
				// in a modal there is nothing on screen, so the newest one is named.
				if (this.settings.surface === "sidebar") {
					if (conversationsFor(this.app, file).length) {
						menu.addItem((item) =>
							item
								.setTitle(
									context.selection || context.image
										? `Follow up about ${about}`
										: "Follow up in the open conversation",
								)
								.setIcon("corner-down-right")
								.onClick(() => void this.startAsk(file, context, { fresh: false })),
						);
					}
					return;
				}
				const latest = conversationsFor(this.app, file)[0];
				if (latest) {
					// Named, because a note can have several, and this continues the newest.
					const agent = String(this.app.metadataCache.getFileCache(latest)?.frontmatter?.agent ?? "");
					const with_ = isProviderId(agent) ? ` with ${PROVIDERS[agent].label}` : "";
					menu.addItem((item) =>
						item
							.setTitle(`Follow up on ${titleOf(latest, file)}${with_}`)
							.setIcon("corner-down-right")
							.onClick(() => void this.startAsk(file, context, { fresh: false })),
					);
				}
			}),
		);

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				menu.addItem((item) =>
					item
						.setTitle("Ask AI about this note")
						.setIcon("message-square")
						.onClick(() => void this.startAsk(file, {}, { fresh: true })),
				);
			}),
		);

		// Nothing here follows a note that moves or is deleted: a conversation is a note
		// linked to the one it is about, and Obsidian maintains that link itself.
		this.app.workspace.onLayoutReady(() => void this.importLegacyConversations());
	}

	/**
	 * Conversations used to live in the settings file. They are notes now, so the ones
	 * an older install is still holding are written out once and then let go of.
	 */
	private async importLegacyConversations(): Promise<void> {
		const entries = Object.entries(this.legacy).filter(([, session]) => session.turns?.length);
		this.legacy = {};
		if (!entries.length || !this.vaultPathOrNull()) return;

		let written = 0;
		for (const [path, session] of entries) {
			const source = this.app.vault.getAbstractFileByPath(path);
			if (!(source instanceof TFile)) continue;
			const turns = (session.turns ?? []).map((turn) => ({
				question: turn.question,
				answer: turn.answer,
				selection: turn.selection ?? null,
				// The footer is what the pane showed; older turns only recorded the model.
				footer: turn.footer ?? turn.agent,
			}));
			const created = localTimestamp();
			try {
				await createConversation(
					this.app,
					storeOptions(this.settings),
					source,
					safeName(oneLine(turns[0].question).slice(0, 50)),
					{
						agent: session.provider,
						session: session.id,
						created,
						updated: created,
					},
					turns,
				);
				written++;
			} catch (error) {
				console.error(`Ask AI could not move the conversation about ${path} into the vault`, error);
			}
		}
		if (written) {
			new Notice(`Ask AI moved ${written} ${written === 1 ? "conversation" : "conversations"} into your vault as notes.`);
		}
	}

	/**
	 * The agent reads the note off disk, so flush the editor buffer first. Without this a
	 * question asked seconds after typing gets answered against the previous text.
	 */
	private async startAsk(file: TFile, context: AskContext, options: { fresh: boolean }): Promise<void> {
		if (!this.vaultPathOrNull()) {
			new Notice("Ask AI needs a vault stored on disk.");
			return;
		}

		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === file.path) {
				await view.save();
			}
		}

		const record = options.fresh ? newRecord() : await this.latestRecord(file);
		const title = options.fresh
			? context.selection
				? "Ask about the selection"
				: context.image
					? "Ask about the image"
					: `Ask about ${file.basename}`
			: `Follow up about ${file.basename}`;

		new QuestionModal(
			this.app,
			title,
			context,
			this.askOptions(record.agent),
			(id: ProviderId) => this.settings.models[id] ?? "",
			(question, chosen) => {
				// The choice made for one question becomes the default for the next.
				this.settings.provider = chosen.provider;
				this.settings.models[chosen.provider] = chosen.model;
				this.settings.effort = chosen.effort;
				this.settings.web = chosen.web;
				void this.saveSettings();
				void this.startConversation(file, record, chosen, question, context, options.fresh);
			},
		).open();
	}

	private async startConversation(
		file: TFile,
		record: ConversationRecord,
		options: AskOptions,
		question: string,
		context: AskContext,
		fresh: boolean,
	): Promise<void> {
		// A follow-up joins the conversation that is open; "Ask about…" starts its own,
		// because a question about a passage has nothing to do with the thread already there.
		if (this.settings.surface === "sidebar") {
			const view = await this.revealSidebar();
			await view.ask(file, options, question, context, fresh);
			return;
		}
		const modal = new AnswerModal(this.app, this, file, record, options);
		modal.open();
		void modal.ask(question, context);
	}

	/** Reuse the open sidebar if there is one, otherwise put a new one on the right. */
	private async revealSidebar(): Promise<AskView> {
		const existing = this.app.workspace.getLeavesOfType(ASK_VIEW_TYPE)[0];
		const leaf = existing ?? this.app.workspace.getRightLeaf(false);
		if (!leaf) throw new Error("Obsidian has no right sidebar to open in.");
		if (!existing) await leaf.setViewState({ type: ASK_VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
		return leaf.view as AskView;
	}

	/**
	 * Agent, model, effort and sources to open a question with. A conversation already
	 * under way opens on the agent holding it, because only that agent can resume the
	 * thread — but it is a default, so choosing another agent for this question still wins.
	 */
	askOptions(agent = ""): AskOptions {
		const provider = isProviderId(agent) ? agent : this.settings.provider;
		return {
			provider,
			model: this.settings.models[provider] ?? "",
			effort: effortFor(provider, this.settings.effort),
			web: this.settings.web,
		};
	}

	/** The note's newest conversation, for a follow-up that is not going to the sidebar. */
	private async latestRecord(file: TFile): Promise<ConversationRecord> {
		const latest = conversationsFor(this.app, file)[0];
		if (!latest) return newRecord();
		return { file: latest, title: titleOf(latest, file), suggestions: [], ...(await readConversation(this.app, latest)) };
	}

	/**
	 * What a question asked from the editor is about. A highlighted passage wins, because
	 * you chose it; otherwise an image the caret is in, so right-clicking a diagram asks
	 * about the diagram rather than about the note it happens to sit in.
	 */
	private editorContext(editor: Editor, file: TFile): AskContext {
		// Consumed rather than kept, so a menu opened from the keyboard afterwards does not
		// pick up the image from whatever was right-clicked before it.
		const clicked = this.rightClicked;
		this.rightClicked = null;
		const selection = editor.getSelection().trim();
		if (selection) return { selection };
		return { image: this.imageUnderPointer(clicked, file) ?? this.imageAtCursor(editor, file) };
	}

	/**
	 * The image a right-click landed on. Obsidian renders an embed inside an element
	 * carrying the link as it was written, which is the one thing on screen that still
	 * knows which file the picture came from.
	 */
	private imageUnderPointer(clicked: HTMLElement | null, file: TFile): string | null {
		const written = clicked?.closest<HTMLElement>(".internal-embed[src]")?.getAttribute("src");
		return written ? this.resolveImage(written, file) : null;
	}

	/** The vault path of the image the caret is on, when it is on one we can read. */
	private imageAtCursor(editor: Editor, file: TFile): string | null {
		const cursor = editor.getCursor();
		const embed = imageEmbedAt(editor.getLine(cursor.line) ?? "", cursor.ch);
		return embed ? this.resolveImage(embed.target, file) : null;
	}

	/**
	 * A link as it was written to a file in the vault. Through Obsidian's own resolver, so
	 * a bare name, a vault-relative path and one relative to this note all land on the
	 * same file — and a remote URL on none, since an agent reading the vault cannot open it.
	 */
	private resolveImage(written: string, file: TFile): string | null {
		const target = written.split("|")[0].split("#")[0].trim();
		const dest = this.app.metadataCache.getFirstLinkpathDest(target, file.path);
		return dest && isImagePath(dest.path) ? dest.path : null;
	}

	private activeFile(): TFile | null {
		const file = this.app.workspace.getActiveFile();
		return file && file.extension === "md" ? file : null;
	}

	private vaultPathOrNull(): string | null {
		const adapter = this.app.vault.adapter;
		return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
	}

	vaultPath(): string {
		const path = this.vaultPathOrNull();
		if (!path) throw new Error("This vault is not stored on the local filesystem.");
		return path;
	}

	async loadSettings(): Promise<void> {
		const saved = (await this.loadData()) ?? {};
		this.settings = migrate(saved);
		this.legacy = legacySessions(saved);
		// The prompt is persisted, so an old default would otherwise outlive every
		// improvement to it. Only replace one nobody has edited: either it still matches
		// the default it was given, or it matches one shipped before that was recorded.
		const prompt = this.settings.systemPrompt.trim();
		const untouched =
			!prompt ||
			prompt === this.settings.installedPrompt.trim() ||
			SUPERSEDED_SYSTEM_PROMPTS.some((old) => old.trim() === prompt);
		if (untouched) this.settings.systemPrompt = DEFAULT_SYSTEM_PROMPT;
		this.settings.installedPrompt = DEFAULT_SYSTEM_PROMPT;
		await this.saveSettings();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
