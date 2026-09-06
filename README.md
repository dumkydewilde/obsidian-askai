# ask-ai

An Obsidian plugin. Right-click inside a note, ask a coding-agent CLI a question
about it, and read the answer in a sidebar or a modal without leaving the app.

Claude Code, Codex and Gemini CLI ship with the plugin. Anything else with a
non-interactive mode — opencode, crush, a shell script — goes in as a custom
command. Whichever you pick runs with the vault as its working directory, so its
own context file applies and `[[wikilinks]]` resolve.

## What you get

- **Ask AI about this note** in the editor right-click menu, the file explorer
  right-click menu, and the command palette.
- **Ask AI about the selection** when text is selected. The passage stays with
  the question in the conversation and in the saved note, so "what does this do?"
  still makes sense a week later.
- **Follow up** in the same conversation, from the box under the answer or from
  the right-click menu later. One conversation per note, remembered across
  restarts, resumed by the agent that started it.
- **A conversation per note in the sidebar.** It follows whichever note is open:
  switch notes and the sidebar switches with you, back to that note's questions
  and answers and its scroll position, still streaming if it was streaming. They
  survive a restart too — the twenty most recently asked-about notes keep their
  conversation, so a note you asked about last week opens on what it said rather
  than on a blank pane that a follow-up would silently continue. The icon in the
  header starts that note over.
- **Suggested follow-ups.** The agent ends an answer with up to three next
  questions when there are useful ones, and they turn into buttons under the
  answer. Answers are short by default because of it: the detail is a click away
  instead of pre-emptive. Cut the paragraph about it from the system prompt in
  settings and both the block and the buttons stop appearing.
- **Agent, model, thinking effort, and whether to search the web** picked per
  question: in the question box, and behind the cog in the conversation footer.
  Each choice sticks as the default for the next one. The controls redraw for
  the agent you pick, because one CLI's model names mean nothing to another.
- **Save to new note** turns a conversation into a research note beside the note
  it is about, linked from it under a `## Research` heading. One button for the
  whole conversation: later answers are appended to that same note, and once
  there are two questions it grows a `## Contents` list of heading links.
- **Keep conversations in the vault**, off by default, does that on every answer
  instead of on a button. Conversations then are notes — searchable, linkable,
  in the graph — and each carries a `type: ask-ai-conversation` property, so a
  Base can list them as a table without needing a folder query.
- **A sidebar or a modal**, whichever you set. The sidebar stays open beside the
  note; the modal covers it and closes on Escape.
- Answers render as markdown *while* they stream, with a copy button in the
  turn's corner and a second one that follows the pointer from block to block —
  that one copies the block's *source*, so a paragraph lifted into a note keeps
  its `[[wikilinks]]` and its code. The line under each question shows what the
  agent is reading while it works, then the model, how long it took, and tokens
  in and out.
- **Citations are links.** A claim from the vault is cited as
  `[[note name#heading]]`, so clicking it opens the note at the passage the
  answer came from rather than naming a heading you then have to go find.

## Install

```bash
cd ask-ai
npm install
npm run build
npm run install-local -- "/path/to/your/vault"
```

Then enable **Ask AI** under Settings, Community plugins. After a later
`npm run build`, rerun `install-local` and reload the vault window (Cmd+R).

The reload is not optional: a new `main.js` under a running Obsidian is only
picked up on Cmd+R.

Upgrading from `obsidian-ask`: this installs under a new plugin id, so it is a
fresh install rather than an update. Disable the old one and delete
`.obsidian/plugins/obsidian-ask` once you are happy. To keep your settings and
open conversations, copy its `data.json` into
`.obsidian/plugins/ask-ai/` before enabling — the old `claudePath` and `model`
become Claude Code's, and every remembered session is tagged as Claude Code's.

BRAT is not an option from here. It reads `manifest.json` from a repository root
and downloads `main.js` from a matching release, and this is a monorepo with the
plugin in a subfolder.

## Agents

