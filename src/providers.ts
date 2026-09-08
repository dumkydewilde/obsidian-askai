/**
 * One adapter per coding-agent CLI. Each turns a question into an argv and turns that
 * CLI's output back into the same small set of events, so everything above this file
 * is written once rather than once per agent.
 */

export type ProviderId = "claude" | "codex" | "gemini" | "custom";

export interface RunContext {
	/** Working directory for the agent. Always the vault root, so wikilinks resolve. */
	vaultPath: string;
	prompt: string;
	/** Instructions for how to answer, from settings. */
	systemPrompt: string;
	/** Continue this conversation instead of starting one. */
	resumeSessionId?: string;
	/** Start a new conversation under this id, for CLIs that let the caller pick one. */
	newSessionId?: string;
	/** Whether this is the first question of the conversation, which names it. */
	firstTurn: boolean;
	model: string;
	effort: string;
	web: boolean;
}

/**
 * What every CLI's output is reduced to. `text` appends to the visible answer,
 * `message` replaces it, and `turn` clears it: between them they cover an agent that
 * streams tokens, one that delivers whole messages, and one that does both.
 */
export type RunEvent =
	| { kind: "session"; id: string }
	| { kind: "model"; id: string }
	| { kind: "turn" }
	| { kind: "text"; delta: string }
	| { kind: "message"; text: string }
	| { kind: "tool"; label: string }
	| { kind: "usage"; input: number | null; output: number | null }
	| { kind: "duration"; ms: number }
	/** The authoritative final answer, when the CLI reports one separately. */
	| { kind: "answer"; text: string }
	| { kind: "failure"; message: string };

export interface Capabilities {
	/** Model names offered per question. The value typed into settings is added to these. */
	models: Record<string, string>;
	/** Thinking-effort values as this CLI spells them. Empty means it has no such control. */
	efforts: Record<string, string>;
	/**
	 * "tools" — the toggle adds or withholds the web tools themselves.
	 * "prompt" — the CLI has no flag for it, so the toggle only asks the model not to.
	 * "none" — no web access to speak of.
	 */
	web: "tools" | "prompt" | "none";
	/** Whether a follow-up can continue an earlier conversation. */
	resume: boolean;
}

export interface Provider {
	id: ProviderId;
	label: string;
	/** Binary name, looked up on PATH unless the setting holds an absolute path. */
	defaultPath: string;
	/** Whether stdout is JSON per line or plain text to be shown as it arrives. */
	output: "json-lines" | "text";
	capabilities: Capabilities;
	/** What this CLI is and is not allowed to do, shown in settings and the README. */
	confinement: string;
	buildArgs(context: RunContext, settings: ProviderSettings): string[];
	/** Only for `output: "json-lines"`. One parsed line in, zero or more events out. */
	parse?(event: Record<string, any>, state: ParseState): RunEvent[];
}

/** The slice of plugin settings a provider needs. Keeps providers.ts free of the UI. */
export interface ProviderSettings {
	/** Argument template for the custom provider, ignored by the others. */
	customArgs: string;
}

/** Scratch space a parser can keep across the lines of one run. */
export interface ParseState {
	vaultPath: string;
	/** Set when a tool result has landed, so the next assistant text starts a new turn. */
	afterTool: boolean;
	/** Claude's tool_use inputs arrive as fragments keyed by content block index. */
	pendingTools: Map<number, { name: string; input: string }>;
}

/** Shortens a path to how the vault shows it, because absolute paths swamp a status line. */
function relative(detail: string, vaultPath: string): string {
	for (const prefix of [`${vaultPath}/`, `/private${vaultPath}/`]) {
		if (detail.startsWith(prefix)) return detail.slice(prefix.length);
	}
	return detail;
}

function toolLabel(name: string, input: Record<string, unknown>, vaultPath: string): string {
	const detail = input.file_path ?? input.pattern ?? input.path ?? input.absolute_path ?? input.query;
	if (typeof detail !== "string" || !detail) return name;
	return `${name} ${relative(detail, vaultPath)}`;
}

