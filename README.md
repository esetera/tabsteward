# Tab Steward

A Firefox add-on that stewards your tabs instead of just grouping them. It groups, names, dedupes, sleeps, hides and closes tabs under a policy you write in plain language. Every action carries a one-line reason, everything it closes goes to the Attic where it can be restored, and how much it may do on its own is a per-action dial you control.

It thinks with whatever model you bring: a local one (Ollama, LM Studio, any OpenAI-compatible server), or a cloud key for OpenAI, Anthropic, DeepSeek or Z.ai. Without a model it still runs the deterministic half: known-site grouping, duplicates, leftover pages, staleness and the policy parser.

Requires Firefox 139 or newer (native tab groups API).

## What it does

- **Preview** shows exactly what Tidy would do, with the reason and the autonomy gate for each action, without doing it.
- **Tidy now** (Alt+Shift+T, or the button). Runs the whole policy: close leftover pages and empty tabs, close duplicates, group ungrouped tabs, sleep or close stale tabs, collapse idle groups, hide long-idle groups.
- **Auto-group on open.** A new tab that is not spawned from a grouped tab is classified and slotted into a matching existing group.
- **The Attic.** Every closed tab with its reason, its group and its note. One-click restore puts it back in its group. Expires after a configurable number of days.
- **Plain-language policy.** "Never close anything on github.com. Shopping tabs die after 3 days. Keep docs.python.org under Work. Ask me before closing anything I typed into." Compiled once (by the model, or by the built-in parser) into rules that run locally with no model calls.
- **Autonomy dial.** Group, rename, collapse, hide, sleep, dedupe, leftover, close: each set to Suggest, Confirm or Auto. Approve ten suggestions of one kind in a row and the steward offers to automate it.
- **Read-later triage.** An article open for days is offered a bookmark folder and a spot in the Attic instead of another week in the tab strip.
- **Focus mode.** Pick a group, everything else in the window hides for a timebox, then comes back.
- **Projects.** Snapshot every group, "End of day" closes them all into the Attic, restore a project into a fresh window later.
- **Ask your tabs.** Type to filter locally; press Ask and the model finds, closes, groups or summarises across your tabs.
- **Windows.** Move a group to its own window, or gather same-named groups from every window into one.
- **Tab notes.** A "why is this open" note per tab, drafted by the model if you like.
- **Spend and privacy meter.** Estimated cost per month with a hard cap, a send log of every payload that left the browser, a never-send list for sensitive sites, and optional page excerpts behind an explicit all-sites permission.

## Local models and privacy

Pick Ollama or LM Studio as the provider and nothing leaves your machine. The default for a local provider is "let it see everything", so the never-send list only gates cloud providers; turn that off under Privacy if you prefer. Explicit "never send" policy rules apply either way.

- **Ollama**: install, `ollama pull llama3.2` (or qwen3, gemma3), then in settings choose Ollama, click Fetch model list, Save & test. Ollama normally rejects requests from browser extensions; the add-on strips its own Origin header on localhost requests so this works without setting `OLLAMA_ORIGINS`.
- **LM Studio**: load a model, start the local server on the Developer tab, enable CORS there, choose LM Studio in settings.
- **Anything else**: choose Custom and point it at an OpenAI-compatible `/v1` base URL. Localhost and private-network addresses are treated as local (free, uncapped, allowed to see everything).

Cloud providers only ever receive tab titles and URL paths, never full URLs with query strings, never page content unless you grant all-sites access and turn excerpts on. Sites on the never-send list are handled by the local heuristics alone.

## Install for development

```bash
npm install
npm test
npm run lint
npm start
```

`npm test` runs the unit tests plus an end-to-end run of the steward against an in-memory WebExtension API. There is also a real-Firefox smoke test that installs the add-on temporarily in a headless throwaway profile, opens tabs, and drives every message the UI uses through Marionette:

```bash
node test/smoke.mjs
```

Add `--ollama` to also exercise a local model (expects Ollama on localhost:11434; set `OLLAMA_MODEL`, default `llama3.1:8b`), `--visible` to watch it, `--quick` to stop after the plan.

`npm start` launches Firefox with the add-on via web-ext. To load it by hand: `about:debugging` → This Firefox → Load Temporary Add-on → pick `manifest.json`. First run opens the settings page. Firefox treats API hosts as optional permissions in Manifest V3, so click "Grant access to the API host" once for the provider you pick.

`npm run build` produces a zip in `web-ext-artifacts/`.

## Layout

- `manifest.json` Manifest V3, Firefox 139+.
- `src/background/main.js` event wiring, alarms, the message API the pages use.
- `src/lib/steward.js` the planner and orchestrator: plan → gate by autonomy → execute or suggest.
- `src/lib/actions.js` executes actions, writes the Attic and activity log, undoes batches.
- `src/lib/rules.js` policy rules, the fallback sentence parser, effective policy per tab.
- `src/lib/categories.js` heuristic site classifier and per-category staleness defaults.
- `src/lib/staleness.js`, `dedupe.js`, `urls.js` pure decision logic (unit tested).
- `src/lib/providers.js` OpenAI-compatible and Anthropic adapters, model discovery, cost table.
- `src/lib/llm.js` prompts and schemas, spend cap, send log, classification cache.
- `src/lib/groups.js`, `tabmeta.js` native tab group helpers and stable group keys stored on tabs.
- `src/popup/` the steward panel (popup, sidebar, or full page). `src/options/` settings. `src/attic/` Attic and activity log.
- `src/content/formguard.js` optional content script: unsaved-input detection and page excerpts.
- `test/` vitest; `test/fakeBrowser.js` is an in-memory WebExtension API used by the end-to-end steward tests.

## Known limits

- Firefox's saved tab groups are not exposed to extensions, so projects are the add-on's own snapshots.
- A group's id can change after a restart; the add-on keys groups by a stable id stored on each tab.
- Firefox shows a one-time notice the first time an extension hides tabs. Hidden groups are listed in the panel and can always be shown again.
- The cost meter uses approximate list prices.