| Agent | Command | What it can do |
|---|---|---|
| Claude Code | `claude` | Read, Grep, Glob only. No writes, no shell, no MCP, your own settings files ignored |
| Codex | `codex` | Read-only sandbox: no writes, network off unless web is on. Shell commands do run |
| Gemini CLI | `gemini` | Reads run; writes and shell are denied unprompted in headless mode. Web is asked for, not enforced |
| Custom command | yours | Whatever your command allows. The plugin cannot confine it |

Each agent keeps its own command path and its own model in settings, so you can
switch between them without retyping either.

### Claude Code

```
claude --print --output-format stream-json --include-partial-messages --verbose \
       --restricted --strict-mcp-config --permission-prompts none \
       --tools Read,Grep,Glob --allowedTools Read,Grep,Glob ...
```

- `--tools Read,Grep,Glob` is an exact allowlist from the built-in set. This is
  not the same as `--allowedTools`, which pre-approves those tools but leaves
  everything else available. An earlier version of this plugin used
  `--allowedTools` alone and Claude reached for `Bash` and `cat` anyway.
- Both flags are needed, for different jobs. `--tools` decides which tools exist
  at all; `--allowedTools` pre-approves those same ones so none of them trips a
  permission prompt that `--permission-prompts none` would auto-deny. Without
  the second flag, `WebSearch` is present but silently refused.
- With **Search the web** on, `WebSearch` and `WebFetch` join both lists.
  Nothing else changes: still no writes, still no shell.
- `--restricted` drops Bash and the other code-running tools, ignores your user
  and project settings files, and confines the file tools to the working
  directory. Your own permissive `~/.claude/settings.json` does not widen what a
  note question can reach.
- Reads `CLAUDE.md` from the vault root, and takes the plugin's system prompt
  through `--append-system-prompt`.

### Codex

```
codex exec --json --ignore-user-config --skip-git-repo-check \
      --sandbox read-only --config tools.web_search=false ...
```

Codex is sandboxed rather than tool-restricted. `--sandbox read-only` blocks
every write and, by default, the network — but it does not stop Codex running
shell commands to read, so in practice it will `sed` a note rather than call a
read tool. Reads only, but a wider door than Claude's.

`--ignore-user-config` is the closest thing to Claude's `--restricted`: it drops
your `~/.codex/config.toml` and with it the plugins, hooks and MCP servers a note
question has no business loading. It costs a little — on a stock setup the same
question went from 52k input tokens to 18k.

Codex has no flag for a system prompt, so the plugin's rides in ahead of the
question. Prepended alone it ignored the follow-up block on every question tried,
which is what the trailing reminder is for. It reads `AGENTS.md` from the vault
root. Follow-ups resume through
`codex exec resume <thread id>`. It never names the model it ran, so the footer
falls back to "Codex".

### Gemini CLI

```
gemini --output-format stream-json --approval-mode default --skip-trust ...
```

What keeps Gemini read-only is that in headless mode every tool needing
confirmation — `write_file`, `replace`, `run_shell_command` — is treated as
denied, while the read tools never ask. There is no tool allowlist on the command
line to make that explicit.

Its web tools never ask either, and there is no flag to withhold them, so
**Search the web** off is an instruction appended to the question rather than a
restriction. `--skip-trust` trusts the vault folder for the run, without which
the folder-trust check can disable tools in a vault you have not opened in Gemini
before. Like Codex, it takes the system prompt ahead of the question, and it
reads `GEMINI.md` from the vault root.

This adapter is written to Gemini's documented headless contract and its
`stream-json` event schema. It has not been run against a live `gemini` binary —
`npm run smoke -- gemini` will tell you.

### Custom command

Set the command and its arguments. `{prompt}` is replaced by the question and
`{model}` by the model, quoted runs stay together, and a template with no
`{prompt}` gets the question appended. Stdout is read as the answer with terminal
escape codes stripped, so there are no tool calls to show, no session to follow up
on, and no confinement the plugin can promise.

```
Command    opencode
Arguments  run {prompt}
```

## Settings

