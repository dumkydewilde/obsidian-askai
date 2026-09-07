import { App, Component, MarkdownRenderer, Notice, TFile, setIcon, setTooltip } from "obsidian";
import { PROVIDER_LABELS, providerOrDefault, type ProviderId } from "./providers";
import { runAgent, type AskResult } from "./runner";
import type AskAiPlugin from "./main";
import { appendConversation, createConversation, localTimestamp, safeName } from "./store";
import { alignBlocks } from "./markdown";
import { splitTrailing, stripTrailing } from "./trailing";
import { effortFor, modelOptionsFor, storeOptions, WEB_OPTIONS } from "./settings";
import { oneLine, type DocTurn } from "./document";

/** What to run a question with, chosen per question rather than only in settings. */
export interface AskOptions {
	provider: ProviderId;
	model: string;
	effort: string;
	web: boolean;
}

/**
 * One conversation about one note. The note it is kept in is the record — this is what
 * that file holds, kept in step as answers arrive so the list in the sidebar can show
 * a conversation's title and length without reading it again.
 */
export interface ConversationRecord {
	/** The note it lives in, once it has one. Null until the first answer is written. */
	file: TFile | null;
	/** Its name, which is also its filename. Empty until the first answer names it. */
	title: string;
	/** The agent holding the thread, and the thread. Only that agent can resume it. */
	agent: string;
	session: string;
	created: string;
	/** The next questions offered under the newest answer. */
	suggestions: string[];
	/** Anything written above the first question in the note, kept rather than dropped. */
	preamble: string;
	turns: DocTurn[];
}

/** A conversation that has not been asked anything yet, so has no note either. */
export function newRecord(): ConversationRecord {
	return { file: null, title: "", agent: "", session: "", created: "", suggestions: [], preamble: "", turns: [] };
}

/**
 * One conversation about one note, rendered into whatever container it is given.
 * The modal and the sidebar are both thin hosts around this.
 */
export class Conversation {
	private turnsEl!: HTMLElement;
	private controlsEl!: HTMLElement;
	private emptyEl: HTMLElement | null = null;
	private followUpInput!: HTMLTextAreaElement;
	private askButton!: HTMLButtonElement;
	private saveButton!: HTMLButtonElement;
	/** The suggestions under the newest answer, cleared when the next question starts. */
	private suggestionsEl: HTMLElement | null = null;
	private controller: AbortController | null = null;
	private running = false;
	/** The same array as the record's, so the host list sees a new turn as it lands. */
	private turns: DocTurn[] = [];
	/** How many of them are in the note already. */
	private savedTurns = 0;

	constructor(
		private app: App,
		private plugin: AskAiPlugin,
		private component: Component,
		/** The note the conversation is about. */
		public readonly file: TFile,
		public readonly record: ConversationRecord,
		private options: AskOptions,
		/** Called when the note is written, so a host can redraw its list of them. */
		private onWrite: () => void = () => {},
	) {}

	/** Adopt the agent and model a question was asked with from outside the sidebar. */
	setOptions(options: AskOptions): void {
		this.options = { ...options };
		if (this.controlsEl) this.renderControls();
	}

	/** Nothing asked yet, so the host can throw it away and rebuild it for free. */
	get isEmpty(): boolean {
		return this.turns.length === 0 && !this.running;
	}

