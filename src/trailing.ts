/**
 * The agent ends an answer with blocks that are not part of it: the next questions
 * worth asking, and — on the first answer of a conversation — a title for it. Both
 * arrive as fenced blocks so they can be lifted out and used as buttons and as a
 * filename, which means they have to come out of the answer before it is rendered,
 * written to the note or copied.
 */

const TAGS = ["follow-ups", "followups", "title"];

function block(tag: string): RegExp {
	return new RegExp(`\\n*^[ \\t]*\`{3,}[ \\t]*${tag}[ \\t]*\\r?\\n([\\s\\S]*?)^[ \\t]*\`{3,}[ \\t]*$`, "im");
}

const FOLLOW_UPS = block("follow-?ups?");
const TITLE = block("title");

/** Either block, opened but with no closing fence yet. */
const PARTIAL = new RegExp(`\\n*^[ \\t]*\`{3,}[ \\t]*(?:follow-?ups?|title)\\b[\\s\\S]*$`, "im");

/**
 * The fence itself, still arriving a character at a time, so it does not flash up as
 * an empty code block. Anchored to the end of what has streamed so far: a fence that
 * opens a block further up the answer is a real one and stays. Only prefixes of the
 * tags are stripped, so a half-typed ```sql is left where it is.
 */
const OPENING = new RegExp(
	`\\n+[ \\t]*\`{1,3}[ \\t]*(?:${TAGS.flatMap((tag) => Array.from(tag, (_, i) => tag.slice(0, i + 1)))
		.sort((a, b) => b.length - a.length)
		.join("|")})?[ \\t]*$`,
	"i",
);

export interface TrailingBlocks {
	answer: string;
	/** Up to three next questions, offered under the answer as buttons. */
	suggestions: string[];
	/** The agent's name for the conversation, empty when it did not offer one. */
	title: string;
}

export function splitTrailing(answer: string): TrailingBlocks {
	let body = answer;
	const suggestions: string[] = [];
	let title = "";

	const followUps = body.match(FOLLOW_UPS);
	if (followUps) {
		suggestions.push(
			...followUps[1]
				.split("\n")
				// A model that was told "one per line" still reaches for a bullet or a number.
				.map((line) => line.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]*/, "").trim())
				.filter(Boolean)
				.slice(0, 3),
		);
		body = body.replace(FOLLOW_UPS, "");
	}

	const titled = body.match(TITLE);
	if (titled) {
		title = titled[1].split("\n").map((line) => line.trim()).filter(Boolean)[0] ?? "";
		body = body.replace(TITLE, "");
	}

	return { answer: body.trimEnd(), suggestions, title };
}

export function stripTrailing(markdown: string): string {
	const closed = splitTrailing(markdown);
	const body = closed.suggestions.length || closed.title ? closed.answer : markdown;
	return body.replace(PARTIAL, "").replace(OPENING, "").trimEnd();
}
