import { App, PluginSettingTab, Setting } from "obsidian";
import type AskAiPlugin from "./main";
import { PROVIDERS, PROVIDER_IDS, PROVIDER_LABELS, providerOrDefault, type ProviderId } from "./providers";

/** Which agent answered a note's last question, so a follow-up resumes the right one. */
export interface StoredSession {
	provider: ProviderId;
	id: string;
}

export interface AskAiSettings {
	/** Which CLI answers a question, unless changed for that question. */
	provider: ProviderId;
	/** Binary per provider. A bare name is looked up on the PATH built below. */
	paths: Record<ProviderId, string>;
	/** Argument template for the custom provider, with {prompt} and {model} placeholders. */
	customArgs: string;
	/** Prepended to PATH, because Obsidian launched from Finder inherits almost none. */
	extraPath: string;
	/** Model per provider, because a name for one is meaningless to another. */
	models: Record<ProviderId, string>;
	/** Thinking effort, for the CLIs that have one. Empty means their default. */
	effort: string;
	/** Whether the agent may search and fetch the web as well as the vault. */
	web: boolean;
	/** Where a conversation opens. */
	surface: "modal" | "sidebar";
	/** Where saved research notes go. Empty means beside the note they are about. */
	researchFolder: string;
	/** Heading in the source note that research links are collected under. */
	backlinkHeading: string;
	/** How the agent is told to answer, on every question. */
	systemPrompt: string;
	/** How long one question may run before the process is killed. */
	timeoutSeconds: number;
	/** Session per vault-relative note path, so follow-ups continue the right conversation. */
	sessions: Record<string, StoredSession>;
}

export const DEFAULT_SYSTEM_PROMPT = [
	"You are a researcher answering a question about a note in an Obsidian vault.",
	"",
	"Lead with the answer. The first sentence answers the question directly. Never open with what you " +
		"searched for, what you could not find, or what the note does not contain.",
	"",
	"Answer from your own knowledge of the subject as well as from the vault. The vault is context, not " +
		"the limit of what you know. A question about something the note never mentions is still a question " +
		"you should answer.",
	"",
	"Ground every claim. Cite a vault note as [[note name]] or by heading. Cite a URL when the claim came " +
		"from the web. When a claim is your own background knowledge, say so plainly rather than letting it " +
		"read as if the vault said it.",
	"",
	"Close with a short Sources section: the vault notes and URLs you drew on, and one line on what you " +
		"searched for only if it changes how much to trust the answer. Method belongs there, never at the top.",
	"",
	"Read the note before answering, and follow [[wikilinks]] with Grep or Glob when they matter. Write " +
		"plain markdown. No preamble, no restating the question, no \"that said\". Be specific. Keep it tight " +
		"unless asked for depth.",
].join("\n");

/**
 * Earlier defaults. The prompt is persisted, so a saved copy of one of these is an
 * untouched default rather than a customisation, and gets replaced on load.
 */
export const SUPERSEDED_SYSTEM_PROMPTS = [
	"You are answering questions about notes in an Obsidian vault. Read the note before answering. " +
		"Follow [[wikilinks]] with Grep or Glob when they matter to the question. Answer in plain markdown " +
		"with no preamble. Refer to sections of the note by heading. Keep it short unless asked for depth.",
];

/** Whether the web tools are offered to the agent. */
export const WEB_OPTIONS: Record<string, string> = {
	"": "Vault only",
	web: "Vault + web",
};

const EMPTY_PATHS: Record<ProviderId, string> = { claude: "", codex: "", gemini: "", custom: "" };

export const DEFAULT_SETTINGS: AskAiSettings = {
	provider: "claude",
	paths: { ...EMPTY_PATHS },
	customArgs: "run {prompt}",
	extraPath: "~/.local/bin:/opt/homebrew/bin:/usr/local/bin",
	models: { ...EMPTY_PATHS },
	effort: "",
	web: false,
	surface: "modal",
	researchFolder: "",
	backlinkHeading: "## Research",
	systemPrompt: DEFAULT_SYSTEM_PROMPT,
	timeoutSeconds: 180,
	sessions: {},
};