function clamp(text: string, max = 80): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Claude holds the system prompt as one, so an instruction about how to *end* an answer
 * still applies at the end. For the CLIs that only get it prepended to the first
 * question it is a page behind by then, and gone entirely on a resumed turn — Codex
 * dropped the follow-up block on every question tried. So the blocks are asked for
 * again after the question, and only while the prompt still asks for them, so deleting
 * either paragraph from settings still turns that block off.
 */
function trailingReminder(context: RunContext): string {
	const parts: string[] = [];
	if (/```follow-ups/.test(context.systemPrompt)) {
		parts.push("End your answer with the ```follow-ups fenced block when there are useful next questions.");
	}
	// Only on the turn that opens a conversation, which is the only turn it is wanted on.
	// Not merely on the turn that opens a session: switching agents opens a second session
	// in a conversation that already has a name.
	if (context.firstTurn && /```title/.test(context.systemPrompt)) {
		parts.push("This is the first answer in this conversation, so end with the ```title block too.");
	}
	return parts.length ? `\n\n${parts.join(" ")}` : "";
}

/**
 * The question as a CLI with no system-prompt flag of its own needs to receive it: the
 * instructions ahead of it on the turn that opens the conversation, and the one line
 * that has to survive to the end of the answer after it, on every turn. A real flag
 * would be better — the model could tell instructions from content — but codex and
 * gemini only take AGENTS.md and GEMINI.md, which live in the vault.
 */
function inlinePrompt(context: RunContext): string {
	const instructions = context.systemPrompt.trim();
	const body = instructions && !context.resumeSessionId ? `${instructions}\n\n---\n\n${context.prompt}` : context.prompt;
	return body + trailingReminder(context);
}

/** For CLIs whose web tools cannot be withheld by a flag. */
function webInstruction(web: boolean): string {
	return web
		? ""
		: "\n\nDo not search or fetch the web for this question. Answer from the vault and your own knowledge.";
}

const SHARED_EFFORTS = {
	"": "Default effort",
	low: "Low",
	medium: "Medium",
	high: "High",
};

/**
 * Every flag here is load-bearing for keeping Claude read-only and confined to the vault:
 *
 * --restricted        drops Bash and the other code-running tools, ignores your user and
 *                     project settings files (which may allow far more than you want a note
 *                     question to reach), and confines the file tools to the working directory.
 * --tools             an exact allowlist from the built-in set. Not a permission grant like
 *                     --allowedTools, which leaves everything else available too.
 * --strict-mcp-config with no --mcp-config, so no MCP server loads.
 * --permission-prompts anything that would still ask is denied rather than hanging forever
 *                      on a prompt nobody can answer.
 */
