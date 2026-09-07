// A workspace with markdown notes and one right-sidebar leaf, over a vault that is a
// Map of paths to strings. Not a simulator: it does the one thing per method the plugin
// needs. But conversations are files now, so the files have to be real enough to be
// created, read back, appended to and found by frontmatter — that is the whole feature.
import { FileSystemAdapter, TFile, TFolder } from "./obsidian-stub.js";

class Events {
	constructor() {
		this.handlers = new Map();
	}
	on(name, fn) {
		const list = this.handlers.get(name) ?? [];
		list.push(fn);
		this.handlers.set(name, list);
		return { off: () => this.handlers.set(name, (this.handlers.get(name) ?? []).filter((f) => f !== fn)) };
	}
	trigger(name, ...args) {
		for (const fn of this.handlers.get(name) ?? []) fn(...args);
	}
}

/** Frontmatter and `##` headings, which is all of Obsidian's cache the plugin reads. */
function parseCache(content) {
	const cache = { frontmatter: undefined, headings: [] };
	let body = content;
	if (content.startsWith("---\n")) {
		const end = content.indexOf("\n---", 3);
		if (end !== -1) {
			const frontmatter = {};
			let list = null;
			for (const line of content.slice(4, end + 1).split("\n")) {
				const item = line.match(/^\s+-\s*(.*)$/);
				if (list && item) {
					list.push(unquote(item[1]));
					continue;
				}
				list = null;
				const match = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
				if (!match) continue;
				if (match[2].trim() === "") frontmatter[match[1]] = list = [];
				else frontmatter[match[1]] = unquote(match[2]);
			}
			cache.frontmatter = frontmatter;
			body = content.slice(content.indexOf("\n", end + 1) + 1);
		}
	}
	let inFence = false;
	for (const line of body.split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
		const match = !inFence && line.match(/^(#{1,6})\s+(.*)$/);
		if (match) cache.headings.push({ level: match[1].length, heading: match[2].trim() });
	}
	return cache;
}

function unquote(value) {
	const trimmed = value.trim();
	const quoted = trimmed.match(/^"([\s\S]*)"$/) ?? trimmed.match(/^'([\s\S]*)'$/);
	return quoted ? quoted[1].replace(/\\"/g, '"') : trimmed;
}

export function createApp({ data, notes, activePath, leafContainer }) {
	/** path -> content. The vault. */
	const contents = new Map(Object.entries(notes));
	const files = new Map();
	const folders = new Map();

	const parentOf = (path) => {
		const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		if (!folders.has(dir)) folders.set(dir, Object.assign(new TFolder(), { path: dir }));
		return folders.get(dir);
	};
	const track = (path) => {
		const file = new TFile(path);
		file.stat = { mtime: Date.now(), ctime: Date.now(), size: (contents.get(path) ?? "").length };
		file.parent = parentOf(path);
		files.set(path, file);
		return file;
	};
	for (const path of contents.keys()) track(path);

	const workspace = Object.assign(new Events(), {
		getActiveFile: () => files.get(activePath) ?? null,
		onLayoutReady: (fn) => fn(),
		getActiveViewOfType: () => null,
		getLeavesOfType: () => [],
		getRightLeaf: () => null,
		revealLeaf: async () => {},
		getLeaf: () => ({ openFile: async (file) => console.info(`[open] ${file.path}`) }),
	});

	const vault = Object.assign(new Events(), {
		adapter: new FileSystemAdapter(),
		getAbstractFileByPath: (path) => files.get(path) ?? folders.get(path) ?? null,
		getMarkdownFiles: () => [...files.values()].filter((file) => file.extension === "md"),
		cachedRead: async (file) => contents.get(file.path) ?? "",
		read: async (file) => contents.get(file.path) ?? "",
		create: async (path, content) => {
			if (contents.has(path)) throw new Error(`${path} already exists`);
			contents.set(path, content);
			const file = track(path);
			vault.trigger("create", file);
			return file;
		},
		createFolder: async (path) => {
			if (folders.has(path)) throw new Error(`${path} already exists`);
			folders.set(path, Object.assign(new TFolder(), { path }));
		},
		process: async (file, fn) => {
			const next = fn(contents.get(file.path) ?? "");
			contents.set(file.path, next);
			metadataCache.trigger("changed", file);
			return next;
		},
	});

	const metadataCache = Object.assign(new Events(), {
		getFileCache: (file) => parseCache(contents.get(file.path) ?? ""),
		// Link resolution by basename, which is how a vault without duplicate names behaves.
		getFirstLinkpathDest: (linkpath) =>
			files.get(linkpath) ??
			files.get(`${linkpath}.md`) ??
			[...files.values()].find((file) => file.basename === linkpath) ??
			null,
		resolvedLinks: {},
	});

	const app = {
		_data: data,
		workspace,
		vault,
		fileManager: { generateMarkdownLink: (file, _from, _sub, alias) => `[[${file.basename}${alias ? `|${alias}` : ""}]]` },
		metadataCache,
	};

	const leaf = { app, containerEl: leafContainer };
	return {
		app,
		leaf,
		open: (path) => workspace.trigger("file-open", files.get(path) ?? null),
		/** What is on disk, so the page can show what the plugin actually wrote. */
		dump: () => Object.fromEntries(contents),
	};
}
