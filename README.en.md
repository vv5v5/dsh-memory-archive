# dsh-memory-archive · Memory Archive

> **We don't invent memory. We make what DSH already compacted away reachable again.**

> 中文: [README.md](README.md)

DSH's [context compaction](https://github.com/) (`compaction-basic`) already folds old content out of the model-visible surface.
This plugin **does not rewrite compaction, does not reimplement summarization, and does not create a second store.**
It adds the three things the platform doesn't do on its own:

1. **Retrieval** — compacted content is *still in the append-only event log and still in the search index*.
   What was missing was an entry point that can reach it.
2. **Honest labelling** — every result is labelled with its surface state: `current` (still in the model's context),
   `shadowed` (**compacted out of context**), or `log-only` (never on the surface to begin with).
3. **A configurable front end** — its own panel: root-mode switch, user-supplied API settings, diagnostics.

Since v4 it also ships: an **integrated prompt viewer** (see the full text of every request actually sent to the model),
a **reading-first interface** (continuous scrolling over summaries and originals, fullscreen),
**real-name resolution** (playthroughs / characters / sessions shown by name instead of id),
and a **prompt panel** (compaction instruction / placeholder preamble, editable and persisted).

---

## Design intent

Three statements about what this plugin wants — and what it deliberately refuses to do.

### 1 Use the native machinery; do not pollute the native coding setup

Both "unlimited context" and the prompt viewer are built on what DSH **already has**: compaction keeps folding,
the session log stays the single source of truth, and retrieval and assembly go through official extension points.
**No compaction rewrite, no second store, no forked official package.** Uninstall the plugin and the native coding
environment is exactly as it was — sessions, tool surface and model selection are untouched.

### 2 Roleplay is a *mode*, not a conversion of the coding setup

The roleplay composition this plugin takes part in does **not** share a tool registry with the coding mode: the
roleplay side mounts only the capabilities it needs, and coding-mode tools neither appear in its tool list nor
consume its context budget. Together with upstream
[Player-MINEPIG/dsh-tavern](https://github.com/Player-MINEPIG/dsh-tavern) this adds up to one place to manage both
an "**agent tavern**" and a "**tavern agent**": the Tavern side owns character cards, world books, playthroughs and
ST presets, while the agent side owns composition, tool surface, memory and archiving. The two sides only meet at
official extension points, and neither makes decisions for the other.

### 3 What we changed in DSH itself: **not one line**

We do exactly two things — **write a plugin**, and **generate a preset directory when you explicitly ask for it**.
Everything else is an official extension point (all verifiable):

| Official extension point | What we use it for |
|---|---|
| `ctx.effect` lifecycle + two same-origin prefix routes via `webServer.register` | memory and viewer data planes: `/dsh-memory-archive/api`, `/dsh-memory-archive/prompt` |
| `sessionQuery` exact session reads | read back what compaction folded out of context; no index rebuild |
| `system-prompt/assemble` waterfall | per-turn **metadata** capture (section name / order / chars / offset / hash / mutability) — **never the text itself** |
| `systemPrompt.section()` | read-only display of registered sections; the two roleplay sections are registered by a plugin inside the preset directory |
| `compaction` service subclass | the Chinese roleplay archival instruction as a compaction backend (overrides `summarize` only) |
| `skills.register()` | two skills: RP assistant / configuration knowledge base |
| client `slots` | two sidebar entries (memory archive, prompt viewer) |
| **agent preset (realm)** | roleplay mode: narrowed tools, injected sections, no shared registry with coding mode — via a **generated preset directory**, not a core change |

Standing rules: before touching a preset directory we **dry-run it for you**, **read every byte back** afterwards,
and **roll back automatically** on mismatch; we never overwrite an existing file, never hardcode an absolute path
(relative to the config, so it survives a move), and never touch the profile configuration in your `~/.dsh`.

### Where it stands today (honest labelling)

| | Status |
|---|---|
| **Prompt viewer** | ✅ usable once the environment is set up: assembly map, per-section offsets, click through to the **real text** of a section, registry export, and honest diagnostics when a log cannot be read |
| **Memory archive** (reading / search / real-name resolution / prompt panel) | ✅ usable |
| Collection writer (moving compacted ranges into the playthrough archive) and the chat-import adapter | ⚠️ **not in this release** — they are on a separate branch and will land when finished |

---

## Install

```sh
# From npm (once published)
dsh plugin --profile <your-profile> add dsh-memory-archive

# Or straight from GitHub
dsh plugin --profile <your-profile> add github:vv5v5/dsh-memory-archive

# Or a local directory (development)
dsh plugin --profile <your-profile> add ./dsh-memory-archive
```

**Restart the host once after installing** — the browser half's bundle is assembled at host startup.

> There is **no build step**. `lib/` ships runnable JavaScript; `react` comes from the host's module seed table.

## Dependencies

| Feature | Dependency |
|---|---|
| **Session mode** (default) | **None** — works on a plain DSH install |
| **Workspace mode** | Requires [`pmp-dsh-tavern`](https://github.com/) to be installed (**optional**) |

`pmp-dsh-tavern` is declared as an **optional peer dependency** and is never force-installed.
When it is absent, workspace mode is greyed out with an explanation instead of failing.

---

## Two root modes

The memory library has to work in two environments whose "root" is not the same kind of thing —
so the root is a **switchable mode**, not a hardcoded path:

| | **Session mode** (default) | **Workspace mode** |
|---|---|---|
| Root | One **manually selected** DSH session | A playthrough's `archive/` inside the Tavern workspace |
| Source | The session's own event log (read via **exact reads**, no index rebuild) | Archive files (`floors/`, `summaries/`, `state/`) |
| Sees | **Every** event, including those **compacted out of context** | The three things the archive contract covers: originals / summaries / state |
| Depends on | Nothing | `pmp-dsh-tavern` |
| Typical use | Roleplay on a plain DSH install, where the session itself is the memory | A Tavern workspace, where memory lives in a separate archive |

**Manual selection is deliberate.** "Which session counts as memory" is a semantic judgement made by the user,
not something to be inferred.

---

## Control panel

A **gear button** at the bottom of the sidebar opens the memory library's own panel.
It deliberately **does not add a page to DSH's settings screen**. The panel has a status line
(current root mode + host API connectivity) and three sections: **Read / Prompts / Settings** —
**Settings is a secondary view** (with a "back to reading" action); the root-mode switch no longer
occupies the top bar permanently.

### Read

A reading-first, **continuously scrolling** view with **fullscreen** and **keyboard paging**:

- **Summaries** — concatenated in floor order into one long text, readable top to bottom;
- **Originals** — lazily loaded in order: floors that were never sent to the model (`sent === false`)
  are **labelled as such**; session events are appended automatically 200 per page;
  every entry's `surface` is reported faithfully
  (`current` still in the model's context / `shadowed` explicitly marked "moved out of context" /
  `log-only` never on the surface to begin with).

Sessions, playthroughs, and characters are shown by **real name**, not id (sources and fallback below).

### Real-name resolution

| Data | Source |
|---|---|
| Playthrough / character names | The workspace root's `catalog.json`: `playthroughs[].title` / `.ext.pmpDshTavern.characterName` |
| Playthrough ↔ session mapping | `catalog.json`'s `rootSessionId`; falls back to the archive's `manifest.json` (`target.rootSessionId`) when Tavern is unreachable |
| Session names | The host's `readTitle` (explicitly requested with `?titles=1` — `/sessions` defaults to a fast path with `null` titles) |

Session names follow a **three-level fallback**: `title` → playthrough reverse lookup
(displayed like "character · playthrough 1") → **8-character truncated id**.
Each level is **labelled with its source**; when no real name is available the panel shows the
8-character truncated id with its source, and a full UUID is never shown anywhere.

### Prompts

Three sub-pages:

- **Per request** — the integrated prompt viewer: the **full text of every request actually sent to the model**;
- **Compaction instruction** — the instruction issued to the summarization call during compaction;
  editable, restorable to the built-in default (`null`/empty string = default), with an explanation of what it does;
- **Placeholder preamble** — the preamble left in place where content was folded away;
  also editable and restorable, with an explanation of what it does.

★ **Two honest notes**:

1. The saved "compaction instruction" is **just text** — for it to take effect you must put it into the
   corresponding preset's `customInstruction`;
2. This plugin **does not yet implement a placeholder executor**: "placeholder preamble" is currently a
   **reserved configuration slot** — saving it **does not change any DSH behavior**.

### Settings (secondary view)

- **Root mode** — session / workspace. Workspace is greyed out unless Tavern is reachable, with the reason shown.
- **Root selection** — a session dropdown in session mode; automatic character/playthrough discovery in workspace mode (**no hardcoded ids**).
- **API settings** — your own `endpoint` / `model` / `key`:
  - **The key is never echoed back.** When one is stored, the field stays empty and shows "saved (…last 4) · leave blank to keep".
  - `Save` writes to disk and **reads back to verify**; `Test` sends one minimal request; `Clear key` is a separate action.
- **Diagnostics** — host API, session-read service, config directory writability, Tavern reachability, and where the config file lives.

---

## Where configuration lives

```
<DSH_HOME or ~/.dsh>/dsh-memory-archive/config.json
```

- Mode **0600** (it holds an API key), **atomic writes** (temp file + `rename`), and **corruption-tolerant reads**
  (falls back to defaults and reports the problem rather than crashing).
- Your key **stays on your machine**: never committed, never logged, never returned in any response body
  (the host reports only `keySet` and a last-4 hint).
- Optional section `prompts: { compaction, placeholder }` — custom text for the compaction instruction and
  the placeholder preamble: absent = built-in defaults; `null`/empty string = restore the built-in defaults
  (older configs stay compatible).

---

## Host API

All endpoints are same-origin HTTP, and the two route prefixes are **registered together** at host startup:

| Prefix | Contents | Degradation |
|---|---|---|
| `/dsh-memory-archive/api` | Config read/write, exact session reads, and `GET/PUT /api/templates` (prompt-template read/write) | A missing template or a `null`/empty value **falls back to the built-in default** (same when the `prompts` section is absent; older configs stay compatible) |
| `/dsh-memory-archive/prompt` | The integrated viewer's data plane: `/health`, `/api/sessions`, `/api/sessions/resolve`, `/api/session`, `/api/part` | Read errors **never crash**: HTTP 200 with the error carried in the body (`ok:false` + `error`) |

When the host API as a whole is unavailable, the panel never goes blank: browsing falls back to workspace mode.

---

## Design notes

The full rationale and implementation logic is in [`docs/DESIGN.zh.md`](docs/DESIGN.zh.md) (Chinese).
Three essentials:

1. **It reuses DSH's own compaction mechanism.** "Hiding old floors" *is* surface `replace` shadowing —
   in the platform's own words, *"Used by compaction; any surface-replacing producer may use it"* —
   so there is nothing to build. And because the append-only event log remains the source of truth,
   **every shadowing operation is reversible.**
2. **It does not create a second store.** Compaction moves content out of the **model-visible surface**;
   it does not delete it from the log or from the search index. Measured on a real corpus:
   one session already carried **752 documents / ~1.53M characters** tagged `shadowed`, **all of them findable**.
   Storage was never the gap — **retrieval** was.
3. **Injection only uses seams that don't write history.** Only `systemPrompt.section()` and the
   `system-prompt/assemble` waterfall are used. `systemPrompt.context()` and `agent/pre-step` are avoided,
   because both **persist what you inject into the session history** — in a long conversation that means
   appending one extra message every single turn.

---

## Known limitations

| # | Limitation | Notes |
|---|---|---|
| 1 | `surface` may be `null` | When the platform version differs or a read path degrades, it is reported as `null` **rather than guessed** (never inferred from the event type) |
| 2 | Workspace mode requires `pmp-dsh-tavern` | Without it the mode is greyed out and explained; nothing crashes |
| 3 | Automatic degradation when the host API is unavailable | The panel never goes blank; browsing falls back to workspace mode |
| 4 | This plugin **does not generate summaries** | It is read-only. Summarization, where wanted, belongs to the user's own API settings and to later versions |
| 5 | The "compaction instruction" is saved as **text only** | For it to take effect you must put it into the corresponding preset's `customInstruction`; the plugin does not edit presets for you |
| 6 | The "placeholder preamble" **has no effect yet** | This plugin does not yet implement a placeholder executor; the slot is reserved, and saving it changes no DSH behavior |

---

## Development

```sh
npm run check   # node --check lib/index.js && node --check lib/client.js
```

- `lib/index.js` — **host half**: configuration store + same-origin HTTP API
  (prefix routes `/dsh-memory-archive/api` and `/dsh-memory-archive/prompt`) + exact session reads.
- `lib/prompt-viewer.js` — the integrated prompt viewer's host half: parses the DSH session store
  to feed "per request", with zero cross-dependencies.
- `lib/client.js` — **browser half**: factory-form CJS, `require('react')` only, **no JSX, no build step**.

## License & Attribution

- License: **Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)**, SPDX identifier `CC-BY-NC-4.0`;
  the full legal text and NOTICE live in [`LICENSE`](./LICENSE).
- Copyright (c) 2026 dsh-memory-archive contributors

### Porting source & attribution (kept at the upstream's request)

| Item | Value |
|---|---|
| Original project | `anima-rag` |
| Original author | `Ellinav` |
| Original URL | <https://github.com/Ellinav/anima-rag> |
| Original license | Attribution-NonCommercial 4.0 International (CC BY-NC 4.0) |
| Porting permission | Ported with permission from the original author, Ellinav |

### Scope restrictions (conditions of the porting permission)

- Personal study and non-commercial use only;
- No closed-source commercial use, and it must not be turned into a paid plugin/service;
- No redistribution of any bundled private data.

## Third-party licenses & provenance

- **Derived from**: the official DeepSeek Harness `compaction-basic` (the compaction instruction
  template is taken from its `summarize` hook) — MIT, Copyright (c) 2026 DeepSeek;
  that portion of this work **retains its original MIT notice**.
- **Ported/derived from**: [`anima-rag`](https://github.com/Ellinav/anima-rag) (by Ellinav)
  — CC BY-NC 4.0; this work as a whole is therefore licensed CC BY-NC 4.0.
- **Interoperability/acknowledgements** (⛔ interop, **not** derivation): `dsh-anima-rag`,
  `dsh-state-bridge`, `pmp-dsh-tavern` — all MIT; this work **contains none of their code**
  and only works alongside them.
