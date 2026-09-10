# Execution catalog: evidence and integration

Observed 2026-09-09 UTC on the France host. Implementation lives in
`scripts/lib/execution-catalog.mjs`; the CLI is `scripts/execution-catalog.mjs`.
`docs/execution-profiles.json` contains the profiles and sanitized snapshots. No
production configuration, service, GitHub object or account authentication was changed.

Later same-day update: main obtained authorized SSH management access and a private
inventory of nine channels. Original OpenCode Go, CommandCode, PQAPI sol/free keys
are now available in `~/.config/ai-gateway/migration-1174/`; management is no longer
a migration blocker. PQAPI sol's official `/v1/models` returned only `gpt-5.6-sol`;
free's returned `gpt-5.4-mini`, `gpt-5.6-luna`, `codex-auto-review`, `gpt-5.5`,
`gpt-5.4`, `gpt-5.6-terra`. The sol key matches local `mycodex.key`: that filename
is not evidence of NewAPI scope. The credential classifier now uses actual group
bindings/known group credentials rather than classifying mycodex/pqapi by filename.

The new `scripts/lib/execution-pi-provider.mjs` prepares native Pi launch specs
without writing config. Pi 0.85.1 offline RPC `get_state` confirmed both exact
selectors (`deepseek/deepseek-v4-flash`, `opencode-go/deepseek-v4-flash`) and official
endpoints. Native auth/settings/model-store content was unchanged. One bounded
synthetic tool-protocol request per provider (96 maximum output tokens, 15s timeout,
no retry or tool execution) returned DeepSeek **402 in 1482ms** and OpenCode Go
**403 in 626ms**. Usage and actual cost were not returned. Both profiles remain
disabled/unavailable; these failed direct requests do not certify Mirasim execution.
All small token prices below remain reference metadata, not measured charges.

CommandCode now has an explicit `pi-openai-adapter` connection for main's deployment
at `http://127.0.0.1:4342/v1`. The helper allows authenticated HTTP only at this
literal endpoint with `allowLoopbackHttp: true`; redirects are rejected. It does
not send standard Chat requests to CommandCode's proprietary upstream. The
existing adapter performs `/alpha/generate` plus fingerprint/session initialization.
Its expected source hash is recorded separately from deployment verification.

`planPiAdapterConfiguration(profile, { homeDir })` returns a secret-free provider
block for Pi's official `models.json`, using its documented request-time command
resolver to read the existing private key file. It never writes that file or
copies the key into configuration. Main merges only that provider block and
verifies the deployed adapter. Until installation, `preparePiDirectLaunch` returns
`configuration_required`; afterward its model is
`commandcode-local/deepseek/deepseek-v4-flash`, its native Pi provider ID is
`commandcode-local`, and its supplier/ledger provider remains `commandcode`.
Conflicting native config/auth is rejected rather than overwritten.

The generated configuration intentionally has no invented price. Pi's defaults
for a custom model can contain zero estimates; the connection/profile billing
policy therefore says to ignore Pi's cost estimate and retain unknown actual
cost. Windsurf's catalog entry now prefers `devin-acp-deepseek` using the same
user-confirmed allowance. Migrating the third-party WindsurfAPI is optional when
the pinned native Devin path is qualified.

Current CommandCode state: an independent review found the existing adapter
swallowed upstream errors, did not abort upstream work on early cancellation, and
zeroed missing usage. Main stopped the France adapter. The candidate is explicitly
disabled/unavailable and its existing artifact review is rejected pending repair.
Configuration readiness remains valid, but HTTP 200 alone cannot establish
execution readiness. Re-enabling requires the repaired artifact's pin and passing
error propagation, upstream cancellation, missing-usage and actual tool execution
checks. No further CommandCode probe was issued by this subtask.

## Secure paths found

