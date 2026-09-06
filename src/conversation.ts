import { App, Component, MarkdownRenderer, MarkdownView, Notice, TFile, setIcon } from "obsidian";
import { PROVIDER_LABELS, providerOrDefault, type ProviderId } from "./providers";
import { runAgent, type AskResult } from "./runner";
import type AskAiPlugin from "./main";
import { saveResearch, type ResearchTurn } from "./research";
import { effortFor, modelOptionsFor, WEB_OPTIONS, type StoredSession } from "./settings";

/** What to run a question with, chosen per question rather than only in settings. */
export interface AskOptions {
	provider: ProviderId;
	model: string;
	effort: string;
	web: boolean;
}

/**
 * One conversation about one note, rendered into whatever container it is given.
 * The modal and the sidebar are both thin hosts around this.
 */
export class Conversation {
	private turnsEl!: HTMLElement;
	private controlsEl!: HTMLElement;
	private followUpInput!: HTMLTextAreaElement;
	private askButton!: HTMLButtonElement;
	private saveButton!: HTMLButtonElement;
	private controller: AbortController | null = null;
	private running = false;
	private turns: ResearchTurn[] = [];
	/** Set once this conversation has a research note, so later saves append to it. */
	private researchPath: string | null = null;
	private savedTurns = 0;

	constructor(
		private app: App,
		private plugin: AskAiPlugin,
		private component: Component,
		public readonly file: TFile,
		/** The note's last conversation, resumable only by the agent that started it. */
		private session: StoredSession | null,
		private options: AskOptions,
		/** The modal closes after inserting into the editor; the sidebar stays put. */
		private onInserted: () => void,
	) {}

