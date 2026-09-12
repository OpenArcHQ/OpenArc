# PORT-02 listing contracts — component acceptance

September 12, 2026. Additive shared contracts over foundation288d0ec.
Implementation/tests authored by OpenCode Go `opencode-go/deepseek-v4.1-flash`.

Strict bounded listing roots and versions now define canonical identifiers,
fixed positive Arc Testnet ERC20-USDC prices, manifests, receipt and endpoint
contracts, availability declarations, immutable content and public projections.
Public projection refuses non-active or unreviewed versions and explicitly
excludes organization IDs, endpoint paths and internal review fields. Actual
provider status/active-pointer authorization remains the repository's job.

Review closed bounded integer conversion and inferred price-type narrowing.
The installed schema library's intersection accepted an extra nested amount key;
the final implementation reuses the existing strict ERC20 branch directly,
without assertions or a competing money model. Negative runtime cases and
compile-time inference assertions remain load-bearing.

Final exact CLI checks, all exit0:

- focused `commerce-listing.test.ts`:33 tests.
- all shared unit tests:503 across26 files.
- shared build/typecheck, test TypeScript and ESLint:passed.

Evidence: listing-contracts-XWujWo `workspace/branch-response.jsonl`, completed
07:20UTC. Earlier failed intersection attempts are not counted as passes.

This is component acceptance only. No marketplace API/UI, provider endpoint
execution, purchase capability, production deployment or whole-port completion
is claimed. PORT-02 remains active; later phases remain queued.