| Channel | Existing credential location / access | What is proved | Remaining gap |
| --- | --- | --- | --- |
| Cursor native | `~/.config/cursor/auth.json`; native ACP | Prior ACP Composer read tool returned a random proof | Question tool was absent in that session; write/test/recovery and actual billing need qualification |
| Devin native | `~/.local/share/devin/credentials.toml`; current login is Devin Pro | Prior native read task succeeded; ACP initialize/session-new succeeded; current official account model list returned 210 variants | ACP prompt with pinned model, recovery, tools and actual Pro charges |
| Grok native | `~/.grok/auth.json` | Prior native read succeeded; ACP advertised `grok-4.6` and `grok-4.5`; newer Mirasim roster supports Grok | Production orca was 0.0.282 and lacked Grok; validate upgraded Mirasim execution |
| OpenCode Go direct | `~/.pi/agent/auth.json` → `opencode-go.key` | Present, different from known NewAPI keys; official model list GET returned 200 / 35 IDs | This endpoint is also public: no generation entitlement, remaining quota, or tool success established |
| DeepSeek direct | `~/.pi/agent/auth.json` → `deepseek.key` | Present, different from known NewAPI keys; authenticated official model list GET returned 200 / 3 IDs | Exact Mirasim/Pi provider binding, generation and tools |
| OpenCode Zen direct | Native OpenCode auth store not found in this host's standard paths | Public model list GET returned 200 / 70 IDs | Native API credential and paid/free generation entitlement |
| CommandCode direct | Original apiKey now extracted privately from the remote adapter config | NewAPI CommandCode group lists 6 IDs; native apiBase/projectSlug located | Proprietary adapter and direct tools still need qualification |
| Windsurf direct | Current `~/.config/ai-gateway/windsurf.key` equals the NewAPI Windsurf group key | Group model list GET returned 200 / 48 IDs | Windsurf account/adapter credentials and renewal have not been migrated |
| PQAPI direct | Original sol/free keys extracted to private migration directory; sol matches `mycodex.key` | Official endpoint accepted both and returned distinct exact scopes | Task-scoped Codex native provider config / Responses tool execution pending |
| Mirasim relay | Mirasim's own login/relay state | Prior status `configured=true`, `relayStatus=ok`; Codex roster lists four models | Fresh execution through each exact agent/model/route and billing attribution |

The original search of native OpenCode/CommandCode stores was incomplete: the gateway
repository's `secrets/secrets.env.example` points specifically to Pi's auth store.
That additional search found the native OpenCode Go and DeepSeek keys above.
The CLI's `discover` command now checks both stores. Key values, hashes, email
addresses, provider account IDs and raw authentication responses are not recorded.

`~/.mirasim/keys/opencode.key`, `cmdcode.key`, and `windsurf.key` are NewAPI group
credentials according to `~/.pi/agent/pi-gateway.json`. Do not send them to the
upstream APIs. The refresher refuses a direct credential if its value matches a
known group credential, even when its descriptor has been relabeled `provider-key`.

## Management access investigation (initial gap, subsequently resolved)

Read the gateway repository's `MIGRATE.md`, `ai-gateway-stack/docs/SECRETS.md`,
`secrets/secrets.env.example`, `secrets/unpack.sh`, `ai-gateway-stack/docs/ops/REPLICATION.md`,
`deploy/ssh-client.mjs`, bootstrap/admin probe scripts, gateway policy and available
local service/SSH configuration. These establish the following specific paths:

* `/srv/projects/ai-gateway-stack/secrets/secrets.gpg` exists. The encrypted archive's
  password is not stored in the repository. Both documented local backups,
  `/root/.config/ai-gateway/passphrase` and `/home/orca/.config/ai-gateway/passphrase`,
  are absent. No gateway/admin/passphrase environment variable was present. No
  password guessing or interactive decrypt was attempted.
* The gateway SSH port is reachable. Both local `known_hosts` files contain the
  trusted host record (including hashed records). No gateway SSH alias or SSH agent
  is configured. One strict-host-key, batch-mode authentication attempt using the
  existing orca private key and remote command `true` returned `publickey_rejected`.
  There were no subsequent key/password attempts; the gateway's documented fail2ban
  policy bans repeated authentication failures.
* The new execution SSH public key being handled by the main agent is a possible
  authorized access path after installation; its mere local existence is not proof
  of management access. No SSH authorization was changed by this subtask.
* With authorized management access, documented remote sources are
  `/root/.config/ai-gateway/passphrase`, `/opt/new-api/admin-credentials`,
  `/opt/commandcode-proxy/config.json`, `/opt/windsurfapi/.env`, and the gateway's
  channel records. The Windsurf account credential copy is encrypted under
  `/opt/windsurfapi/.credkey`. Admin probes log in using the admin credential file;
  they do not provide an independent authentication bypass.

These were the initial access findings. Main subsequently verified the authorized
execution SSH key, obtained the channel inventory and confirmed the remote
passphrase exists. CommandCode/Windsurf/PQAPI work now proceeds through that
management access; no new key/password attempts were made by this subtask.

## Exact model and pricing evidence

The JSON snapshots hold exact IDs and per-source timestamps. At the observed time:

| Source | Model-list result | Interpretation |
| --- | --- | --- |
| `https://opencode.ai/zen/v1/models` | 70 IDs | Public Zen catalog; includes `deepseek-v4-flash`, `deepseek-v4-flash-free`, `gpt-5-nano`, `gpt-5.4-mini`, `gpt-5.4-nano` |
| `https://opencode.ai/zen/go/v1/models` | 35 IDs | Public Go catalog; includes `deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp` |
| `https://api.deepseek.com/models` with native key | 3 IDs | `deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp` |
| NewAPI OpenCode group | 7 IDs | Filtered gateway listing, not the Go provider's complete menu |
| NewAPI CommandCode group | 6 IDs | Includes `deepseek/deepseek-v4-flash`; not a direct provider entitlement check |
| NewAPI Windsurf group | 48 IDs | Includes `deepseek-v4-flash-max`; not Devin Pro billing evidence |
| `devin models list --format json` | 210 variants | Official account menu; DeepSeek Flash variants are `deepseek-v4-flash-low`, `-high`, `-max` |

No queried official DeepSeek, OpenCode Zen/Go, Devin account or relevant gateway
menu returned `DeepSeekV4.1Flash` or a V4.1 Flash ID. The observed V4 Flash IDs must
not be renamed to V4.1. This is a dated absence from the queried catalogs, not a
claim about every provider or future product. Likewise no GPT-4o-mini or Llama ID
appeared in those queried menus, so no invented profile was added for the user's
illustrative model names.

| Exact model / source | USD input / 1M | USD output / 1M | USD cached read / 1M | Price status |
| --- | ---: | ---: | ---: | --- |
| OpenCode Zen `deepseek-v4-flash`, models.dev `opencode` | 0.14 | 0.28 | 0.028 | Reference |
| OpenCode Zen `deepseek-v4-flash-free`, models.dev `opencode` | 0 | 0 | 0 | Reference; a listed free rate is not executable entitlement |
| OpenCode Go `deepseek-v4-flash`, models.dev `opencode-go` | 0.22 | 0.66 | 0.007 | Reference; subscription debit not measured |
| DeepSeek direct `deepseek-v4-flash`, models.dev `deepseek` | 0.14 | 0.28 | 0.0028 | Reference; actual account bill not measured |
| Devin official Flash low/high/max variants | 0.14 | 0.28 | See snapshot | Official menu reference; actual Pro debit not measured |
| CommandCode / Windsurf / Cursor / Grok subscription / Mirasim relay | Unknown | Unknown | Unknown | No fresh comparable account price |

`models.dev` is a separately labeled metadata source, not an official provider
bill. Its model list can disagree with a live provider menu (Zen metadata has 102
entries versus 70 live IDs). Metadata adds prices/capability declarations only;
it never creates a live model or proves tool capability. NewAPI alias ratios from
`gateway-policy.json` are gateway accounting approximations and are not imported
as true upstream prices. Per the user's explicit confirmation, Devin and Windsurf
share `accountPoolId: windsurf-devin-subscription`. Their observed billing sources
remain separate evidence fields: the native login says Devin Pro, while the
Windsurf adapter's actual debit has not been collected. That evidence gap must not
create two independent quota/concurrency pools for the same allowance.

## Native study

The initial evidence is the local study `/tmp/mirasim-executor-study/方案.md` and
its sanitized JSON probes dated 2026-09-09. Cursor Composer's real read tool
returned a random proof, but no structured question event occurred. Devin's
non-ACP task returned its random proof; Grok's non-ACP tool use also succeeded.
ACP handshakes advertise capabilities but do not verify prompt execution,
recovery, cancellation, independent review quality, or model billing.

The study's Mirasim 0.0.305 root workbench and the production orca 0.0.282 service
are distinct instances. A newer model roster must not certify the older service.
The official Mirasim guide was fetched successfully at `https://mirasim.ai/guide`.
Reference documents include `https://cursor.com/docs/cli/acp`,
`https://docs.devin.ai/cli/`, and
`https://docs.devin.ai/cli/enterprise/windsurf-auth`.

## Schema and routing integration

Top level: `schemaVersion: 1`, `providers`, `accountPools`, `sources`, `profiles`,
`snapshots`, `updatedAt`, and `freshness`. A profile contains:

```js
{
  id, backend: 'mirasim' | 'acp', agent, model,
  route: 'local' | 'cloud' | 'auto', provider, accountPoolId,
  modelFamily, roles, enabled, availability, pricing,
  quality, capabilities, defaultForModels,
  modelSourceId, pricingSourceId,
  // Optional Pi adapter binding; model remains the exact upstream ID:
  nativeProviderId, agentModel, connectionSourceId
}
```

`provider` identifies the route/supplier; `modelFamily` identifies the model
developer family. Two resellers of DeepSeek remain the same family for review
independence. `accountPoolId` is a stable logical billing/concurrency pool, never
a provider's personal account ID. Adding a provider does not require another
backend: compatible Pi API profiles still use Mirasim. Relay profiles always use
Mirasim with `route: cloud`; ACP profiles use `route: local`.

