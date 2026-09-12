# OpenArc Testnet reference provider contract (P02-06)

TESTNET REFERENCE ONLY. This directory is a contract and fixture set. It is not
a service, not a deployment, not a third-party vendor integration, and not a
purchase or payment implementation. PORT03+ are intentionally not implemented
here.

## What this is

A deliberately simple, deterministic, first-party reference sum API makes
delivery evidence testable without sending private prompts to a research
provider. The declared operation is integer addition:

| Request (`openarc.reference-input.v1`) | Response (`openarc.reference-output.v1`) |
| --- | --- |
| `{ "schemaVersion": "openarc.reference-input.v1", "a": 1, "b": 2 }` | `{ "schemaVersion": "openarc.reference-output.v1", "sum": 3 }` |

`a` and `b` are integers in `0..1000000`; `sum` is an integer in `0..2000000`.
No names, emails, wallets, arbitrary URLs, prompts, scripts or external data are
accepted. Every JSON Schema here is an explicit 2020-12 `object` with
`additionalProperties: false` and a complete `required` list. No schema uses a
remote `$ref`, and no generic validator dependency is added by this directory.

## Files

- `input.schema.json` — strict request schema.
- `output.schema.json` — strict response schema.
- `receipt.schema.json` — provider delivery-receipt schema
  (`openarc.reference-receipt.v1`).
- `listing.fixture.json` — synthetic `CommerceListingOwnerVersionSchema` DTO.
  It is a draft, unreviewed, unavailable fixture and must never be published or
  auto-seeded into web/API bundles.
- `retrieval-contract.json` — declared direct-retrieval semantics. Status is
  honestly `contract_only`; nothing here executes.
- `contract.test.mjs` — `node:test` contract tests importing the built shared
  schemas.

## Receipt is an assertion, not settlement

`receipt.schema.json` is a provider assertion. It is **not** chain settlement,
a quality proof, user authorization, a signature, or retrieval success. It
embeds no raw input or output. `deliveryId` is an opaque lowercase UUIDv4 and is
not a capability or a token.

## Byte-digest instructions

The three schema files are pinned by SHA-256 over their **exact UTF-8 file
bytes including the final newline**, formatted as `sha256:<lowercase-hex-64>`,
used in `listing.fixture.json`:

```sh
shasum -a 256 tools/reference-provider/input.schema.json
shasum -a 256 tools/reference-provider/output.schema.json
shasum -a 256 tools/reference-provider/receipt.schema.json
```

This local artifact digest convention is not a redefinition of platform request
canonicalization. The tests recompute `node:crypto` hashes from actual bytes and
reject changed schema bytes or digest mismatches. They do not claim a full
generic JSON Schema validator exists.

## Current versus planned boundary

Current (implemented here):

- strict input/output/receipt JSON Schemas;
- one synthetic owner-version listing fixture;
- a descriptive retrieval contract marked `contract_only`.

Planned (not implemented here, and not claimed to work):

- an actual authenticated retrieval read;
- cross-actor rejection;
- lost-response repeat with no extra charge;
- expiry/deletion with exact digest checks;
- any purchase, payment, charging or retry dispatch.

The proposed controlled-test result-retention policy is 24 hours from first
delivery with an immutable expiry that a GET does not extend: after expiry 410
with no output and no recharge, proof failure 403 without existence details,
before known completion 409, and never a fake success for a missing artifact.
These are contract semantics awaiting PORT04; they do not claim current recovery
works, and platform uniqueness/audit retention remains separately governed.
Durable financial tombstones are not deleted by result expiry. No guessed
production legal retention period or mainnet address is recorded.

Before advertising recovery, validate: actual authenticated read, cross-actor
rejection, lost-response repeat/no extra charge, expiry/deletion, and exact
digest checks.

## Endpoint and origin

`https://reference.openarc.example` and the paths `/v1/sum` and
`GET /v1/deliveries/:deliveryId` are **reserved documentation only**. This is
not a real owned or deployed domain and not an approved origin. No DNS lookup,
network call or server execution is performed by these tests.

Retrieval auth is planned as a separately scoped delivery proof in the
`Authorization` header, never query, cookie or browser storage; no token is
generated or stored in these fixtures. A proof must bind provider, listing
immutable version, delivery and the authorized requester/action; a digest alone
never grants retrieval. Retrieval scope is retrieval only and cannot initiate,
charge or retry a purchase. Repeated successful authorized retrieval returns
byte-identical output with the same digest, never reruns the operation and never
charges again, rechecking proof expiry/revocation and ownership each time.
Future transport is `no-store`, rejects redirects, bounds responses to 64 KiB,
and logs no raw payload or token.

## Privacy and money

Operands are synthetic only and no active endpoint exists; the privacy summary
in the fixture explicitly makes no zero-retention account claim. These are
disposable Testnet tokens with no promised monetary value. Nothing here is paid
execution, mainnet approval, endpoint safety certification or endorsement, and
no claim is made that network usage is free. Fee costs are separate and would
only apply if a payment lane is later enabled; the fixture keeps
`paymentLane: "unavailable"`.

## Running the tests

From the workspace root, build the shared package and run only this test:

```sh
pnpm --filter @openarc/shared build
node --test tools/reference-provider/contract.test.mjs
```

This focused pair is sufficient for this fixture-only addition; do not run broad
suites for it.
