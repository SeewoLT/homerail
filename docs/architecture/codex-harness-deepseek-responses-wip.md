# Codex harness / DeepSeek Responses WIP

Status: WIP, investigated and smoke-tested on 2026-07-31.

## Supported runtime shapes

| Surface | Codex model source | Wire transport | Placement |
| --- | --- | --- | --- |
| Manager Agent | OpenAI/ChatGPT subscription | Codex native Responses transport | host |
| Manager Agent | HomeRail setting with `responses_base_url` (DeepSeek V4 Flash is the built-in preset) | Responses | host |
| DAG actor | HomeRail setting with `responses_base_url` (DeepSeek V4 or a local Responses deployment) | Responses | container |

HomeRail injects provider-backed Codex configuration through process-local
`codex app-server -c model_providers...` overrides. The decrypted credential is
only supplied through `HOMERAIL_CODEX_API_KEY`; it is not written to Codex
configuration or included in command arguments.

The built-in DeepSeek endpoint now uses:

- model: `deepseek-v4-flash` (recommended) or `deepseek-v4-pro`
- API root: `https://api.deepseek.com`
- Codex wire API: `responses`

Live verification with the locally encrypted DeepSeek V4 Flash setting showed:

- `POST https://api.deepseek.com/v1/responses`: HTTP 200
- `POST https://api.deepseek.com/v1/chat/completions`: HTTP 200
- `POST https://api.deepseek.com/anthropic/v1/messages`: HTTP 200
- a real isolated `codex app-server` thread and turn, configured with base URL
  `https://api.deepseek.com`, completed and returned `OK`

DeepSeek's public V4 documentation currently advertises Chat Completions and
the Anthropic compatibility layer but does not document the working Responses
endpoint. Runtime probing remains the source of truth before selecting a
provider-backed harness.

## Claude Agent SDK alignment

| Capability | Claude Agent SDK | Manager Codex | DAG Codex after this WIP |
| --- | --- | --- | --- |
| Shared HomeRail manager prompt | yes | yes | n/a |
| Preserve native harness prompt and append HomeRail instructions | yes | yes (`developerInstructions`) | yes (`developerInstructions`) |
| Native HomeRail dynamic tools | in-process MCP | app-server dynamic tools | app-server dynamic tools |
| Manager tool schema parity | yes | yes, covered by parity tests | n/a |
| Native Skill bodies, references, and assets | yes | yes for HomeRail/plugin roots | yes, fixed turn projection |
| User-level ambient Skill isolation | yes | provider-backed: yes; subscription: no (uses account login home) | yes (isolated `HOME`/`CODEX_HOME`) |
| Project-level ambient Skill isolation | yes | no | no; Codex extra roots are additive |
| Correct turn interruption | SDK abort | `turn/interrupt` | `turn/interrupt` (fixed here) |
| Persistent native session | yes | yes | no; DAG checkpoint resume only |
| Live mid-turn steering | yes | partial | no |
| Exact built-in tool allowlist and hard budget | yes | no | no; such DAG policies remain rejected |
| Workspace read/write policy enforcement | hooks plus SDK permissions | configurable Codex sandbox | `workspace-write`; per-root policy is not yet mapped |
| Token usage and backend-native raw trace | yes | partial | no |

The most important Skill limitation is upstream-shaped: `skills/extraRoots/set`
adds roots, while Codex still discovers `.agents/skills` between the repository
root and the thread `cwd`. Codex supports disabling individual discovered
Skills, but it currently has no "only these roots" switch. HomeRail must not
claim strict fixed-projection parity until this is enforceable.

## Follow-up work

1. Add an app-server capability or two-pass discovery/restart strategy that
   disables every project Skill outside the pinned DAG projection.
2. Map HomeRail `allowed_builtin_tools`, `max_builtin_tool_calls`, and
   `workspace_access` to enforceable Codex permissions/policy, then remove the
   current fail-closed compatibility guard.
3. Add DAG native thread resume, turn-controller steering, cumulative usage,
   and raw app-server trace capture.
4. Distinguish subscription Codex and provider-backed Codex more explicitly in
   the settings UI, including provider-specific reasoning controls.
5. Add a CI app-server integration fixture backed by a deterministic local
   Responses server; keep the live DeepSeek smoke test opt-in and secret-safe.
