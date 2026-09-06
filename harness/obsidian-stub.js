// Enough of the Obsidian API to load the real main.js in a browser and mount the real
// view. Not a simulator: every method here either does the one thing the plugin needs
// or records that it was called. Anything the plugin reaches for that is missing throws
// with its own name, which is the point — that is how a crash gets located.

const noop = () => {};

/* ---------- the DOM helpers Obsidian adds to every element ---------- */

function applyOptions(el, o) {
	if (typeof o === "string") o = { cls: o };
	if (!o) return el;
	if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
	if (o.text !== undefined) el.textContent = o.text;
	if (o.type) el.type = o.type;
	if (o.value !== undefined) el.value = o.value;
	if (o.placeholder) el.placeholder = o.placeholder;
	if (o.href) el.href = o.href;
	if (o.title) el.title = o.title;
	if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, String(v));
	return el;
}

export function installDomExtensions(win) {
	const proto = win.HTMLElement.prototype;
	proto.createEl = function (tag, o, callback) {
		const el = applyOptions(this.ownerDocument.createElement(tag), o);
		this.appendChild(el);
		callback?.(el);
		return el;
	};
	proto.createDiv = function (o, cb) {
		return this.createEl("div", o, cb);
	};
	proto.createSpan = function (o, cb) {
		return this.createEl("span", o, cb);
	};
	proto.addClass = function (...cls) {
		this.classList.add(...cls.flatMap((c) => c.split(" ")).filter(Boolean));
	};
	proto.removeClass = function (...cls) {
		this.classList.remove(...cls.flatMap((c) => c.split(" ")).filter(Boolean));
	};
	proto.toggleClass = function (cls, on) {
		for (const c of [cls].flat()) this.classList.toggle(c, on);
	};
	proto.hasClass = function (cls) {
		return this.classList.contains(cls);
	};
	proto.setText = function (text) {
		this.textContent = text;
	};
	proto.setAttr = function (name, value) {
		this.setAttribute(name, String(value));
	};
	proto.empty = function () {
		while (this.firstChild) this.removeChild(this.firstChild);
	};
	proto.detach = function () {
		this.remove();
	};
	Object.defineProperty(win.Node.prototype, "doc", { get() { return this.ownerDocument ?? this; }, configurable: true });
	Object.defineProperty(win.Node.prototype, "win", { get() { return this.doc.defaultView; }, configurable: true });
}

/* ---------- the API module ---------- */

export class Component {
	constructor() {
		this._children = [];
		this._cleanups = [];
	}
	load() {
		this.onload?.();
	}
	unload() {
		for (const fn of this._cleanups) fn();
		this._cleanups = [];
	}
	register(fn) {
		this._cleanups.push(fn);
	}
	registerEvent(ref) {
		if (ref?.off) this._cleanups.push(() => ref.off());
	}
	registerDomEvent(el, type, fn) {
		el.addEventListener(type, fn);
		this._cleanups.push(() => el.removeEventListener(type, fn));
	}
	addChild(child) {
		this._children.push(child);
		child.load?.();
		return child;
	}
	onload() {}
	onunload() {}
}

export class View extends Component {
	constructor(leaf) {
		super();
		this.leaf = leaf;
		this.app = leaf.app;
		this.containerEl = leaf.containerEl.createDiv({ cls: "workspace-leaf-content" });
		this.containerEl.setAttr("data-type", "harness");
		const header = this.containerEl.createDiv({ cls: "view-header" });
		// Undocumented, and load() reads it before onOpen runs. A subclass field of the
		// same name defines it as undefined after super() and the view never opens, so
		// the stub carries it: that failure has to reproduce here rather than in a vault.
		this.titleEl = header.createDiv({ cls: "view-header-title" });
		this.iconEl = header.createDiv({ cls: "view-header-icon" });
		this.contentEl = this.containerEl.createDiv({ cls: "view-content" });
	}

	/** Obsidian's order: attach, load, then onOpen. A throw in load skips onOpen. */
	async open() {
		this.load();
		await this.onOpen?.();
	}
}

export class ItemView extends View {
	load() {
		super.load();
		this.titleEl.setText(this.getDisplayText());
	}
}

export class Plugin extends Component {
	constructor(app, manifest) {
		super();
		this.app = app;
		this.manifest = manifest;
		this.views = new Map();
		this.commands = [];
	}
	addSettingTab() {}
	addCommand(command) {
		this.commands.push(command);
	}
	addRibbonIcon() {
		return document.createElement("div");
	}
	registerView(type, factory) {
		this.views.set(type, factory);
	}
	async loadData() {
		return this.app._data;
	}
	async saveData(data) {
		this.app._data = data;
	}
}

export class PluginSettingTab extends Component {
	constructor(app, plugin) {
		super();
		this.app = app;
		this.plugin = plugin;
		this.containerEl = document.createElement("div");
	}
}

export class Modal extends Component {
	constructor(app) {
		super();
		this.app = app;
		this.modalEl = document.createElement("div");
		this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
	}
	open() {
		this.onOpen?.();
	}
	close() {
		this.onClose?.();
	}
	setTitle() {}
}

export class Setting {
	constructor(containerEl) {
		this.settingEl = containerEl.createDiv({ cls: "setting-item" });
		this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
	}
	setName() { return this; }
	setDesc() { return this; }
	addText() { return this; }
	addTextArea() { return this; }
	addToggle() { return this; }
	addDropdown() { return this; }
	addButton(cb) {
		const button = this.controlEl.createEl("button");
		cb({
			setButtonText(text) { button.textContent = text; return this; },
			setCta() { button.addClass("mod-cta"); return this; },
			setDisabled(on) { button.disabled = on; return this; },
			onClick(fn) { button.addEventListener("click", fn); return this; },
		});
		return this;
	}
}

export class Notice {
	constructor(message) {
		console.info(`[Notice] ${message}`);
	}
}

export class TAbstractFile {}
export class TFile extends TAbstractFile {
	constructor(path) {
		super();
		this.path = path;
		this.name = path.split("/").pop();
		this.basename = this.name.replace(/\.md$/, "");
		this.extension = this.name.includes(".") ? this.name.split(".").pop() : "";
	}
}
export class TFolder extends TAbstractFile {}
export class MarkdownView extends View {}
export class FileSystemAdapter {
	getBasePath() {
		return "/harness/vault";
	}
}
export class Menu {}
export class Editor {}
export class WorkspaceLeaf {}

export const MarkdownRenderer = {
	async render(app, markdown, el, sourcePath, component) {
		el.createDiv({ text: markdown });
	},
};

export function setIcon(el, icon) {
	el.innerHTML = `<svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/></svg>`;
	el.setAttr("data-icon", icon);
}

export function setTooltip(el, tooltip) {
	el.setAttribute("aria-label", tooltip);
}

export function normalizePath(path) {
	return path.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}
