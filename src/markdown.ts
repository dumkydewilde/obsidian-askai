/**
 * Getting the markdown for one block of a rendered answer back out of it. Copying a
 * paragraph in an Obsidian pane and losing its [[wikilinks]] and `code` on the way to
 * a note is the wrong trade, and the rendered DOM only has the text.
 */

/** Blocks in the order a markdown renderer emits elements for them. */
export function splitBlocks(markdown: string): string[] {
	const blocks: string[] = [];
	let current: string[] = [];
	let fence: string | null = null;

	const flush = () => {
		const block = current.join("\n").trim();
		if (block) blocks.push(block);
		current = [];
	};

	for (const line of markdown.split("\n")) {
		const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];
		if (fence) {
			current.push(line);
			// A fence closes on the same character, at least as long as the one that opened it.
			if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
				fence = null;
				flush();
			}
			continue;
		}
		if (marker) {
			flush();
			fence = marker;
			current.push(line);
			continue;
		}
		if (!line.trim()) {
			flush();
			continue;
		}
		current.push(line);
	}
	flush();
	return blocks;
}

/** Enough of the syntax gone that a source block and its rendered text can be compared. */
function plain(text: string): string {
	return text
		.replace(/```+[^\n]*|~~~+[^\n]*/g, "")
		.replace(/\[\[([^\]|]*)\|?([^\]]*)\]\]/g, (_, target, alias) => alias || target)
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_`~#>]/g, "")
		.replace(/^\s*(?:[-*+]|\d+[.)])\s*/gm, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

/**
 * One markdown block per rendered block, matched by walking both in order. The two do
 * not correspond one to one — a list split by blank lines is several source blocks and
 * one element — so it resyncs by looking ahead, and hands back the rendered text
 * rather than a wrong block whenever the two stop agreeing.
 */
export function alignBlocks(rendered: string[], markdown: string): string[] {
	const blocks = splitBlocks(markdown);
	const matched: string[] = [];
	let cursor = 0;

	for (const text of rendered) {
		const want = plain(text);
		let found = "";
		for (let i = cursor; i < Math.min(blocks.length, cursor + 4); i++) {
			const candidate = plain(blocks[i]);
			if (!candidate || !want) continue;
			const head = Math.min(24, candidate.length, want.length);
			if (candidate.slice(0, head) === want.slice(0, head)) {
				found = blocks[i];
				cursor = i + 1;
				break;
			}
		}
		matched.push(found || text);
	}
	return matched;
}
