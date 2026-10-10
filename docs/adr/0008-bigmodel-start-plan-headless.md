# ADR-0008: Serve the bigmodel Start Plan (Weekend Build) headless

Date: 2026-09-30
Status: Accepted (reverses the Start Plan half of the #123 / PR #128 decline,
historically labelled ADR-0019 in AGENTS.md — that file was never committed
to docs/adr/)

## Context

Issue #123 (2026-09) declined headless Start Plan support: the `zcode-plan`
gateway authenticated model requests with the plan's OAuth JWT **plus an
Aliyun captcha session** (`X-Aliyun-Captcha-Verify-*` headers) that only the
ZCode desktop renderer could produce. Answering the backend's
`interaction/requestProviderRuntimeHeaders` with anything less than a solved
captcha session meant either failing the turn (-32031) or fabricating
anti-abuse headers — circumvention, refused for a publicly distributed tool.

Probing on 2026-09-27 confirmed the gate was still live: a raw request with
the account's own JWT answered `{"code":3007,"msg":"captcha verify failed"}`.

## Trigger

Two days later the user reported the captcha requirement was gone in new
ZCode builds (desktop 3.14.4) and asked for support. Source evidence (open
repo, v3.14.3 = what 3.14.4 ships on):

- `packages/services/src/zcode-agent/zcodeAgentService.ts:2277` — the host
  auto-answers runtime-headers requests without renderer interaction:
  "Account API Key / Team Runtime Key / Start Plan JWT 都不需要 Renderer 交互".
- `packages/services/src/model-provider/accountProviderRequestAuthService.ts:73-76`
  — for `planKind === "start-plan"` the answer is
  `{apiKey: tokenSet.zcodeJwtToken}` and NOTHING else. No captcha headers are
  produced anywhere in the current flow.
- `zcodejwttoken` in `~/.zcode/v2/credentials.json` is byte-identical to
  `provider["builtin:bigmodel-start-plan"].options.apiKey` in config.json
  (verified 2026-09-30), so the bridge can read the exact material the
  desktop serves.

A live probe through the built bridge (2026-09-30) confirmed the gateway no
longer demands captcha headers: the backend consumed the served JWT and
reached quota evaluation (business code `1005` when the promo balance is
exhausted/out of window — an account-state answer, not an auth rejection).

## Decision

Serve the **bigmodel start plan** from config.json exactly like the
individual coding plan:

- `entitledBuiltinProviders` counts a `builtin:<family>-start-plan` entry as
  entitled when its `options.apiKey` (the JWT) is non-empty, ignoring the
  `enabled` flag — the desktop writes `enabled:false` there even while the
  plan is the active connection (the flag tracks legacy-provider selection,
  not start-plan membership).
- `codingPlanRequestAuthFor` answers `account:<family>-start-plan` requests
  with that JWT (`{headersApplied: true, requestAuth: {apiKey}}`), with a
  table-absent fallback deriving the mode from the id spelling.
- `providerSelectable` admits start-plan entries on the same JWT-presence
  rule, so their models reach the dropdown.

No captcha is solved, faked, or bypassed anywhere: the gateway stopped asking
for one, and the bridge now sends exactly what the desktop sends. The
revisit trigger named in #123 ("official headless credential path") has
effectively fired — the JWT in config.json IS the official credential, and
the answer shape is the desktop's own.

## Boundaries that remain

- **zai-start-plan** entries with an empty key: unservable (no credential).
- **team / off-peak plans**: keys live in the ENCRYPTED credential store,
  unreadable headless — unchanged.
- A lapsed start plan still passes the JWT-presence entitlement gate; the
  failure then surfaces at request time as the gateway's own quota error
  (e.g. `1005`), which is the same trade the desktop's
  "credential present → entitled" rule makes.

## Advertisement rule change (first-owner-bare)

Start-plan models collide with the individual plan's ids (both ship
GLM-5.3/GLM-5.3-Flash). The #175 all-qualified rule would have orphaned every
client with a stored bare id (Paseo validates requested ids against
advertised choices). `modelChoiceValue` now qualifies only the SECONDARY
holder of a colliding id; the FIRST builtin owner keeps the bare spelling —
mirroring `parseModelValue`'s existing bare→first-owner resolution, so stored
bare ids keep meaning the same provider while the start plan stays
unambiguous.

## Consequences

- Weekend Build (and any bigmodel start plan) tokens are usable headless and
  through ACP editors/orchestrators while the balance lasts.
- If Z.AI re-enables a per-request challenge, turns fail with the gateway's
  own error; the decline path (`headersApplied:false` + actionable message)
  remains for plans without a usable credential.
