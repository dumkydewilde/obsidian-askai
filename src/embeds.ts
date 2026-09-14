/**
 * Image embeds as a note writes them, found by where they sit on a line so the
 * right-click menu can tell which one the caret is in. Resolving a target to a file in
 * the vault is the caller's job — no Obsidian imports, so `npm run check` runs this
 * without an app.
 */

/** Extensions an agent's read tool will look at. SVG is text, and reads as text. */
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg"];

export interface Embed {
	/** The link target as written, without the `|size` or `#fragment` after it. */
	target: string;
	start: number;
	end: number;
}

const WIKILINK = /!\[\[([^\]\n]+)\]\]/g;
const MARKDOWN = /!\[[^\]\n]*\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)/g;

export function isImagePath(target: string): boolean {
	const name = target.split(/[?#]/)[0];
	const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
	return IMAGE_EXTENSIONS.includes(extension);
}

/** Every image embed on one line, in the order they were written. */
export function imageEmbedsIn(line: string): Embed[] {
	const found: Embed[] = [];
	for (const pattern of [WIKILINK, MARKDOWN]) {
		pattern.lastIndex = 0;
		for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
			const target = cleanTarget(match[1]);
			if (target && isImagePath(target)) {
				found.push({ target, start: match.index, end: match.index + match[0].length });
			}
		}
	}
	return found.sort((a, b) => a.start - b.start);
}

/**
 * The embed the caret is in, or the first one on the line when it is elsewhere — a
 * caret parked at the start of a line holding one diagram still means that diagram.
 */
export function imageEmbedAt(line: string, ch: number): Embed | null {
	const embeds = imageEmbedsIn(line);
	return embeds.find((embed) => ch >= embed.start && ch <= embed.end) ?? embeds[0] ?? null;
}

/** `![[diagram.png|300]]` and `![](assets/my%20diagram.png)` both name the same file. */
function cleanTarget(raw: string): string {
	const target = raw.split("|")[0].split("#")[0].trim();
	try {
		return decodeURIComponent(target);
	} catch {
		// A stray % in a filename is not an escape, and the raw name is the right guess.
		return target;
	}
}
