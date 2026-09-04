import { ARC_TESTNET } from "@openarc/shared";
import { encodeAbiParameters, parseAbiParameters } from "viem";
import { describe, expect, it } from "vitest";

import { AgentRegistryService } from "../src/arc/agent-registry-service.js";
import type { ArcRpcMethod, ArcRpcReader } from "../src/arc/rpc-client.js";
import { ApiBoundaryError } from "../src/http/errors.js";
import type { SourceLease } from "../src/limits/budget.js";

const signal = new AbortController().signal;
const lease = {} as SourceLease;
const owner = "0x1111111111111111111111111111111111111111";
const wallet = "0x2222222222222222222222222222222222222222";
const observer = "0x3333333333333333333333333333333333333333";
const validator = "0x4444444444444444444444444444444444444444";
const requestHash = `0x${"a".repeat(64)}` as const;
const responseHash = `0x${"b".repeat(64)}` as const;
const blockHash = `0x${"c".repeat(64)}`;
const anchor = { number: "0x64", hash: blockHash, timestamp: "0x6553f100" };

const encoded = (types: string, values: readonly unknown[]) =>
  encodeAbiParameters(parseAbiParameters(types), values);
const addressResult = (value: string) => encoded("address", [value]);
const stringResult = (value: string) => encoded("string", [value]);

class SequenceRpc implements ArcRpcReader {
  readonly calls: { method: ArcRpcMethod; params: readonly unknown[] }[] = [];
  constructor(private readonly sequence: readonly (unknown | Error)[]) {}
  async call(method: ArcRpcMethod, params: readonly unknown[]): Promise<unknown> {
    this.calls.push({ method, params });
    const next = this.sequence[this.calls.length - 1];
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error("Unexpected RPC call");
    return next;
  }
}

function sequence(mutations: { owner?: string; wallet?: string; metadata?: string; reputationBinding?: string;
  validationBinding?: string; validationAgentId?: bigint; repeated?: unknown } = {}) {
  return new SequenceRpc([
    ARC_TESTNET.chainIdHex, anchor, addressResult(mutations.owner ?? owner),
    stringResult(mutations.metadata ?? "https://example.test/agent.json"), addressResult(mutations.wallet ?? wallet),
    addressResult(mutations.reputationBinding ?? ARC_TESTNET.contracts.erc8004IdentityRegistry),
    addressResult(mutations.validationBinding ?? ARC_TESTNET.contracts.erc8004IdentityRegistry),
    encoded("int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked",
      [-1234n, 2, "quality", "delivery", false]),
    encoded("address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate",
      [validator, mutations.validationAgentId ?? 1n, 87, responseHash, "benchmark", 123n]),
    mutations.repeated ?? anchor,
  ]);
}

const request = { network: ARC_TESTNET.caip2, agentId: "1",
  feedbackQuery: { clientAddress: observer, feedbackIndex: "0" }, validationRequestHash: requestHash } as const;

describe("M05 ERC-8004 agent evidence", () => {
  it("returns identity plus exact observer and validator claims at one final block", async () => {
    const rpc = sequence();
    const evidence = await new AgentRegistryService(rpc, () => "2026-09-04T12:00:00.000Z")
      .observe(request, lease, signal);
    expect(evidence.identity).toEqual({ owner, agentWallet: wallet,
      metadata: { uri: "https://example.test/agent.json", kind: "https",
        trust: "untrusted_external_metadata", fetched: false } });
    expect(evidence.feedback).toMatchObject({ observer, value: "-1234", valueDecimals: 2, decimal: "-12.34",
      relationship: "observer_specific_claim" });
    expect(evidence.validation).toMatchObject({ requestHash, validator, agentId: "1", response: 87,
      responseHash, relationship: "validator_specific_response" });
    expect(rpc.calls).toHaveLength(10);
    for (const call of rpc.calls.filter((entry) => entry.method === "eth_call")) {
      expect(call.params[1]).toBe("0x64");
      expect(Object.keys(call.params[0] as object).sort()).toEqual(["data", "to"]);
    }
  });

  it("classifies malformed URI text without fetching it", async () => {
    const rpc = sequence({ metadata: "javascript:alert(1)" });
    const evidence = await new AgentRegistryService(rpc).observe(request, lease, signal);
    expect(evidence.identity.metadata).toEqual({ uri: "javascript:alert(1)", kind: "other",
      trust: "untrusted_external_metadata", fetched: false });
  });

  it.each([
    ["wrong reputation binding", sequence({ reputationBinding: observer }), "SOURCE_CONFLICT"],
    ["wrong validation binding", sequence({ validationBinding: observer }), "SOURCE_CONFLICT"],
    ["oversized metadata", sequence({ metadata: "x".repeat(4097) }), "SOURCE_MALFORMED"],
    ["validation belongs to another agent", sequence({ validationAgentId: 2n }), "SOURCE_CONFLICT"],
    ["anchor changed", sequence({ repeated: { ...anchor, hash: `0x${"d".repeat(64)}` } }), "SOURCE_CONFLICT"],
  ])("fails closed for %s", async (_name, rpc, code) => {
    await expect(new AgentRegistryService(rpc).observe(request, lease, signal)).rejects.toMatchObject({ code });
  });

  it("rejects owner or agent-wallet self feedback before reading a feedback claim", async () => {
    const rpc = sequence();
    await expect(new AgentRegistryService(rpc).observe({ ...request,
      feedbackQuery: { clientAddress: owner, feedbackIndex: "0" } }, lease, signal))
      .rejects.toMatchObject({ code: "SOURCE_CONFLICT" });
    expect(rpc.calls).toHaveLength(7);
  });

  it("preserves a sanitized not-found error for an unknown agent", async () => {
    const rpc = new SequenceRpc([ARC_TESTNET.chainIdHex, anchor, new ApiBoundaryError("SOURCE_NOT_FOUND")]);
    await expect(new AgentRegistryService(rpc).observe({ network: ARC_TESTNET.caip2, agentId: "999999" }, lease, signal))
      .rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" });
  });
});
