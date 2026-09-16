# Arc mainnet: the gate is open (verified 2026-09-16)

Supersedes the blocked finding in `arc-mainnet-readiness-2026-09-15.md`. Every
value below was read from a live endpoint today, not from an announcement.

## The three conditions, and their evidence

**1. Arc mainnet exists and is reachable.**
`POST https://rpc.mainnet.arc.io` with `eth_chainId` returns `0x13b2` = **5042**.
So the mainnet CAIP-2 identifier is `eip155:5042`. (Testnet stays
`eip155:5042002`.)

**2. Circle Gateway is deployed on Arc mainnet.**
Arc's contract reference lists, for mainnet (CCTP domain 26):
- GatewayWallet `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE`
- GatewayMinter `0x2222222d7164433c4C09B0b0D809a9b52C04C205`

**3. USDC has a mainnet address in Circle's own registry.**
`GET https://gateway-api.circle.com/v1/x402/supported` advertises Arc mainnet
directly:

```json
{ "x402Version": 2, "scheme": "exact", "network": "eip155:5042",
  "extra": { "name": "GatewayWalletBatched", "version": "1",
             "verifyingContract": "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee",
             "minValiditySeconds": 604800,
             "assets": [{ "symbol": "USDC",
                          "address": "0x3600000000000000000000000000000000000000",
                          "decimals": 6 }] } }
```

The production facilitator currently advertises twelve networks:
`eip155:1, 8453, 43114, 42161, 10, 137, 130, 146, 480, 1329, 999, 5042`.

## What changes for us

- The **production facilitator origin is `https://gateway-api.circle.com`**,
  distinct from the testnet origin we pin today.
- The **verifying contract differs by network**: mainnet
  `0x77777777dcc4d5a8b6e418fd04d8997ef11000ee`, testnet
  `0x0077777d7eba4688bdef3e311b846f25870a19b9`. Anything that assumes one
  contract across networks is wrong.
- **USDC keeps the same address on both** (`0x3600…0000`, 6 decimals), so the
  asset address alone never identifies the network. Bind the network id.
- `minValiditySeconds` is 604800 on both, so the seven-day signature floor and
  our buffer reasoning carry over unchanged.

## What has NOT changed

The gate being open is not readiness. Our lane manifest deliberately holds a
single frozen testnet entry and throws on anything else, including
`eip155:5042`. Mainnet requires:

1. A second frozen manifest entry with the mainnet facilitator origin,
   verifying contract and chain id — never a fallback, never a default.
2. Every network-dependent term rebound per network, with a test that a
   testnet-signed authorization is invalid on mainnet and vice versa.
3. A full acceptance run against mainnet with real USDC.
4. The settlement, entitlement and operator surfaces finished, because on
   mainnet "held and unresolved" is real money that a person has to reconcile.

**The bar rises here rather than falling.** Every rule we wrote — unresolved
exposure stays held, a Gateway completion is not a confirmation, unknown money
keeps its own line — was written for testnet play money. On mainnet those rules
are the difference between a bug and a loss. Nothing ships to mainnet before
the acceptance run, and no claim of mainnet support is made before it passes.
