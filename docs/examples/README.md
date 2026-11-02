# FerryCat Payload Examples

Copy-paste templates for the three payloads you write by hand. Test 21D validates the JSON
payloads against the real Zod / Ajv schemas (plus unified-diff hunk arithmetic on `fixes[].patch`)
and runs `handler.example.cjs` end-to-end in strict `envelope` mode, so they cannot silently drift
from the code.

| File | Used by | What it shows |
| :--- | :--- | :--- |
| [`dispatch.example.json`](dispatch.example.json) | `ferrycat-cli dispatch` / MCP `dispatch_contract` | pointers with and without `line_range`, a Draft-07 `contract_schema`, explicit `exec_ttl_sec` |
| [`fulfill.example.json`](fulfill.example.json) | `ferrycat-cli fulfill` / MCP `fulfill_contract` | `result_summary` + `structured_output` matching the schema above, proposed edits in `fixes` |
| [`handler.example.cjs`](handler.example.cjs) | `worker --exec-file` / daemon `exec_file` | reading the contract from stdin, logging freely, emitting the delivery envelope |

## 1. Dispatch

Replace `workspace_root` with the absolute path of the repository both hosts can see, then:

```bash
ferrycat-cli dispatch --file docs/examples/dispatch.example.json
# or via stdin
cat docs/examples/dispatch.example.json | ferrycat-cli dispatch -
```

`pointers[].path` is relative to `workspace_root` and must exist; every file is hashed (full-file
SHA-256) at dispatch time. `line_range` is a focus hint for the worker, not a hashing boundary.

## 2. Fulfill (manual / MCP)

Use the `contract_id` and `claim_token` returned by `poll`:

```bash
ferrycat-cli fulfill --id <contract_id> --token <claim_token> --file docs/examples/fulfill.example.json
```

Explicit `--id` / `--token` / `--agent` flags override the values in the file. When the contract
carries a `contract_schema`, `structured_output` is validated with Ajv: two failures return
`RETRY_NEEDED`, the third is terminal `VALIDATION_FAILED`.

## 3. Automated handlers (`--exec-file`, daemon)

The supervisor pipes the claimed contract to the child as a single JSON object on **stdin** and
injects `FERRYCAT_CONTRACT_ID`, `FERRYCAT_TASK_TYPE`, `FERRYCAT_WORKSPACE_ROOT`,
`FERRYCAT_TARGET_AGENT` and `FERRYCAT_CLAIM_TOKEN`. Other host env vars are dropped unless named
with `--pass-env` (or `pass_env` in `ferrycat.config.json`).

### stdout delivery contract (REQ-ENG-04)

How stdout becomes the deliverable is fixed, never guessed:

| stdout shape | `--delivery auto` (default) | `--delivery envelope` |
| :--- | :--- | :--- |
| One line `{"ferrycat_delivery":{...}}`, other lines are logs | accepted (`ENVELOPE`) | accepted |
| Whole stdout is one JSON object with `result_summary` and/or `structured_output` | accepted, only those keys (`LEGACY_KEYS`) | rejected: `DELIVERY_MISSING` |
| Any other JSON object, e.g. a trailing log line | plain-text `result_summary` only, with a warning (`RAW_TEXT`) | rejected: `DELIVERY_MISSING` |
| Plain text | `result_summary` (`RAW_TEXT`) | rejected: `DELIVERY_MISSING` |
| Two or more envelope lines | rejected: `DELIVERY_AMBIGUOUS` | rejected |
| Envelope with unknown keys / wrong types / empty | rejected: `DELIVERY_MALFORMED` | rejected |

Envelope keys: `result_summary` (non-empty string), `structured_output` (object),
`artifacts_pointers` (array of `{ path, description }`). At least one of the first two is required.

A rejected delivery marks the contract `FAILED` with the error code in `error_reason`; the raw
stdout/stderr tail is preserved in `salvaged_result`, so nothing the handler produced is lost.

The trade-off: `auto` keeps pre-0.5 handlers working, but a handler that prints only arbitrary
JSON no longer gets it promoted to `structured_output` (this was the bug the contract fixes). Use
`envelope` for new handlers so a forgotten or misspelled envelope fails fast instead of
completing with the wrong payload.

```bash
ferrycat-cli worker --agent workbuddy --mode=exec --once \
  --exec-file docs/examples/handler.example.cjs --delivery envelope
```

Daemon equivalent in `ferrycat.config.json`:

```json
{
  "agents": {
    "workbuddy": {
      "handlers": {
        "code_review": { "exec_file": "./docs/examples/handler.example.cjs", "delivery": "envelope" }
      }
    }
  }
}
```

Exit codes: `0` submits the delivery through `fulfill` (TOCTOU fingerprint re-check and schema
validation still apply); non-zero marks the contract `FAILED` with stderr as the reason.