| Setting | Default | Why you would change it |
|---|---|---|
| Agent | Claude Code | Ask a different CLI. Also selectable per question |
| *Agent* command | the agent's own name | Your binary is somewhere unusual |
| Arguments | `run {prompt}` | Custom command only |
| Extra PATH entries | `~/.local/bin:/opt/homebrew/bin:/usr/local/bin` | Obsidian launched from Finder has almost no PATH, so the binary is not found |
| Model | empty | Pin a model instead of using the agent's default. Kept per agent |
| Thinking effort | empty | Pin an effort level. Hidden for agents that have none |
| Search the web | off | Let answers cite sources outside the vault |
| Open answers in | Modal | Keep the conversation beside the note instead of over it |
| Research folder | empty | Collect saved answers in one folder instead of beside each note |
| Research heading | `## Research` | Match your own note conventions |
| Timeout | 180s | Long questions over a large vault |
| System prompt | see below | Change how answers are written |
| Conversations | — | "Forget all" drops every remembered session |

### Model names

Claude Code has no command that lists models, so its dropdown offers aliases
rather than exact ids: `fable`, `opus`, `sonnet`, `haiku`. An alias keeps
pointing at the newest model in its family as Claude Code updates, which a pinned
id does not. Gemini's aliases work the same way (`pro`, `flash`, `flash-lite`).
Type an exact id into the Model setting if you want one; it stays selectable in
the dropdown. Whichever ran is printed in the footer under each answer.

### The system prompt

The prompt tells the agent to answer as a researcher: lead with the answer, use
its own knowledge of the subject rather than treating the vault as the limit of
what is knowable, cite vault notes and URLs, put method in a Sources section at
the end instead of opening with what it searched for, keep it short, and offer up
to three follow-up questions in a fenced `follow-ups` block when there are useful
ones. The plugin lifts that block out of the answer and turns it into buttons.

It is a setting, so it is saved in your vault. The settings file also records the
default it was given, so an unedited prompt is replaced when the default improves
and an edited one is left alone — without the plugin having to carry a copy of
every prompt it has ever shipped. Claude
Code takes it as a real system prompt; the others have no flag for one, so it
goes in ahead of the question — and for those, the one line about the follow-up
block is repeated after the question, because by the time they reach the end of
the answer the prompt is a page behind them, and on a resumed turn it is not
sent at all. Delete that paragraph from the prompt and the reminder stops too.

## Vault context file

Each agent reads its own file from the vault root: `CLAUDE.md`, `AGENTS.md`,
`GEMINI.md`. A short one tells it how your vault is organised:

```markdown
# Vault conventions

- Notes link with [[wikilinks]]. Resolve a link by searching for a file named
  `<link>.md` anywhere in the vault.
- Frontmatter `status:` is one of seed, growing, evergreen.
- Daily notes live in `journal/` and are not sources of truth.
- When asked about a note, cite sections by heading, not by line number.
```

## Development

```bash
npm run dev              # rebuild on change; reload the vault window to pick it up
npm run build            # typecheck, then bundle main.js
npm run check            # the follow-up parser; free and instant
npm run smoke            # end-to-end against every agent on PATH, costs a few cents
npm run smoke -- codex   # just one
```

`npm run smoke` covers everything outside Obsidian's UI: spawning the CLI,
parsing its output, resuming a session, the read-only confinement, whether the
agent actually emits the follow-up block the prompt asks for, a missing binary,
and cancelling a run. It runs every agent whose binary it can find, so it is also
how you check an agent this repository has not been able to test.

For the UI, `harness/` loads the real built `main.js` against a stubbed Obsidian
API and mounts the real sidebar view, inside Obsidian's own `app.css` and your
vault's theme — both extracted from the installed app:

```bash
npm run build && node harness/prepare.mjs
python3 -m http.server 8901     # from the plugin root, not from harness/
open http://127.0.0.1:8901/harness/index.html
```

A throw in `onOpen` shows up in the page with a stack. `document.title` holds the
measurements that are hard to eyeball — the padding that actually won, the
sidebar font size against the note's, whether the footer clears the status bar.
`window.openNote(window.notes[1])` switches notes, which is how the per-note
conversations get exercised.