/**
 * Settings written before the plugin handled more than one agent. Values keyed by
 * provider replaced the single `claudePath` and `model`, and a session is now a
 * provider and an id rather than a bare id.
 */
interface LegacySettings {
	claudePath?: string;
	model?: string;
	sessions?: Record<string, string | StoredSession>;
}

export function migrate(saved: Partial<AskAiSettings> & LegacySettings): AskAiSettings {
	const settings: AskAiSettings = {
		...DEFAULT_SETTINGS,
		...saved,
		paths: { ...EMPTY_PATHS, ...saved.paths },
		models: { ...EMPTY_PATHS, ...saved.models },
		sessions: {},
	};

	if (saved.claudePath && !settings.paths.claude) settings.paths.claude = saved.claudePath;
	if (saved.model && !settings.models.claude) settings.models.claude = saved.model;
	// The spread above carried the old keys through; they are saved back otherwise.
	delete (settings as Partial<LegacySettings>).claudePath;
	delete (settings as Partial<LegacySettings>).model;

	for (const [path, session] of Object.entries(saved.sessions ?? {})) {
		if (typeof session === "string") settings.sessions[path] = { provider: "claude", id: session };
		else if (session?.id) settings.sessions[path] = session;
	}

	return settings;
}

/** The effort values a provider accepts, with anything it does not understand dropped. */
export function effortFor(provider: ProviderId, effort: string): string {
	return effort in PROVIDERS[provider].capabilities.efforts ? effort : "";
}

/** Model options for a provider, plus whatever was typed into settings for it. */
export function modelOptionsFor(provider: ProviderId, current: string): Record<string, string> {
	const options = { ...PROVIDERS[provider].capabilities.models };
	if (current && !(current in options)) options[current] = current;
	return options;
}

