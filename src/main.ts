import { Editor, FileSystemAdapter, MarkdownView, Menu, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { newRecord, type AskOptions, type ConversationRecord } from "./conversation";
import { oneLine, safeName } from "./document";
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
				if (!checking) void this.startAsk(file, null, { fresh: true });
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
				if (!checking) void this.startAsk(file, selection, { fresh: true });
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
				if (!checking) void this.startAsk(file, null, { fresh: false });
				return true;
			},
		});

		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, view) => {
				const file = view instanceof MarkdownView ? view.file : null;
				if (!file) return;
				const selection = editor.getSelection().trim();

				menu.addItem((item) =>
					item
						.setTitle(selection ? "Ask AI about the selection" : "Ask AI about this note")
						.setIcon("message-square")
						.onClick(() => void this.startAsk(file, selection || null, { fresh: true })),
				);

				// Asking opens a conversation of its own, so this is the way to add to one
				// that is already going. In the sidebar that is the conversation on screen;
				// in a modal there is nothing on screen, so the newest one is named.
				if (this.settings.surface === "sidebar") {
					if (conversationsFor(this.app, file).length) {
						menu.addItem((item) =>
							item
								.setTitle(selection ? "Follow up about the selection" : "Follow up in the open conversation")
								.setIcon("corner-down-right")
								.onClick(() => void this.startAsk(file, selection || null, { fresh: false })),
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
							.onClick(() => void this.startAsk(file, selection || null, { fresh: false })),
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
						.onClick(() => void this.startAsk(file, null, { fresh: true })),
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
						suggestions: session.turns?.[session.turns.length - 1]?.suggestions ?? [],
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
	private async startAsk(file: TFile, selection: string | null, options: { fresh: boolean }): Promise<void> {
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
			? selection
				? "Ask about the selection"
				: `Ask about ${file.basename}`
			: `Follow up about ${file.basename}`;

		new QuestionModal(
			this.app,
			title,
			selection,
			this.askOptions(record.agent),
			(id: ProviderId) => this.settings.models[id] ?? "",
			(question, chosen) => {
				// The choice made for one question becomes the default for the next.
				this.settings.provider = chosen.provider;
				this.settings.models[chosen.provider] = chosen.model;
				this.settings.effort = chosen.effort;
				this.settings.web = chosen.web;
				void this.saveSettings();
				void this.startConversation(file, record, chosen, question, selection, options.fresh);
			},
		).open();
	}

	private async startConversation(
		file: TFile,
		record: ConversationRecord,
		options: AskOptions,
		question: string,
		selection: string | null,
		fresh: boolean,
	): Promise<void> {
		// A follow-up joins the conversation that is open; "Ask about…" starts its own,
		// because a question about a passage has nothing to do with the thread already there.
		if (this.settings.surface === "sidebar") {
			const view = await this.revealSidebar();
			await view.ask(file, options, question, selection, fresh);
			return;
		}
		const modal = new AnswerModal(this.app, this, file, record, options);
		modal.open();
		void modal.ask(question, selection);
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
		return { file: latest, title: titleOf(latest, file), ...(await readConversation(this.app, latest)) };
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