It is a stub, not a simulator: anything the plugin reaches for that
`harness/obsidian-stub.js` does not define throws with its own name. That also
means it cannot vouch for the real API's behaviour — only that the plugin's own
code runs. `harness/turns.html` is the same CSS with hand-written markup for a
conversation that already has answers in it.

To drive the real thing instead, launch Obsidian with a debug port:

```bash
osascript -e 'tell application "Obsidian" to quit'
open -a Obsidian --args --remote-debugging-port=9222
node scripts/cdp.mjs 'app.commands.executeCommandById("ask-ai:ask-about-note"); return "opened";'
node scripts/cdp.mjs --screenshot shot.png --file probe.js
```

`scripts/cdp.mjs` evaluates an expression inside the running window over the
DevTools protocol and can grab a screenshot, which is how the modal layout and
the streaming render were checked. Restart Obsidian without the flag when you are
done; the debug port is unauthenticated.

## Notes

- Every CLI's output is reduced to the same handful of events in `providers.ts` —
  append text, replace the message, clear the turn, a tool label, usage, an
  answer, a failure. Claude streams tokens, Codex delivers whole messages, Gemini
  streams tokens with no marker between turns; `runner.ts` does not know which.
- A session belongs to the agent that opened it. Switching agent mid-conversation
  starts a new one rather than handing a Codex thread id to Claude.
- `Modal` and `ItemView` both carry undocumented fields the type definitions do
  not declare. A subclass field of the same name wins, because `target: ES2022`
  means class fields are defined rather than assigned, so a bare `titleEl;`
  redefines it as `undefined` *after* `super()` set the real one. `Modal` has
  `selection` and `title`, which is why the question modal calls them
  `selectedText` and `heading`. `ItemView` has `titleEl`, and `ItemView.load()`
  calls `this.titleEl.setText(...)` — before `onOpen()` and outside the promise
  `onOpen` returns. Naming the sidebar's own heading `titleEl` therefore threw in
  `View.open()`, skipped `onOpen()` entirely, and left a pane so blank it had no
  header either, with the error only in the developer console. It is
  `noteTitleEl`. The harness reproduces this one on purpose.
- The editor buffer is flushed to disk before each question. The agent reads the
  note off disk, so without that a question asked seconds after typing would be
  answered against the previous text.
- The sidebar keeps a conversation per note, hidden rather than unmounted, so a
  note you come back to still has its answers and its scroll position. Ones you
  never asked anything in are dropped past eight open, since rebuilding an empty
  one costs nothing.
- Conversations persist in the settings file, which is read whole at startup, so
  they are bounded on both axes: the twenty most recently asked-about notes, and
  60k characters of turns each, newest kept. A research note is the durable home
  for an answer; this is only so a pane is never blank when its thread is not.
- Copying one block hands back that block's markdown, matched to the rendered
  element by walking both in order and resyncing when they disagree — a list
  split by blank lines is several source blocks and one element. When they stop
  agreeing it hands back the rendered text rather than the wrong block.
- Obsidian's status bar is fixed to the bottom-right of the window, over the
  sidebar's footer, and its own panes clear it with a flat 32px of padding. This
  one measures the bar instead, so the footer sits right on top of it — and
  against the very bottom when the status bar is hidden.
- `.view-content.ask-ai-view` is deliberately two class names.
  `.workspace-leaf-content .view-content` in Obsidian's own stylesheet sets the
  padding, and a single class loses to it.
- The suggested follow-ups are stripped from the answer as it streams, not only
  at the end, so a half-written fence never flashes up as an empty code block.
  `npm run check` covers that parser without spending agent tokens.
- Claude's token counts add `input_tokens`, `cache_read_input_tokens` and
  `cache_creation_input_tokens` together, because on a large note almost
  everything arrives as a cache read. Codex's `input_tokens` is already the whole
  prompt, so it is used as it comes.
- Desktop only. It spawns a process, which Obsidian mobile cannot do.
