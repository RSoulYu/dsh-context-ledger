# dsh-context-ledger

**Reconcile the token cost every request carries against how often each injected item is actually used — and surface the ones that bill you on every request while returning nothing.**

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![version](https://img.shields.io/badge/version-0.5.0-green.svg)](CHANGELOG.md)

[简体中文](README.md) | **English** · [CHANGELOG](CHANGELOG.md) · [Design contract](docs/DESIGN.md)

## Why

Every request already carries a batch of resident injections: the stacked `AGENTS.md` instruction chain, the skill catalog, dozens of tool schemas, the MCP tool surface. They are billed on every single request, yet nobody quantifies them.

Comparable tools tell you **what is expensive**; they do not tell you **what is useless**. Cost alone makes you delete busy tools that are cheap per use; frequency alone leaves you with a huge schema that is barely ever called. Only the product is actionable — this plugin **reconciles**, it does not merely count costs:

```
cost per use = resident tokens ÷ actual call count
```

## Install

```sh
dsh plugin --profile <profile> add "github:RSoulYu/dsh-context-ledger#main"
dsh --profile <profile> --dump-config | grep context-ledger   # confirm the composed tree contains it
```

Restart `dsh web` after changing `index.js` or `client.js`.

## Usage

**Panel** — click the ledger control in the session composer. It prefers the host's right sidebar and expands in the same step; on hosts without it (older builds, headless, tab key taken, open-tab error) it falls back to an in-place overlay. The control is never a dead button.

**Model tool** — off by default since v0.4.0, enabled on demand (that declaration is itself a resident cost, and this plugin measures itself with the same ruler). Turn it on in your profile's `cordis.patch.yml`:

```yaml
- id: context-ledger
  config:
    tool:
      enabled: true
```

```
context_ledger                    # audit the current session working directory
context_ledger sessions=60        # session replay window (default 20, max 200)
context_ledger detail=developer   # include a per-item evidence receipt
```

The tool, the panel and the HTTP route share one data path and return the same canonical JSON — **leaving the tool off does not affect the panel or the route**.

## What it does

| Capability | Description |
|---|---|
| **Cost × usage reconciliation** | Resident cost for each of instructions / skills / tool schemas / MCP, reconciled against real call counts from session logs |
| **Provenance inference** | `providedBy` answers "who provides this tool": `plugin` / `core` / `mcp-server` / `unknown`, each with a confidence and the method used |
| **Prune candidates** | `prunePlan` aggregates never-called resident items by **uninstallable unit** and reports `usedToolCount` so the cost of removal is visible |
| **Hide candidates** | `hidePlan` removes tools from model visibility without uninstalling the plugin, with a paste-ready deny list and a recovery path |
| **Three-state usage** | Separates "used this session / only historically / never in window / undecidable"; **undecidable reports `null`, never `0`** |

**Suggestions only — nothing is ever applied automatically.** Hiding tools is explicit opt-in and takes effect only in agent scope (DSH rejects global restriction).

## Boundaries and privacy

**By design, not defects:**

- **Token counts are heuristic** (ASCII ≈ 4 chars/token, non-ASCII ≈ 1.5) and meant for relative comparison and ordering; use the model tokenizer for exact figures.
- **"Never called" ≠ "useless"**: a tool may be driven by the UI, a background flow, or a rare but critical operation. Output is always phrased as a **candidate**, never as "you should uninstall this".
- **Provenance is a static install-side inference**, not runtime-provable; anything not resolvable is reported honestly as `unknown` or `core`, never guessed.
- **Per-skill call counts are unobservable**: DSH has a single `skill` tool and the skill name lives in its arguments, which this plugin promises not to read. The skill dimension therefore reports category-level figures only.
- **Saving tokens ≠ saving money proportionally**: resident prefixes usually hit the cache, so trimming schemas saves cached-rate money, far less than the token ratio suggests.
- **An uninstallable unit is a bundle, not a fact package**: executable gains are usually far below the headline "zero-call token total".
- **The session window shapes the conclusion**: a smaller `sessions` produces a longer never-called list. Tune it to your real usage cycle.

**Privacy red line** — session logs contain user text. This plugin reads only each line's top-level `type`, plus `data.name` (the tool name) when `type === "tool/call"`. It **must not** touch payload fields such as `data.arguments`, `data.callId`, `data.message` or `data.content`; no tool arguments, tool results or conversation text ever appear in its output. **It changes nothing**: no file writes, no cache, no execution of audited objects, no outbound network calls.

## Known limitations

- **Under PTC transport, "resident" measures the `tools:sdk` declarations in the system prompt, not JSON schemas.** Reports state the basis in `scope.measureBasis`: `"system-prompt-declaration"` (PTC) or `"tool-schemas"` (fallback). **Do not make absolute-size decisions on a fallback report.**
- **The sidebar's in-browser behaviour is not covered by automated tests**: `npm test` asserts registration shape, open-tab calls, fallback and content obligations; whether the host accepts the tab and whether one click really expands it must be confirmed by hand in a browser.

## Development

```sh
npm run check    # syntax check
npm test         # full test suite
```

**Hard constraint**: nothing under `lib/**` may import `@deepseek-ai/*`, or `node --test` cannot run; host dependencies are allowed only in `index.js`.

Docs: [design contract](docs/DESIGN.md) · [project brief](docs/BRIEF.md) · [backlog](docs/BACKLOG.md) · [implementation notes](docs/IMPLEMENTATION-NOTES.md)

## License

[MIT](LICENSE) © 2026 RSoulYu
