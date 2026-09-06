import { spawn } from "child_process";
import { homedir } from "os";
import {
	providerOrDefault,
	type ParseState,
	type Provider,
	type RunContext,
	type RunEvent,
} from "./providers";
import type { AskAiSettings } from "./settings";

export interface AskRequest {
	/** Working directory for the agent. Always the vault root, so wikilinks resolve. */
	vaultPath: string;
	prompt: string;
	/** Which CLI answers this question. */
	provider: string;
	/** Continue this conversation instead of starting one. */
	resumeSessionId?: string;
	/** Start a new conversation under this id, for CLIs that let the caller pick one. */
	newSessionId?: string;
	model: string;
	effort: string;
	web: boolean;
}

export interface AskHandlers {
	/** The visible answer so far, after each change to it. */
	onAnswer(markdown: string): void;
	/** A tool call, already formatted for display ("Read Ideas/Ducks.md"). */
	onTool(label: string): void;
}

export interface AskResult {
	answer: string;
	/** Empty when the CLI has no resumable session, which rules out a follow-up. */
	sessionId: string;
	/** The model the CLI actually resolved, which an alias like "fable" hides. */
	model: string | null;
	durationMs: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
}

export class AskError extends Error {}

/**
 * Strips the escape codes a CLI written for a terminal leaves in its plain-text output.
 * Anchored on the escape character, so it cannot eat a markdown link.
 */
const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;

function buildPath(settings: AskAiSettings): string {
	const extra = settings.extraPath
		.split(":")
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => (entry.startsWith("~") ? homedir() + entry.slice(1) : entry));
	return [...extra, process.env.PATH ?? ""].filter(Boolean).join(":");
}

function binaryFor(settings: AskAiSettings, provider: Provider): string {
	return settings.paths[provider.id]?.trim() || provider.defaultPath;
}

export function runAgent(
	settings: AskAiSettings,
	request: AskRequest,
	handlers: AskHandlers,
	signal: AbortSignal,
): Promise<AskResult> {
	const provider = providerOrDefault(request.provider);
	const binary = binaryFor(settings, provider);

	return new Promise<AskResult>((resolve, reject) => {
		if (!binary) {
			reject(new AskError(`No command is set for ${provider.label}. Set one in the Ask AI settings.`));
			return;
		}

		const context: RunContext = {
			vaultPath: request.vaultPath,
			prompt: request.prompt,
			systemPrompt: settings.systemPrompt,
			resumeSessionId: request.resumeSessionId,
			newSessionId: request.newSessionId,
			model: request.model,
			effort: request.effort,
			web: request.web,
		};

		let args: string[];
		try {
			args = provider.buildArgs(context, { customArgs: settings.customArgs });
		} catch (error) {
			reject(new AskError(error instanceof Error ? error.message : String(error)));
			return;
		}

		const child = spawn(binary, args, {
			cwd: request.vaultPath,
			env: { ...process.env, PATH: buildPath(settings) },
			stdio: ["ignore", "pipe", "pipe"],
		});

		const state: ParseState = { vaultPath: request.vaultPath, afterTool: false, pendingTools: new Map() };
		let stdoutBuffer = "";
		let stderr = "";
		// What is on screen, which `turn` clears and `message` replaces. When the CLI
		// never reports a final answer of its own, this is the answer.
		let visible = "";
		let answer: string | null = null;
		let sessionId = request.resumeSessionId ?? "";
		let model: string | null = null;
		let durationMs: number | null = null;
		let inputTokens: number | null = null;
		let outputTokens: number | null = null;
		let failure: string | null = null;
		let settled = false;

		const timer = setTimeout(() => {
			failure = `${provider.label} did not answer within ${settings.timeoutSeconds} seconds.`;
			child.kill("SIGTERM");
		}, settings.timeoutSeconds * 1000);

		const onAbort = () => child.kill("SIGTERM");
		signal.addEventListener("abort", onAbort);

		const finish = (error: Error | null, value?: AskResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve(value as AskResult);
		};

		const apply = (event: RunEvent) => {
			switch (event.kind) {
				case "session":
					sessionId = event.id;
					break;
				case "model":
					model = event.id;
					break;
				case "turn":
					if (!visible) break;
					visible = "";
					handlers.onAnswer(visible);
					break;
				case "text":
					if (!event.delta) break;
					visible += event.delta;
					handlers.onAnswer(visible);
					break;
				case "message":
					visible = event.text;
					handlers.onAnswer(visible);
					break;
				case "tool":
					handlers.onTool(event.label);
					break;
				case "usage":
					inputTokens = event.input;
					outputTokens = event.output;
					break;
				case "duration":
					durationMs = event.ms;
					break;
				case "answer":
					answer = event.text;
					break;
				case "failure":
					failure = event.message;
					break;
			}
		};

		const handleLine = (line: string) => {
			if (!line) return;
			// Parse and dispatch are separate: a line we cannot parse is not worth failing
			// the answer over, but a bug in a handler should not be swallowed as if it
			// were malformed input.
			let parsed: Record<string, any> | null = null;
			try {
				parsed = JSON.parse(line);
			} catch {
				parsed = null;
			}
			if (!parsed || !provider.parse) return;
			for (const event of provider.parse(parsed, state)) apply(event);
		};

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (provider.output === "text") {
				apply({ kind: "text", delta: chunk.replace(ANSI, "") });
				return;
			}
			stdoutBuffer += chunk;
			// JSONL is one object per line, and a chunk can split a line anywhere.
			let newline = stdoutBuffer.indexOf("\n");
			while (newline !== -1) {
				handleLine(stdoutBuffer.slice(0, newline).trim());
				stdoutBuffer = stdoutBuffer.slice(newline + 1);
				newline = stdoutBuffer.indexOf("\n");
			}
		});

		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});

		child.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") {
				finish(
					new AskError(
						`Could not find "${binary}". Set its full path, or add its directory to ` +
							"Extra PATH entries, in the Ask AI settings.",
					),
				);
				return;
			}
			finish(new AskError(error.message));
		});

		child.on("close", (code) => {
			// A final line without a trailing newline would otherwise be dropped.
			if (provider.output !== "text") handleLine(stdoutBuffer.trim());

			const finalAnswer = (answer ?? visible).trim();
			if (signal.aborted) {
				finish(new AskError("Cancelled."));
			} else if (failure) {
				finish(new AskError(failure));
			} else if (finalAnswer) {
				finish(null, { answer: finalAnswer, sessionId, model, durationMs, inputTokens, outputTokens });
			} else {
				const tail = stderr.trim().replace(ANSI, "").split("\n").slice(-5).join("\n");
				finish(new AskError(tail || `${provider.label} exited with code ${code} and said nothing.`));
			}
		});
	});
}
