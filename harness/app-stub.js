// A workspace with one markdown note open and one right-sidebar leaf, which is all the
// sidebar view asks the app for.
import { FileSystemAdapter, TFile } from "./obsidian-stub.js";

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

export function createApp({ data, files, activePath, leafContainer }) {
	const byPath = new Map(files.map((path) => [path, new TFile(path)]));

	const workspace = Object.assign(new Events(), {
		getActiveFile: () => byPath.get(activePath) ?? null,
		onLayoutReady: (fn) => fn(),
		getActiveViewOfType: () => null,
		getLeavesOfType: () => [],
		getRightLeaf: () => null,
		revealLeaf: async () => {},
	});

	const vault = Object.assign(new Events(), {
		adapter: new FileSystemAdapter(),
		getAbstractFileByPath: (path) => byPath.get(path) ?? null,
		create: async () => {
			throw new Error("harness vault is read-only");
		},
		createFolder: async () => {},
		process: async () => {},
	});

	const app = {
		_data: data,
		workspace,
		vault,
		fileManager: { generateMarkdownLink: (file) => `[[${file.basename}]]` },
		metadataCache: new Events(),
	};

	const leaf = { app, containerEl: leafContainer };
	return { app, leaf, open: (path) => workspace.trigger("file-open", byPath.get(path) ?? null) };
}