const claude: Provider = {
	id: "claude",
	label: "Claude Code",
	defaultPath: "claude",
	output: "json-lines",
	confinement: "Read, Grep and Glob only. No writes, no shell, no MCP, your own settings files ignored.",
	capabilities: {
		// Aliases rather than full ids. Claude Code has no command that lists models, so an
		// alias is the only name that keeps pointing at the newest model in its family.
		models: { "": "Default model", fable: "Fable", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" },
		efforts: { ...SHARED_EFFORTS, xhigh: "Extra high", max: "Max" },
		web: "tools",
		resume: true,
	},

	buildArgs(context) {
		const tools = context.web ? "Read,Grep,Glob,WebSearch,WebFetch" : "Read,Grep,Glob";
		const args = [
			"--print",
			"--output-format",
			"stream-json",
			"--include-partial-messages",
			"--verbose",
			"--restricted",
			"--strict-mcp-config",
			"--permission-prompts",
			"none",
			"--tools",
			tools,
			// --tools decides which tools exist at all; --allowedTools pre-approves those same
			// ones so none of them trips a permission prompt that --permission-prompts none
			// would then auto-deny. Without this, WebSearch is present but silently refused.
			"--allowedTools",
			tools,
		];

		if (context.systemPrompt.trim()) args.push("--append-system-prompt", context.systemPrompt.trim());
		if (context.model) args.push("--model", context.model);
		if (context.effort) args.push("--effort", context.effort);
		if (context.resumeSessionId) args.push("--resume", context.resumeSessionId);
		else if (context.newSessionId) args.push("--session-id", context.newSessionId);

		args.push(context.prompt);
		return args;
	},

	parse(event, state) {
		const events: RunEvent[] = [];
		switch (event.type) {
			case "system": {
				if (event.subtype !== "init") break;
				if (typeof event.model === "string") events.push({ kind: "model", id: event.model });
				if (typeof event.session_id === "string") events.push({ kind: "session", id: event.session_id });
				break;
			}
			case "stream_event": {
				const inner = event.event ?? {};
				if (inner.type === "message_start") {
					// A new turn means everything said so far was thinking out loud before a
					// tool call. Drop it: only the last turn is the answer.
					events.push({ kind: "turn" });
				} else if (inner.type === "content_block_start" && inner.content_block?.type === "tool_use") {
					state.pendingTools.set(inner.index, { name: inner.content_block.name, input: "" });
				} else if (inner.type === "content_block_delta") {
					if (inner.delta?.type === "text_delta") {
						events.push({ kind: "text", delta: inner.delta.text ?? "" });
					} else if (inner.delta?.type === "input_json_delta") {
						const pending = state.pendingTools.get(inner.index);
						if (pending) pending.input += inner.delta.partial_json ?? "";
					}
				} else if (inner.type === "content_block_stop") {
					const pending = state.pendingTools.get(inner.index);
					if (pending) {
						state.pendingTools.delete(inner.index);
						let input: Record<string, unknown> = {};
						try {
							input = JSON.parse(pending.input || "{}");
						} catch {
							input = {};
						}
						events.push({ kind: "tool", label: toolLabel(pending.name, input, state.vaultPath) });
					}
				}
				break;
			}
			case "result": {
				if (event.is_error) {
					const message = typeof event.result === "string" && event.result ? event.result : "Claude reported an error.";
					events.push({ kind: "failure", message });
					break;
				}
				if (typeof event.session_id === "string") events.push({ kind: "session", id: event.session_id });
				if (typeof event.duration_ms === "number") events.push({ kind: "duration", ms: event.duration_ms });
				// `input_tokens` alone reads as a handful of tokens even on a large note,
				// because almost everything arrives as a cache read or a cache write.
				const usage = (event.usage ?? {}) as Record<string, unknown>;
				const num = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
				events.push({
					kind: "usage",
					input: num("input_tokens") + num("cache_read_input_tokens") + num("cache_creation_input_tokens") || null,
					output: num("output_tokens") || null,
				});
				events.push({ kind: "answer", text: typeof event.result === "string" ? event.result : "" });
				break;
			}
		}
		return events;
	},
};

/**
 * Codex is sandboxed rather than tool-restricted: `-s read-only` lets it run shell
 * commands but blocks every write and, by default, the network. So it will happily
 * `sed` a note rather than call a read tool. Reads only, but a wider door than Claude's.
 *
 * --ignore-user-config is the closest thing to Claude's --restricted: it drops your
 * ~/.codex/config.toml, and with it the plugins, hooks and MCP servers a note question
 * has no business loading.
 */
const codex: Provider = {
	id: "codex",
	label: "Codex",
	defaultPath: "codex",
	output: "json-lines",
	confinement: "Read-only sandbox: no writes, network off unless web is on. Shell commands do run.",
	capabilities: {
		models: { "": "Default model", "gpt-5.1-codex": "GPT-5.1 Codex", "gpt-5.1-codex-max": "GPT-5.1 Codex Max" },
		efforts: { ...SHARED_EFFORTS, xhigh: "Extra high" },
		web: "tools",
		resume: true,
	},

	buildArgs(context) {
		const args = ["exec"];
		// `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]`, so the subcommand comes first
		// and the id goes in with the positionals at the end.
		if (context.resumeSessionId) args.push("resume");

		// The sandbox goes in through --config rather than --sandbox, which `resume` does
		// not accept, so a fresh run and a resumed one take the same flags.
		args.push(
			"--json",
			"--ignore-user-config",
			"--skip-git-repo-check",
			"--config",
			'sandbox_mode="read-only"',
			"--config",
			`tools.web_search=${context.web}`,
		);
		if (context.model) args.push("--model", context.model);
		if (context.effort) args.push("--config", `model_reasoning_effort="${context.effort}"`);

		if (context.resumeSessionId) args.push(context.resumeSessionId);
		// No --append-system-prompt equivalent, and --ignore-user-config drops the config
		// file that could carry one, so it rides along with the question.
		args.push(inlinePrompt(context));
		return args;
	},

	parse(event, state) {
		const events: RunEvent[] = [];
		switch (event.type) {
			case "thread.started": {
				if (typeof event.thread_id === "string") events.push({ kind: "session", id: event.thread_id });
				break;
			}
			case "item.started":
			case "item.completed": {
				const item = event.item ?? {};
				switch (item.type) {
					case "agent_message":
						// Whole messages, not deltas. A preamble before a tool call arrives as
						// its own message, so each one replaces the last and the final one wins.
						if (event.type === "item.completed" && typeof item.text === "string") {
							events.push({ kind: "message", text: item.text });
						}
						break;
					case "command_execution":
						if (typeof item.command === "string") events.push({ kind: "tool", label: `Shell ${clamp(item.command)}` });
						break;
					case "web_search":
						events.push({ kind: "tool", label: `WebSearch ${clamp(String(item.query ?? ""))}`.trim() });
						break;
					case "mcp_tool_call":
						events.push({ kind: "tool", label: `MCP ${item.server ?? ""} ${item.tool ?? ""}`.trim() });
						break;
					// `error` items are warnings about hooks and context budgets, not failures.
					// The fatal ones arrive as a top-level `error` or as `turn.failed`.
				}
				break;
			}
			case "turn.completed": {
				const usage = (event.usage ?? {}) as Record<string, unknown>;
				const num = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
				// Unlike Claude's, codex's input_tokens is already the whole prompt, cache included.
				events.push({
					kind: "usage",
					input: num("input_tokens") || null,
					output: num("output_tokens") + num("reasoning_output_tokens") || null,
				});
				break;
			}
			case "turn.failed": {
				events.push({ kind: "failure", message: readMessage(event.error) ?? "Codex reported an error." });
				break;
			}
			case "error": {
				events.push({ kind: "failure", message: readMessage(event) ?? "Codex reported an error." });
				break;
			}
		}
		void state;
		return events;
	},
};

/**
 * Gemini has no tool allowlist on the command line. What keeps it read-only is that
 * every tool needing confirmation — write_file, replace, run_shell_command — is
 * treated as denied in headless mode, while the read tools never ask. Its web tools
 * never ask either, which is why the web toggle here is only an instruction.
 */
const gemini: Provider = {
	id: "gemini",
	label: "Gemini CLI",
	defaultPath: "gemini",
	output: "json-lines",
	confinement: "Reads run; writes and shell are denied unprompted in headless mode. Web is asked for, not enforced.",
	capabilities: {
		models: { "": "Default model", pro: "Pro", flash: "Flash", "flash-lite": "Flash Lite" },
		efforts: {},
		web: "prompt",
		resume: true,
	},

	buildArgs(context) {
		const args = ["--output-format", "stream-json", "--approval-mode", "default", "--skip-trust"];
		if (context.model) args.push("--model", context.model);
		if (context.resumeSessionId) args.push("--resume", context.resumeSessionId);
		args.push("--prompt", inlinePrompt(context) + webInstruction(context.web));
		return args;
	},

	parse(event, state) {
		const events: RunEvent[] = [];
		switch (event.type) {
			case "init": {
				if (typeof event.session_id === "string") events.push({ kind: "session", id: event.session_id });
				if (typeof event.model === "string") events.push({ kind: "model", id: event.model });
				break;
			}
			case "message": {
				// The user message is an echo of the prompt; only the assistant deltas are answer.
				if (event.role !== "assistant" || typeof event.content !== "string") break;
				if (state.afterTool) {
					// Text after a tool result begins a new turn, so what came before it was
					// preamble. Nothing marks the boundary, so the tool result stands in for it.
					state.afterTool = false;
					events.push({ kind: "turn" });
				}
				events.push({ kind: "text", delta: event.content });
				break;
			}
			case "tool_use": {
				const parameters = (event.parameters ?? {}) as Record<string, unknown>;
				events.push({ kind: "tool", label: toolLabel(String(event.tool_name ?? "Tool"), parameters, state.vaultPath) });
				break;
			}
			case "tool_result": {
				state.afterTool = true;
				break;
			}
			case "error": {
				if (event.severity === "error") events.push({ kind: "failure", message: String(event.message ?? "Gemini reported an error.") });
				break;
			}
			case "result": {
				if (event.status === "error") {
					events.push({ kind: "failure", message: readMessage(event.error) ?? "Gemini reported an error." });
					break;
				}
				const stats = (event.stats ?? {}) as Record<string, unknown>;
				if (typeof stats.duration_ms === "number") events.push({ kind: "duration", ms: stats.duration_ms });
				events.push({
					kind: "usage",
					input: typeof stats.input_tokens === "number" ? stats.input_tokens : null,
					output: typeof stats.output_tokens === "number" ? stats.output_tokens : null,
				});
				break;
			}
		}
		return events;
	},
};

/**
 * Anything else with a non-interactive mode: opencode, crush, amp, a shell script.
 * Its stdout is the answer, so there is no session to resume, no tool calls to show,
 * and — this is the part worth knowing — no confinement the plugin can promise.
 */
const custom: Provider = {
	id: "custom",
	label: "Custom command",
	defaultPath: "",
	output: "text",
	confinement: "Whatever the command you configured allows. The plugin cannot confine it.",
	capabilities: { models: { "": "Default model" }, efforts: {}, web: "none", resume: false },

	buildArgs(context, settings) {
		const template = splitArgs(settings.customArgs);
		const args: string[] = [];
		let usedPrompt = false;
		for (const part of template) {
			if (part === "{prompt}") {
				args.push(inlinePrompt(context));
				usedPrompt = true;
			} else if (part === "{model}") {
				if (context.model) args.push(context.model);
			} else {
				args.push(part);
			}
		}
		// A template that forgot the placeholder still gets the question, at the end,
		// where every one of these CLIs takes it.
		if (!usedPrompt) args.push(inlinePrompt(context));
		return args;
	},
};

/** Splits an argument template on whitespace, keeping quoted runs together. */
export function splitArgs(template: string): string[] {
	const parts = template.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	return parts.map((part) => (/^["'].*["']$/.test(part) ? part.slice(1, -1) : part));
}

function readMessage(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return null;
	const message = (value as Record<string, unknown>).message;
	if (typeof message !== "string") return null;
	// A codex failure arrives with the upstream API's JSON error nested inside its message.
	try {
		const inner = JSON.parse(message);
		const nested = inner?.error?.message;
		if (typeof nested === "string") return nested;
	} catch {
		// Not JSON, so the message is already the message.
	}
	return message;
}

export const PROVIDERS: Record<ProviderId, Provider> = { claude, codex, gemini, custom };

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export const PROVIDER_LABELS: Record<string, string> = Object.fromEntries(
	PROVIDER_IDS.map((id) => [id, PROVIDERS[id].label]),
);

export function providerOrDefault(id: string): Provider {
	return PROVIDERS[id as ProviderId] ?? PROVIDERS.claude;
}

/** Whether a name off disk — a conversation note's frontmatter — is an agent we have. */
export function isProviderId(id: string): id is ProviderId {
	return id in PROVIDERS;
}