	mount(containerEl: HTMLElement): void {
		containerEl.addClass("ask-ai-conversation");
		this.turnsEl = containerEl.createDiv({ cls: "ask-ai-turns" });

		const footer = containerEl.createDiv({ cls: "ask-ai-footer" });
		this.controlsEl = footer.createDiv({ cls: "ask-ai-controls ask-ai-hidden" });
		this.renderControls();

		this.followUpInput = footer.createEl("textarea", {
			cls: "ask-ai-question-input",
			attr: { rows: "1", placeholder: "Follow up…" },
		});
		this.followUpInput.addEventListener("input", () => this.resizeInput());
		this.followUpInput.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				this.submitFollowUp();
			}
		});

		const buttons = footer.createDiv({ cls: "ask-ai-footer-buttons" });

		// The dropdowns are for the question after this one, so they stay folded away
		// until asked for rather than taking a row from the answer on every conversation.
		const cog = buttons.createEl("button", { cls: "ask-ai-icon-button", attr: { "aria-label": "Agent and model" } });
		setIcon(cog, "settings-2");
		cog.addEventListener("click", () => {
			const open = this.controlsEl.hasClass("ask-ai-hidden");
			this.controlsEl.toggleClass("ask-ai-hidden", !open);
			cog.toggleClass("is-active", open);
		});

		this.saveButton = buttons.createEl("button", { text: "Save to note" });
		this.saveButton.setAttr("disabled", "true");
		this.saveButton.addEventListener("click", () => void this.save());

		this.askButton = buttons.createEl("button", { cls: "mod-cta", text: "Ask" });
		this.askButton.addEventListener("click", () => {
			if (this.running) this.controller?.abort();
			else this.submitFollowUp();
		});
	}

	destroy(): void {
		this.controller?.abort();
	}

	focusInput(): void {
		this.followUpInput?.focus();
	}

	/**
	 * Agent, model, effort and sources for the next question. Rebuilt whenever the agent
	 * changes, because the models and effort levels one CLI takes mean nothing to another.
	 */
	private renderControls(): void {
		this.controlsEl.empty();
		const provider = providerOrDefault(this.options.provider);

		this.addSelect(PROVIDER_LABELS, this.options.provider, "Agent", (value) => {
			this.options.provider = value as ProviderId;
			this.options.model = this.plugin.settings.models[this.options.provider] ?? "";
			this.options.effort = effortFor(this.options.provider, this.options.effort);
			this.persistOptions();
			this.renderControls();
		});

		this.addSelect(modelOptionsFor(provider.id, this.options.model), this.options.model, "Model", (value) => {
			this.options.model = value;
			this.persistOptions();
		});

		if (Object.keys(provider.capabilities.efforts).length) {
			this.addSelect(provider.capabilities.efforts, this.options.effort, "Thinking effort", (value) => {
				this.options.effort = value;
				this.persistOptions();
			});
		}

		if (provider.capabilities.web !== "none") {
			this.addSelect(WEB_OPTIONS, this.options.web ? "web" : "", "Sources", (value) => {
				this.options.web = value === "web";
				this.persistOptions();
			});
		}
	}

	private addSelect(options: Record<string, string>, value: string, label: string, onChange: (value: string) => void): void {
		const select = this.controlsEl.createEl("select", { cls: "dropdown", attr: { "aria-label": label } });
		for (const [key, text] of Object.entries(options)) {
			select.createEl("option", { value: key, text });
		}
		select.value = value;
		select.addEventListener("change", () => onChange(select.value));
	}

	/** The choice made for one question becomes the default for the next. */
	private persistOptions(): void {
		const settings = this.plugin.settings;
		settings.provider = this.options.provider;
		settings.models[this.options.provider] = this.options.model;
		settings.effort = this.options.effort;
		settings.web = this.options.web;
		void this.plugin.saveSettings();
	}

	/** Textarea starts one line tall and grows with what you type, up to a cap. */
	private resizeInput(): void {
		this.followUpInput.style.height = "auto";
		this.followUpInput.style.height = `${Math.min(this.followUpInput.scrollHeight, 160)}px`;
	}

	private submitFollowUp(): void {
		if (this.running) return;
		const question = this.followUpInput.value.trim();
		if (!question) return;
		this.followUpInput.value = "";
		this.resizeInput();
		void this.ask(question, null);
	}

	/** Run one question. The first call on a note starts a session; later calls resume it. */
	async ask(question: string, selection: string | null): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.askButton.setText("Stop");
		this.followUpInput.setAttr("disabled", "true");

		const provider = providerOrDefault(this.options.provider);
		const turn = this.turnsEl.createDiv({ cls: "ask-ai-turn" });
		if (selection) {
			// The question on its own reads as a non-sequitur later ("what does this do?"),
			// so the passage it was asked about stays with it.
			turn.createDiv({ cls: "ask-ai-selection", text: selection });
		}
		turn.createDiv({ cls: "ask-ai-question", text: question });
		const statusEl = turn.createDiv({ cls: "ask-ai-status", text: "Thinking…" });
		const answerEl = turn.createDiv({ cls: "ask-ai-answer ask-ai-streaming" });

		const notePath = this.file.path;
		// A session belongs to the agent that opened it, so switching agents starts over.
		const resumeSessionId = this.session?.provider === provider.id ? this.session.id : undefined;
		const controller = new AbortController();
		this.controller = controller;
		const render = new StreamingMarkdown(this.app, this.component, answerEl, notePath, () => this.turnsEl);

		try {
			const result = await runAgent(
				this.plugin.settings,
				{
					vaultPath: this.plugin.vaultPath(),
					prompt: resumeSessionId ? question : buildPrompt(notePath, question, selection),
					provider: provider.id,
					resumeSessionId,
					newSessionId: resumeSessionId ? undefined : crypto.randomUUID(),
					model: this.options.model,
					effort: this.options.effort,
					web: this.options.web,
				},
				{
					onAnswer: (markdown) => render.set(markdown),
					onTool: (label) => statusEl.setText(label),
				},
				controller.signal,
			);

			if (result.sessionId) {
				this.session = { provider: provider.id, id: result.sessionId };
				await this.plugin.rememberSession(notePath, this.session);
			}

			answerEl.removeClass("ask-ai-streaming");
			await render.finish(result.answer);
			statusEl.setText(formatFooter(result, provider.label));
			this.turns.push({ question, answer: result.answer, selection, agent: result.model ?? provider.label });
			this.addTurnActions(turn, result.answer);
			this.refreshSaveButton();
		} catch (error) {
			render.stop();
			answerEl.removeClass("ask-ai-streaming");
			statusEl.setText("Failed");
			turn.createDiv({
				cls: "ask-ai-error",
				text: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.running = false;
			this.controller = null;
			this.askButton.setText("Ask");
			this.followUpInput.removeAttribute("disabled");
			this.followUpInput.focus();
		}
	}

	/** One button for the whole conversation, not one per answer. */
	private refreshSaveButton(): void {
		const unsaved = this.turns.length - this.savedTurns;
		if (!this.turns.length) return;
		if (unsaved === 0) {
			this.saveButton.setText("Saved");
			this.saveButton.setAttr("disabled", "true");
			return;
		}
		this.saveButton.setText(this.researchPath ? "Update note" : "Save to note");
		this.saveButton.removeAttribute("disabled");
	}

	private async save(): Promise<void> {
		this.saveButton.setAttr("disabled", "true");
		try {
			const note = await saveResearch(
				this.app,
				{
					source: this.file,
					folder: this.plugin.settings.researchFolder,
					backlinkHeading: this.plugin.settings.backlinkHeading,
					existingPath: this.researchPath,
					alreadySaved: this.savedTurns,
				},
				this.turns,
			);
			const isNew = !this.researchPath;
			this.researchPath = note.path;
			this.savedTurns = this.turns.length;
			this.refreshSaveButton();
			new Notice(isNew ? `Saved to ${note.path}` : `Updated ${note.basename}`);
		} catch (error) {
			this.refreshSaveButton();
			new Notice(`Could not save: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private addTurnActions(turn: HTMLElement, answer: string): void {
		const actions = turn.createDiv({ cls: "ask-ai-actions" });

		const copy = actions.createEl("button", { text: "Copy" });
		copy.addEventListener("click", async () => {
			await navigator.clipboard.writeText(answer);
			new Notice("Answer copied");
		});

		const insert = actions.createEl("button", { text: "Insert at cursor" });
		insert.addEventListener("click", () => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view || view.file?.path !== this.file.path) {
				new Notice("Open the note in the editor first");
				return;
			}
			view.editor.replaceSelection(answer);
			this.onInserted();
		});
	}
}

function buildPrompt(notePath: string, question: string, selection: string | null): string {
	const parts = [`Note: ${notePath}`];
	if (selection) {
		parts.push(`The question is about this selected passage:\n\n${selection}`);
	}
	parts.push(`Question: ${question}`);
	return parts.join("\n\n");
}

function formatFooter(result: AskResult, providerLabel: string): string {
	const parts: string[] = [result.model ?? providerLabel];
	if (result.durationMs !== null) parts.push(`${(result.durationMs / 1000).toFixed(1)}s`);
	if (result.inputTokens !== null) parts.push(`${compact(result.inputTokens)} in`);
	if (result.outputTokens !== null) parts.push(`${compact(result.outputTokens)} out`);
	return parts.join(" · ");
}

function compact(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

/**
 * Renders markdown while it is still arriving. Re-rendering the whole answer on every
 * update would thrash, so it coalesces to one render per frame budget, builds the new
 * DOM detached and swaps it in, and only follows the text down if you were already at
 * the bottom.
 */
class StreamingMarkdown {
	private markdown = "";
	private timer: number | null = null;
	private rendering = false;
	private stale = false;
	private current: Component | null = null;

	constructor(
		private app: App,
		private owner: Component,
		private target: HTMLElement,
		private sourcePath: string,
		private scroller: () => HTMLElement,
	) {
		this.owner.register(() => this.stop());
	}

	/** The whole answer so far, which can shrink when the agent starts a new turn. */
	set(markdown: string): void {
		if (markdown === this.markdown) return;
		this.markdown = markdown;
		this.schedule();
	}

	stop(): void {
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
		this.current?.unload();
		this.current = null;
	}

	/** Draw the authoritative answer, which may differ from what streamed by. */
	async finish(markdown: string): Promise<void> {
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
		this.markdown = markdown;
		await this.draw();
	}

	private schedule(): void {
		if (this.timer !== null) return;
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.draw();
		}, 120);
	}

	private async draw(): Promise<void> {
		if (this.rendering) {
			this.stale = true;
			return;
		}
		this.rendering = true;
		this.stale = false;

		const component = new Component();
		component.load();
		const staging = document.createElement("div");
		try {
			await MarkdownRenderer.render(this.app, this.markdown, staging, this.sourcePath, component);
		} catch {
			component.unload();
			this.rendering = false;
			return;
		}

		const scroller = this.scroller();
		const wasAtBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;

		this.target.empty();
		while (staging.firstChild) this.target.appendChild(staging.firstChild);
		this.current?.unload();
		this.current = component;

		if (wasAtBottom) scroller.scrollTop = scroller.scrollHeight;

		this.rendering = false;
		if (this.stale) await this.draw();
	}
}
