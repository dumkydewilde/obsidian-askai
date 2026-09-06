/**
 * The agent ends an answer with the next questions worth asking, in a fenced block
 * tagged `follow-ups`. They are offered as buttons rather than prose, so the block
 * comes out of the answer before it is rendered, saved or copied.
 */

const BLOCK = /\n*^[ \t]*`{3,}[ \t]*follow-?ups?[ \t]*\r?\n([\s\S]*?)^[ \t]*`{3,}[ \t]*$/im;

/** The same block mid-stream, opened but with no closing fence yet. */
const PARTIAL = /\n*^[ \t]*`{3,}[ \t]*follow-?ups?\b[\s\S]*$/im;

/**
 * The fence itself, still arriving a character at a time, so it does not flash up as
 * an empty code block. Anchored to the end of what has streamed so far: a fence that
 * opens a block further up the answer is a real one and stays.
 */
const OPENING = /\n+[ \t]*`{1,3}[ \t]*(?:f|fo|fol|foll|follo|follow|follow-|follow-u|follow-up|follow-ups)?[ \t]*$/i;

export function splitSuggestions(answer: string): { answer: string; suggestions: string[] } {
	const match = answer.match(BLOCK);
	if (!match) return { answer, suggestions: [] };
	const suggestions = match[1]
		.split("\n")
		// A model that was told "one per line" still reaches for a bullet or a number.
		.map((line) => line.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]*/, "").trim())
		.filter(Boolean)
		.slice(0, 3);
	return { answer: answer.replace(BLOCK, "").trimEnd(), suggestions };
}

export function stripSuggestions(markdown: string): string {
	const closed = splitSuggestions(markdown);
	if (closed.suggestions.length) return closed.answer;
	return markdown.replace(PARTIAL, "").replace(OPENING, "").trimEnd();
}