The main runtime can read the JSON's `profiles` array directly. Explicit IDs:

* `grok-mirasim-native` maps only `grok-4.6` through `defaultForModels`.
* `codex-relay-gpt-5.6-luna` maps `gpt-5.6-luna` and the explicitly selected old
  alias `gpt-5.6`. Sol, Terra and Astra relay profiles each map only their own
  exact model ID.
* Cursor uses `cursor-acp-composer`; pinned Devin uses `devin-acp-deepseek`.
  `devin-acp-default` is disabled because the original handshake did not expose
  the selected default model identity. It must not be an independent reviewer.
* `opencode-go-deepseek` and `deepseek-native-flash` expose both `nativeProviderId`
  and `agentModel`. The execution adapter must honor these, rather than sending
  the bare upstream ID into Pi's current default `gw` provider. No Pi settings or
  Mirasim model configuration were written here.

Every implicit alias is unique and has `implicitSelection.authorized: true` and
`fallback: none`. Runtime integration must reject a route override that silently
changes the profile's account/fee path. Do not fall back across account pools or
to cloud when a pinned native profile fails. Main owns `docs/model-routing.json`;
this subtask did not modify it.

`availability.status: available` requires fresh **execution** evidence through
the exact profile. `enabled` is a policy switch, not an assertion of health.
Most new profiles deliberately remain `unverified` (direct adapter candidates
also remain disabled). Main should qualify the actual deployed adapter, then
record its evidence; setting all entries to `available` after a models GET would
undo the failure protections. Cursor's current proof qualifies only basic
read/companion work, not architecture or review.

```js
const result = selectExecutionProfile(catalog, {
  role: 'review', // companion | review-low-risk | implementation | architecture
  task: { risk: 'high', requiredCapabilities: ['test'], maxCostUsd: 1 },
  authorProfileId: 'grok-mirasim-native',
  allowedProfileIds: authorizedProfileIds,
  now: Date.now()
});
// { status: 'selected'|'blocked', profile, ranked, rejected, reason }
```

The selector is pure. It filters enabled state, exact-model discovery freshness,
execution freshness, account readiness, quality tier, verified capabilities,
independence, authorized-profile constraints and budget **before** ranking cost.
Architecture and formal review require strong qualification and a different
known developer family; low-risk review allows standard quality but still needs
verified review capability and independence. Companion tasks can use basic
qualification. A role name or low price never supplies missing quality evidence.

Known prices must be fresh, complete USD per-million-token rates with a source.
Reference/unknown/stale prices are excluded unless `allowUnknownPrice: true` is
explicit; they rank after known prices and cannot satisfy a cost ceiling. Unknown
does not become zero. `allowedProfileIds` lets main restrict cost ranking to
already authorized fee paths. No automatic route mutation occurs in selection.

## CLI and verification

```sh
node scripts/execution-catalog.mjs list --json
node scripts/execution-catalog.mjs discover --home /home/orca --json
node scripts/execution-catalog.mjs refresh --home /home/orca --json
node scripts/execution-catalog.mjs refresh --home /home/orca --source deepseek-direct-models --json
node scripts/execution-catalog.mjs select --role companion --allow-unknown-price --json
node --test tests/execution-catalog.test.js
```

`refresh` atomically replaces only the chosen catalog (`--catalog` / `--output`).
The checked-in catalog is always mode `0644`, including after refresh under a
restrictive umask, so the service user can read deployment configuration. Other
existing outputs retain their mode; the library's writer accepts `{ mode: 0o600 }`
for private runtime snapshots. It issues GET
requests to model/metadata endpoints, refuses redirect credential forwarding and
insecure/credential-bearing URLs, and stores only allowlisted response fields.
No raw upstream errors or credentials are printed. Native evidence snapshots
are preserved with their original timestamps; this CLI does not launch native
agents or generate billable prompts. Updating a catalog timestamp never renews
execution evidence. Failed refreshes retain old model evidence with failed status
and its original `lastSuccessAt`; they cannot produce fresh availability.

Exit 0 means successful inventory/refresh, not healthy execution. A blocked
selection, failed/empty/partial refresh, or a refresh with no active sources exits
2. Invalid input exits 1. Unit tests use injected fetch/credential reads and
temporary catalog files, with no network, real accounts or live model calls.
Validation includes cost/quality ordering, high-risk review, developer-family
independence, budget/allowlist constraints, unknown/stale prices, stale/missing
availability, removed models, safe failed refreshes, credential provenance,
implicit alias ambiguity and CLI exit behavior.