export class AskAiSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: AskAiPlugin) {
		super(app, plugin);
	}

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const settings = this.plugin.settings;
		const provider = providerOrDefault(settings.provider);

		new Setting(containerEl)
			.setName("Agent")
			.setDesc("Which CLI answers a question. Also selectable per question.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(PROVIDER_LABELS)
					.setValue(settings.provider)
					.onChange(async (value) => {
						settings.provider = value as ProviderId;
						settings.effort = effortFor(settings.provider, settings.effort);
						await this.plugin.saveSettings();
						// The command, model and effort controls below all belong to the
						// agent that was just replaced.
						this.display();
					}),
			);

		containerEl.createDiv({ cls: "ask-ai-settings-note", text: provider.confinement });

		new Setting(containerEl)
			.setName(`${provider.label} command`)
			.setDesc(
				provider.id === "custom"
					? "Name or absolute path of the command to run."
					: `Name or absolute path of the ${provider.defaultPath} binary.`,
			)
			.addText((text) =>
				text
					.setPlaceholder(provider.defaultPath || "opencode")
					.setValue(settings.paths[provider.id])
					.onChange(async (value) => {
						settings.paths[provider.id] = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		if (provider.id === "custom") {
			new Setting(containerEl)
				.setName("Arguments")
				.setDesc(
					"Arguments to pass, with {prompt} where the question goes and {model} where the " +
						"model does. Quoted runs stay together. Stdout is read as the answer, so there " +
						"is no session to follow up on.",
				)
				.addText((text) =>
					text
						.setPlaceholder(DEFAULT_SETTINGS.customArgs)
						.setValue(settings.customArgs)
						.onChange(async (value) => {
							settings.customArgs = value;
							await this.plugin.saveSettings();
						}),
				);
		}

		new Setting(containerEl)
			.setName("Extra PATH entries")
			.setDesc(
				"Colon-separated directories prepended to PATH. Obsidian launched from Finder does not " +
					"inherit your shell PATH, so the binary is usually not found without this.",
			)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.extraPath)
					.setValue(settings.extraPath)
					.onChange(async (value) => {
						settings.extraPath = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Model")
			.setDesc(
				`An alias or a full model name for ${provider.label}. Leave empty for its default. ` +
					"Also selectable per question.",
			)
			.addText((text) =>
				text
					.setPlaceholder("(default)")
					.setValue(settings.models[provider.id])
					.onChange(async (value) => {
						settings.models[provider.id] = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		const efforts = provider.capabilities.efforts;
		if (Object.keys(efforts).length) {
			new Setting(containerEl)
				.setName("Thinking effort")
				.setDesc("How hard the agent thinks before answering. Also selectable per question.")
				.addDropdown((dropdown) =>
					dropdown
						.addOptions(efforts)
						.setValue(effortFor(provider.id, settings.effort))
						.onChange(async (value) => {
							settings.effort = value;
							await this.plugin.saveSettings();
						}),
				);
		}

		if (provider.capabilities.web !== "none") {
			new Setting(containerEl)
				.setName("Search the web")
				.setDesc(
					provider.capabilities.web === "prompt"
						? `Ask ${provider.label} to read the web as well as the vault. It has no flag for ` +
							  "this, so it is an instruction rather than a restriction."
						: "Let the agent read the web as well as the vault. Slower, and it leaves your machine.",
				)
				.addToggle((toggle) =>
					toggle.setValue(settings.web).onChange(async (value) => {
						settings.web = value;
						await this.plugin.saveSettings();
					}),
				);
		}

		new Setting(containerEl)
			.setName("Open answers in")
			.setDesc("A sidebar stays open beside the note; a modal covers it and closes on Escape.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ modal: "Modal", sidebar: "Sidebar" })
					.setValue(settings.surface)
					.onChange(async (value) => {
						settings.surface = value === "sidebar" ? "sidebar" : "modal";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Research folder")
			.setDesc("Where saved answers go. Leave empty to put them beside the note they are about.")
			.addText((text) =>
				text
					.setPlaceholder("(beside the note)")
					.setValue(settings.researchFolder)
					.onChange(async (value) => {
						settings.researchFolder = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Research heading")
			.setDesc("Heading in the source note that links to saved answers are collected under.")
			.addText((text) =>
				text
					.setPlaceholder("## Research")
					.setValue(settings.backlinkHeading)
					.onChange(async (value) => {
						settings.backlinkHeading = value.trim() || "## Research";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Timeout")
			.setDesc("Seconds before a running question is cancelled.")
			.addText((text) =>
				text
					.setPlaceholder("180")
					.setValue(String(settings.timeoutSeconds))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						settings.timeoutSeconds =
							Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SETTINGS.timeoutSeconds;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("System prompt")
			.setDesc(
				"How every agent is told to answer. Claude Code takes it as a system prompt; the others " +
					"have no flag for one, so it rides in ahead of the question.",
			)
			.addTextArea((text) => {
				text.setValue(settings.systemPrompt).onChange(async (value) => {
					settings.systemPrompt = value;
					await this.plugin.saveSettings();
				});
				text.inputEl.rows = 6;
				text.inputEl.addClass("ask-ai-settings-textarea");
			});

		const counts = new Map<ProviderId, number>();
		for (const session of Object.values(settings.sessions)) {
			counts.set(session.provider, (counts.get(session.provider) ?? 0) + 1);
		}
		const total = Object.keys(settings.sessions).length;
		const breakdown = PROVIDER_IDS.filter((id) => counts.has(id))
			.map((id) => `${counts.get(id)} ${PROVIDERS[id].label}`)
			.join(", ");
		new Setting(containerEl)
			.setName("Conversations")
			.setDesc(
				total === 0
					? "No note has an open conversation yet."
					: `${total} ${total === 1 ? "note has" : "notes have"} an open conversation that follow-ups continue (${breakdown}).`,
			)
			.addButton((button) =>
				button
					.setButtonText("Forget all")
					.setDisabled(total === 0)
					.onClick(async () => {
						settings.sessions = {};
						await this.plugin.saveSettings();
						this.display();
					}),
			);
	}
}