	mount(containerEl: HTMLElement): void {
		containerEl.addClass("ask-ai-conversation");
		this.turnsEl = containerEl.createDiv({ cls: "ask-ai-turns" });
		this.turns = this.record.turns;
		this.savedTurns = this.turns.length;
		if (this.record.preamble) {
			// Whatever you wrote in the note above the first question. Shown, because the
			// note being the record is the point: editing it changes what this pane says.
			const preamble = this.turnsEl.createDiv({ cls: "ask-ai-preamble" });
			void MarkdownRenderer.render(this.app, this.record.preamble, preamble, this.file.path, this.component);
		}
		if (!this.turns.length) {
			this.emptyEl = this.turnsEl.createDiv({
				cls: "ask-ai-empty",
				text: `Ask anything about ${this.file.basename}.`,
			});
		}

		const footer = containerEl.createDiv({ cls: "ask-ai-footer" });
		this.controlsEl = footer.createDiv({ cls: "ask-ai-controls ask-ai-hidden" });
		this.renderControls();

		// One row: the question gets every pixel the icons on either side do not need.
		const row = footer.createDiv({ cls: "ask-ai-input-row" });

		// The dropdowns are for the question after this one, so they stay folded away
		// until asked for rather than taking a row from the answer on every conversation.
		const cog = this.iconButton(row, "settings-2", "Agent and model");
		cog.addEventListener("click", () => {
			const open = this.controlsEl.hasClass("ask-ai-hidden");
			this.controlsEl.toggleClass("ask-ai-hidden", !open);
			cog.toggleClass("is-active", open);
		});

		this.saveButton = this.iconButton(row, "save", "Save to new note");
		this.saveButton.setAttr("disabled", "true");
		this.saveButton.addEventListener("click", () => void this.save());

		this.followUpInput = row.createEl("textarea", {
			cls: "ask-ai-question-input",
			attr: { rows: "1", placeholder: "Ask…" },
		});
		this.followUpInput.addEventListener("input", () => this.resizeInput());
		this.followUpInput.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				this.submitFollowUp();
			}
		});

		this.askButton = this.iconButton(row, "arrow-up", "Ask");
		this.askButton.addClass("ask-ai-send");
		this.askButton.addEventListener("click", () => {
			if (this.running) this.controller?.abort();
			else this.submitFollowUp();
		});

		if (this.turns.length) void this.restore();
	}

	/**
	 * Draw the conversation as it was left. The agent thread is resumable either way —
	 * this is so that a note you asked about last week does not look like a blank pane
	 * that a follow-up would somehow continue.
	 */
	private async restore(): Promise<void> {
		for (const [index, stored] of this.turns.entries()) {
			const { turn, status, answerEl } = this.startTurn(stored.question, stored.selection ?? null);
			status.settle(stored.footer ?? "");
			answerEl.removeClass("ask-ai-streaming");
			await MarkdownRenderer.render(this.app, stored.answer, answerEl, this.file.path, this.component);
			this.addCopyButton(turn, stored.answer);
			attachBlockCopy(answerEl, stored.answer);
			// Only the newest answer's next questions are still worth offering.
			if (index === this.turns.length - 1) this.renderSuggestions(turn, this.record.suggestions);
		}
		this.refreshSaveButton();
		this.turnsEl.scrollTop = this.turnsEl.scrollHeight;
	}

	/** The shell of one exchange, built the same way whether it is arriving or restored. */
	private startTurn(question: string, selection: string | null): { turn: HTMLElement; status: StatusLine; answerEl: HTMLElement } {
		const turn = this.turnsEl.createDiv({ cls: "ask-ai-turn" });
		if (selection) {
			// The question on its own reads as a non-sequitur later ("what does this do?"),
			// so the passage it was asked about stays with it.
			turn.createDiv({ cls: "ask-ai-selection", text: selection });
		}
		turn.createDiv({ cls: "ask-ai-question", text: question });
		const status = new StatusLine(turn);
		const answerEl = turn.createDiv({ cls: "ask-ai-answer ask-ai-streaming" });
		return { turn, status, answerEl };
	}

	destroy(): void {
		this.controller?.abort();
	}

	focusInput(): void {
		this.followUpInput?.focus();
	}

	private iconButton(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
		const button = parent.createEl("button", { cls: "clickable-icon ask-ai-icon-button" });
		setIcon(button, icon);
		setTooltip(button, label);
		button.setAttr("aria-label", label);
		return button;
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
		setIcon(this.askButton, "square");
		setTooltip(this.askButton, "Stop");
		this.followUpInput.setAttr("disabled", "true");
		this.emptyEl?.remove();
		this.emptyEl = null;
		// The suggestions belonged to the answer above; this question replaces them.
		this.suggestionsEl?.remove();
		this.suggestionsEl = null;

		const provider = providerOrDefault(this.options.provider);
		const { turn, status, answerEl } = this.startTurn(question, selection);

		const notePath = this.file.path;
		// A session belongs to the agent that opened it, so switching agents starts over.
		const resumeSessionId = this.record.agent === provider.id ? this.record.session || undefined : undefined;
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
					// The suggestions are stripped as they stream, so a half-written fence
					// never flashes up as a code block mid-answer.
					onAnswer: (markdown) => render.set(stripTrailing(markdown)),
					onTool: (label) => status.setText(label),
				},
				controller.signal,
			);

			const { answer, suggestions, title } = splitTrailing(result.answer);
			const footer = formatFooter(result, provider.label);
			answerEl.removeClass("ask-ai-streaming");
			await render.finish(answer);
			status.settle(footer);
			this.turns.push({ question, answer, selection, footer });
			this.record.suggestions = suggestions;
			// The agent names the conversation on its first answer, because the first
			// question makes a poor name for it ("In one sentence, what is this note about?").
			if (!this.record.title) this.record.title = safeName(title || oneLine(question).slice(0, 50));
			if (result.sessionId) {
				this.record.agent = provider.id;
				this.record.session = result.sessionId;
			}
			this.addCopyButton(turn, answer);
			attachBlockCopy(answerEl, answer);
			this.renderSuggestions(turn, suggestions);
			// The note is the record, so it is written as the answer lands rather than on
			// a button — unless you have turned that off, and then the button is the only way.
			await this.write();
		} catch (error) {
			render.stop();
			answerEl.removeClass("ask-ai-streaming");
			status.settle("Failed");
			turn.createDiv({
				cls: "ask-ai-error",
				text: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.running = false;
			this.controller = null;
			setIcon(this.askButton, "arrow-up");
			setTooltip(this.askButton, "Ask");
			this.followUpInput.removeAttribute("disabled");
			this.followUpInput.focus();
		}
	}

	/** The next questions the agent thought were worth asking, as one click each. */
	private renderSuggestions(turn: HTMLElement, suggestions: string[]): void {
		if (!suggestions.length) return;
		const el = turn.createDiv({ cls: "ask-ai-suggestions" });
		this.suggestionsEl = el;
		for (const suggestion of suggestions) {
			const chip = el.createEl("button", { cls: "ask-ai-suggestion", text: suggestion });
			chip.addEventListener("click", () => void this.ask(suggestion, null));
		}
		this.turnsEl.scrollTop = this.turnsEl.scrollHeight;
	}

	/**
	 * One button for the whole conversation, not one per answer. With conversations kept
	 * in the vault it is never a save button — the note is already there — so it becomes
	 * the way to open it.
	 */
	private refreshSaveButton(): void {
		if (!this.turns.length) return;
		const unsaved = this.turns.length - this.savedTurns;
		if (this.record.file && !unsaved) {
			setIcon(this.saveButton, "file-text");
			this.label(this.saveButton, `Open ${this.record.file.basename}`);
			this.saveButton.removeAttribute("disabled");
			return;
		}
		setIcon(this.saveButton, "save");
		this.label(this.saveButton, this.record.file ? "Update note" : "Save to new note");
		this.saveButton.toggleAttribute("disabled", !unsaved);
	}

	private label(button: HTMLElement, label: string): void {
		setTooltip(button, label);
		button.setAttr("aria-label", label);
	}

	/** The button: open the note when it is current, otherwise write to it. */
	private async save(): Promise<void> {
		const file = this.record.file;
		if (file && this.turns.length === this.savedTurns) {
			await this.app.workspace.getLeaf("tab").openFile(file);
			return;
		}
		await this.write(true);
		if (this.record.file) {
			new Notice(file ? `Updated ${this.record.file.basename}` : `Saved to ${this.record.file.path}`);
		}
	}

	/**
	 * Put the conversation in its note: create it on the first answer, append the new
	 * turns after that so an answer you have since edited is left as you edited it.
	 */
	private async write(explicit = false): Promise<void> {
		if (!explicit && !this.plugin.settings.keepInVault) {
			this.refreshSaveButton();
			return;
		}
		const fresh = this.turns.slice(this.savedTurns);
		if (!fresh.length && this.record.file) return;

		this.saveButton.setAttr("disabled", "true");
		const updated = localTimestamp();
		try {
			if (this.record.file) {
				await appendConversation(
					this.app,
					this.record.file,
					{ agent: this.record.agent, session: this.record.session, updated, suggestions: this.record.suggestions },
					fresh,
				);
			} else {
				this.record.created = updated;
				this.record.file = await createConversation(
					this.app,
					storeOptions(this.plugin.settings),
					this.file,
					this.record.title,
					{
						agent: this.record.agent,
						session: this.record.session,
						created: updated,
						updated,
						suggestions: this.record.suggestions,
					},
					this.turns,
				);
			}
			this.savedTurns = this.turns.length;
		} catch (error) {
			// Worth interrupting even when it was not asked for: silence would read as saved.
			new Notice(`Could not write the conversation note: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.refreshSaveButton();
		this.onWrite();
	}

	private addCopyButton(turn: HTMLElement, answer: string): void {
		const copy = this.iconButton(turn, "copy", "Copy answer");
		copy.addClass("ask-ai-copy");
		copy.addEventListener("click", async () => {
			await navigator.clipboard.writeText(answer);
			new Notice("Answer copied");
		});
	}
}

/**
 * One copy button per answer that follows the pointer from block to block, rather than
 * one button per paragraph sitting in the rendered markdown. What it puts on the
 * clipboard is that block's source, so a paragraph pasted into a note keeps its links.
 */
function attachBlockCopy(answerEl: HTMLElement, markdown: string): void {
	const blocks = Array.from(answerEl.children) as HTMLElement[];
	if (!blocks.length) return;
	const sources = alignBlocks(
		blocks.map((block) => block.textContent ?? ""),
		markdown,
	);

	answerEl.addClass("ask-ai-has-block-copy");
	const button = answerEl.createEl("button", { cls: "clickable-icon ask-ai-block-copy" });
	setIcon(button, "copy");
	setTooltip(button, "Copy this block");
	button.setAttr("aria-label", "Copy this block");

	let source = "";
	const show = (block: HTMLElement, text: string) => {
		source = text;
		button.style.top = `${block.offsetTop}px`;
		button.addClass("is-visible");
	};

	answerEl.addEventListener("pointerover", (event) => {
		let node = event.target as HTMLElement | null;
		if (node === button || button.contains(node)) return;
		while (node && node.parentElement !== answerEl) node = node.parentElement;
		const index = node ? blocks.indexOf(node) : -1;
		if (index === -1) return;
		show(node as HTMLElement, sources[index]);
	});
	answerEl.addEventListener("pointerleave", () => button.removeClass("is-visible"));

	button.addEventListener("click", async () => {
		await navigator.clipboard.writeText(source);
		new Notice("Block copied");
	});
}

/**
 * The line under a question: what the agent is doing while it works, then what it
 * cost once it is done. The dots are the only sign of life while a tool runs long.
 */
class StatusLine {
	private el: HTMLElement;
	private textEl: HTMLElement;

	constructor(turn: HTMLElement) {
		this.el = turn.createDiv({ cls: "ask-ai-status is-running" });
		this.textEl = this.el.createSpan({ text: "Thinking" });
		const dots = this.el.createSpan({ cls: "ask-ai-dots" });
		for (let i = 0; i < 3; i++) dots.createSpan();
	}

	setText(text: string): void {
		this.textEl.setText(text);
	}

	settle(text: string): void {
		this.el.removeClass("is-running");
		this.el.empty();
		this.textEl = this.el.createSpan({ text });
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
