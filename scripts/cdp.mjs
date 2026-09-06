#!/usr/bin/env node
// Evaluate an expression inside the running Obsidian window, for checking the UI
// against the real app. Launch Obsidian with --remote-debugging-port=9222 first.
//
//   node scripts/cdp.mjs 'app.plugins.plugins["ask-ai"] !== undefined'
//   node scripts/cdp.mjs --file probe.js
//   node scripts/cdp.mjs --screenshot shot.png 'app.commands.executeCommandById("...")'

import { readFile, writeFile } from "node:fs/promises";

const port = process.env.CDP_PORT ?? "9222";
let args = process.argv.slice(2);
let screenshot = null;
if (args[0] === "--screenshot") {
	screenshot = args[1];
	args = args.slice(2);
}
const expression = args[0] === "--file" ? await readFile(args[1], "utf8") : args.join(" ");

const targets = await (await fetch(`http://localhost:${port}/json/list`)).json();
const page = targets.find((t) => t.type === "page" && t.url.startsWith("app://"));
if (!page) {
	console.error("No Obsidian window found. Targets:", targets.map((t) => `${t.type} ${t.url}`).join(", "));
	process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();

socket.addEventListener("message", (event) => {
	const message = JSON.parse(event.data);
	const resolve = pending.get(message.id);
	if (resolve) {
		pending.delete(message.id);
		resolve(message);
	}
});

function send(method, params) {
	const id = nextId++;
	return new Promise((resolve) => {
		pending.set(id, resolve);
		socket.send(JSON.stringify({ id, method, params }));
	});
}

await new Promise((resolve, reject) => {
	socket.addEventListener("open", resolve, { once: true });
	socket.addEventListener("error", reject, { once: true });
});

const { result } = await send("Runtime.evaluate", {
	expression: `(async () => { ${expression} })()`,
	awaitPromise: true,
	returnByValue: true,
	userGesture: true,
});

if (result.exceptionDetails) {
	console.error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
	socket.close();
	process.exit(1);
}
console.log(typeof result.result.value === "string" ? result.result.value : JSON.stringify(result.result.value, null, 2));

if (screenshot) {
	const shot = await send("Page.captureScreenshot", { format: "png" });
	await writeFile(screenshot, Buffer.from(shot.result.data, "base64"));
	console.log(`screenshot: ${screenshot}`);
}
socket.close();
