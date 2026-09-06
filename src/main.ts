import { Editor, FileSystemAdapter, MarkdownView, Menu, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import type { AskOptions } from "./conversation";
import { AnswerModal, QuestionModal } from "./modals";
import { providerOrDefault, type ProviderId } from "./providers";
import { ASK_VIEW_TYPE, AskView } from "./view";
import { DEFAULT_SYSTEM_PROMPT, SUPERSEDED_SYSTEM_PROMPTS } from "./prompt";
import { AskAiSettingTab, effortFor, forgetOldest, migrate, trimTurns, type AskAiSettings, type StoredSession } from "./settings";

export default class AskAiPlugin extends Plugin {
	// Plugin declares `settings?: unknown`; this narrows it without emitting a field
	// that would shadow the base property.
	declare settings: AskAiSettings;

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

				// In the sidebar every question already lands in that note's conversation,
				// so a separate follow-up item would be the same item twice.
				const session = this.settings.surface === "modal" ? this.settings.sessions[file.path] : null;
				if (session) {
					menu.addItem((item) =>
						item
							.setTitle(`Follow up with ${providerOrDefault(session.provider).label}`)
							.setIcon("corner-down-right")
							.onClick(() => void this.startAsk(file, null, { fresh: false })),
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

		// A remembered session is about a note, not a path. Follow the note when it
		// moves, and forget it when the note is gone, so a follow-up can never resume
		// a conversation about different content.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				const session = this.settings.sessions[oldPath];
				if (!session) return;
				delete this.settings.sessions[oldPath];
				this.settings.sessions[file.path] = session;
				void this.saveSettings();
			}),
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!(file.path in this.settings.sessions)) return;
				delete this.settings.sessions[file.path];
				void this.saveSettings();
			}),
		);
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

		const session = options.fresh ? null : this.settings.sessions[file.path] ?? null;
		const title = options.fresh
			? selection
				? "Ask about the selection"
				: `Ask about ${file.basename}`
			: `Follow up about ${file.basename}`;

		new QuestionModal(
			this.app,
			title,
			selection,
			this.askOptions(file),
			(id: ProviderId) => this.settings.models[id] ?? "",
			(question, chosen) => {
				// The choice made for one question becomes the default for the next.
				this.settings.provider = chosen.provider;
				this.settings.models[chosen.provider] = chosen.model;
				this.settings.effort = chosen.effort;
				this.settings.web = chosen.web;
				void this.saveSettings();
				void this.startConversation(file, session, chosen, question, selection);
			},
		).open();
	}

	private async startConversation(
		file: TFile,
		session: StoredSession | null,
		options: AskOptions,
		question: string,
		selection: string | null,
	): Promise<void> {
		// The sidebar keeps a conversation per note, so a question joins the one that is
		// already there rather than starting over; the icon in its header starts over.
		if (this.settings.surface === "sidebar") {
			const view = await this.revealSidebar();
			await view.ask(file, options, question, selection);
			return;
		}
		const modal = new AnswerModal(this.app, this, file, session, options);
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
	 * Agent, model, effort and sources to open a question with. A note that already has
	 * a conversation opens on the agent holding it, not on whatever the last question
	 * anywhere happened to use.
	 */
	askOptions(file: TFile): AskOptions {
		const provider = this.settings.sessions[file.path]?.provider ?? this.settings.provider;
		return {
			provider,
			model: this.settings.models[provider] ?? "",
			effort: effortFor(provider, this.settings.effort),
			web: this.settings.web,
		};
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

	async rememberSession(notePath: string, session: StoredSession): Promise<void> {
		this.settings.sessions[notePath] = {
			...session,
			turns: session.turns ? trimTurns(session.turns) : undefined,
			updated: Date.now(),
		};
		forgetOldest(this.settings.sessions);
		await this.saveSettings();
	}

	async forgetSession(notePath: string): Promise<void> {
		if (!(notePath in this.settings.sessions)) return;
		delete this.settings.sessions[notePath];
		await this.saveSettings();
	}

	async loadSettings(): Promise<void> {
		this.settings = migrate((await this.loadData()) ?? {});
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
