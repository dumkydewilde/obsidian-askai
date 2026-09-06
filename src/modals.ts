import { App, Component, Modal, Setting, TFile } from "obsidian";
import { Conversation, type AskOptions } from "./conversation";
import type AskAiPlugin from "./main";
import { PROVIDER_LABELS, providerOrDefault, type ProviderId } from "./providers";
import { effortFor, modelOptionsFor, WEB_OPTIONS, type StoredSession } from "./settings";

/** Asks for the question text, and what to answer it with. */
export class QuestionModal extends Modal {
	private question = "";
	private options: AskOptions;
	private controlsEl!: HTMLElement;

	// Modal owns undocumented fields that the type definitions do not declare, so a
	// field named `selection` or `title` is silently overwritten when the modal opens.
	// Hence `heading` and `selectedText`.
	constructor(
		app: App,
		private heading: string,
		private selectedText: string | null,
		defaults: AskOptions,
		/** Model per agent, so switching agents picks up that agent's own default. */
		private modelFor: (provider: ProviderId) => string,
		private onSubmit: (question: string, options: AskOptions) => void,
	) {
		super(app);
		this.options = { ...defaults };
	}

	override onOpen(): void {
		this.setTitle(this.heading);
		const { contentEl } = this;

		if (this.selectedText) {
			contentEl.createDiv({ cls: "ask-ai-selection", text: this.selectedText });
		}

		const input = contentEl.createEl("textarea", {
			cls: "ask-ai-question-input",
			attr: { rows: "3", placeholder: "What do you want to know about this note?" },
		});
		input.addEventListener("input", () => {
			this.question = input.value;
		});
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				this.submit();
			}
		});
		window.setTimeout(() => input.focus());

		const row = new Setting(contentEl)
			.setDesc("Enter to ask, Shift+Enter for a new line.")
			.addButton((button) => button.setButtonText("Ask").setCta().onClick(() => this.submit()));
		// The dropdowns live in their own element so changing the agent can rebuild only
		// them, leaving the Ask button and the hint where they are.
		this.controlsEl = row.controlEl.createDiv({ cls: "ask-ai-controls" });
		row.controlEl.insertBefore(this.controlsEl, row.controlEl.firstChild);
		this.renderControls();
	}

	private renderControls(): void {
		this.controlsEl.empty();
		const provider = providerOrDefault(this.options.provider);

		this.addSelect(PROVIDER_LABELS, this.options.provider, "Agent", (value) => {
			this.options.provider = value as ProviderId;
			this.options.model = this.modelFor(this.options.provider);
			this.options.effort = effortFor(this.options.provider, this.options.effort);
			this.renderControls();
		});

		this.addSelect(modelOptionsFor(provider.id, this.options.model), this.options.model, "Model", (value) => {
			this.options.model = value;
		});

		if (Object.keys(provider.capabilities.efforts).length) {
			this.addSelect(provider.capabilities.efforts, this.options.effort, "Thinking effort", (value) => {
				this.options.effort = value;
			});
		}

		if (provider.capabilities.web !== "none") {
			this.addSelect(WEB_OPTIONS, this.options.web ? "web" : "", "Sources", (value) => {
				this.options.web = value === "web";
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

	private submit(): void {
		const question = this.question.trim();
		if (!question) return;
		this.close();
		this.onSubmit(question, this.options);
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}

/** Hosts a conversation in a modal, for when you would rather not give up a sidebar. */
export class AnswerModal extends Modal {
	private component = new Component();
	private conversation: Conversation;

	constructor(app: App, plugin: AskAiPlugin, file: TFile, session: StoredSession | null, options: AskOptions) {
		super(app);
		this.conversation = new Conversation(app, plugin, this.component, file, session, options);
	}

	override onOpen(): void {
		this.modalEl.addClass("ask-ai-modal");
		this.setTitle(this.conversation.file.basename);
		this.component.load();
		this.conversation.mount(this.contentEl);
	}

	override onClose(): void {
		this.conversation.destroy();
		this.component.unload();
		this.contentEl.empty();
	}

	ask(question: string, selection: string | null): Promise<void> {
		return this.conversation.ask(question, selection);
	}
}
