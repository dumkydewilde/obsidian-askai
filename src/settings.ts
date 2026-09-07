import { App, PluginSettingTab, Setting } from "obsidian";
import type AskAiPlugin from "./main";
import { DEFAULT_SYSTEM_PROMPT } from "./prompt";
import { PROVIDER_LABELS, providerOrDefault, type ProviderId } from "./providers";
import type { DocTurn } from "./document";
import type { StoreOptions } from "./store";

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
	/** Whether conversations go in one folder, or beside the note they are about. */
	conversationLocation: "folder" | "note";
	/** That folder, when conversations go in one. */
	conversationFolder: string;
	/** A folder per note inside it, so a note's conversations are grouped rather than mixed. */
	conversationSubfolder: boolean;
	/** Whether every answer is written to its note as it arrives, rather than on a button. */
	keepInVault: boolean;
	/** Heading in the source note that conversation links are collected under. */
	backlinkHeading: string;
	/** How the agent is told to answer, on every question. */
	systemPrompt: string;
	/**
	 * The default `systemPrompt` was last given. An untouched prompt still equals it and
	 * is replaced when the default improves; an edited one does not and is left alone.
	 * Without it, telling the two apart meant keeping a copy of every default ever shipped.
	 */
	installedPrompt: string;
	/** How long one question may run before the process is killed. */
	timeoutSeconds: number;
}

/** Where this vault keeps conversations, in the shape the store takes. */
export function storeOptions(settings: AskAiSettings): StoreOptions {
	return {
		location: settings.conversationLocation,
		folder: settings.conversationFolder,
		subfolder: settings.conversationSubfolder,
		backlinkHeading: settings.backlinkHeading,
	};
}

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
	conversationLocation: "folder",
	conversationFolder: "askai-conversations",
	conversationSubfolder: true,
	keepInVault: true,
	backlinkHeading: "## Research",
	systemPrompt: DEFAULT_SYSTEM_PROMPT,
	installedPrompt: DEFAULT_SYSTEM_PROMPT,
	timeoutSeconds: 180,
};

/**
 * Settings written by earlier versions. Values keyed by provider replaced the single
 * `claudePath` and `model`; conversations used to live in this file, under `sessions`,
 * and are now notes in the vault.
 */
interface LegacySettings {
	claudePath?: string;
	model?: string;
	researchFolder?: string;
	autoSave?: boolean;
	sessions?: Record<string, string | LegacySession>;
}

/** A conversation as the settings file used to hold it. Read once, then written out as a note. */
export interface LegacySession {
	provider: ProviderId;
	id: string;
	turns?: (DocTurn & { agent?: string; suggestions?: string[] })[];
	researchPath?: string;
	savedTurns?: number;
	updated?: number;
}

export function migrate(saved: Partial<AskAiSettings> & LegacySettings): AskAiSettings {
	const settings: AskAiSettings = {
		...DEFAULT_SETTINGS,
		...saved,
		paths: { ...EMPTY_PATHS, ...saved.paths },
		models: { ...EMPTY_PATHS, ...saved.models },
	};

	if (saved.claudePath && !settings.paths.claude) settings.paths.claude = saved.claudePath;
	if (saved.model && !settings.models.claude) settings.models.claude = saved.model;
	// The research folder was one setting doing two jobs: empty meant "beside the note".
	if (saved.researchFolder !== undefined) {
		settings.conversationLocation = saved.researchFolder.trim() ? "folder" : "note";
		settings.conversationFolder = saved.researchFolder.trim() || DEFAULT_SETTINGS.conversationFolder;
	}
	// `autoSave` is deliberately not carried over: it used to mean "write the research
	// note as well", with the settings file keeping the conversation either way, and that
	// second store is gone — so off would now mean "keep this nowhere".
	//
	// The spread above carried the old keys through; they are saved back otherwise.
	for (const key of ["claudePath", "model", "researchFolder", "autoSave", "sessions"] as const) {
		delete (settings as Partial<LegacySettings>)[key];
	}

	return settings;
}

/** The conversations an older settings file is still holding, so they can become notes. */
export function legacySessions(saved: LegacySettings): Record<string, LegacySession> {
	const sessions: Record<string, LegacySession> = {};
	for (const [path, session] of Object.entries(saved.sessions ?? {})) {
		if (typeof session === "string") sessions[path] = { provider: "claude", id: session };
		else if (session?.id) sessions[path] = session;
	}
	return sessions;
}

/**
 * The effort values a provider accepts, with anything it does not understand dropped.
 * Through providerOrDefault, because a settings file naming an agent this build does not
 * have would otherwise take down whatever asked — and the sidebar asks on every note.
 */
export function effortFor(provider: ProviderId, effort: string): string {
	return effort in providerOrDefault(provider).capabilities.efforts ? effort : "";
}

/** Model options for a provider, plus whatever was typed into settings for it. */
export function modelOptionsFor(provider: ProviderId, current: string): Record<string, string> {
	const options = { ...providerOrDefault(provider).capabilities.models };
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
			.setName("Keep conversations in the vault")
			.setDesc(
				"Write each answer to its own note as it arrives, instead of waiting for the save button. " +
					"Conversations are then ordinary notes: searchable, editable, in the graph, and pickable " +
					"by a Base through their `type: ask-ai-conversation` property. Off, a conversation only " +
					"lasts as long as the window unless you save it.",
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.keepInVault).onChange(async (value) => {
					settings.keepInVault = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Conversation location")
			.setDesc("Where a conversation note is created, in the same terms as Obsidian's attachments.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						folder: "In the folder specified below",
						note: "Same folder as current note",
					})
					.setValue(settings.conversationLocation)
					.onChange(async (value) => {
						settings.conversationLocation = value === "note" ? "note" : "folder";
						await this.plugin.saveSettings();
						// The folder setting below only applies to one of the two.
						this.display();
					}),
			);

		if (settings.conversationLocation === "folder") {
			new Setting(containerEl)
				.setName("Conversation folder")
				.setDesc("Created on the first answer if it is not there yet.")
				.addText((text) =>
					text
						.setPlaceholder(DEFAULT_SETTINGS.conversationFolder)
						.setValue(settings.conversationFolder)
						.onChange(async (value) => {
							settings.conversationFolder = value.trim() || DEFAULT_SETTINGS.conversationFolder;
							await this.plugin.saveSettings();
						}),
				);
		}

		new Setting(containerEl)
			.setName("A folder per note")
			.setDesc(
				"Group a note's conversations in a subfolder named after it, so five conversations about " +
					"one note are one folder rather than five files. Off, they sit side by side, named " +
					"\u201cNote \u2014 Title\u201d.",
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.conversationSubfolder).onChange(async (value) => {
					settings.conversationSubfolder = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Research heading")
			.setDesc("Heading in the source note that links to its conversations are collected under.")
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

	}
}
