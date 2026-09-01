import { describe, expect, it } from "vitest";

import {
  ARC_TESTNET,
  BuildInfoSchema,
  CanonicalDecimalSchema,
  EvmAddressSchema,
  NETWORKS,
  TransactionHashSchema,
} from "../src/index.js";

describe("Arc Testnet registry", () => {
  it("pins the current official network identity and primary RPC", () => {
    expect(ARC_TESTNET.chainId).toBe("5042002");
    expect(ARC_TESTNET.chainIdHex).toBe("0x4cef52");
    expect(Number.parseInt(ARC_TESTNET.chainIdHex.slice(2), 16).toString()).toBe(
      ARC_TESTNET.chainId,
    );
    expect(ARC_TESTNET.rpcHttp).toBe("https://rpc.testnet.arc.io");
    expect(ARC_TESTNET.rpcWebSocket).toBe("wss://rpc.testnet.arc.io");
    expect(ARC_TESTNET.caip2).toBe("eip155:5042002");
    expect(ARC_TESTNET.contracts).toEqual({
      usdc: "0x3600000000000000000000000000000000000000",
      gatewayWallet: "0x0077777d7eba4688bdef3e311b846f25870a19b9",
      gatewayMinter: "0x0022222abe238cc2c7bb1f21003f0a260052475b",
      erc8004IdentityRegistry: "0x8004a818bfb912233c491871b3d84c89a494bd9e",
      erc8004ReputationRegistry: "0x8004b663056a597dffe9eccc1965a193b7388713",
      erc8004ValidationRegistry: "0x8004cb1bf31daf7788923b405b754f57aceb4272",
      erc8183AgenticCommerce: "0x0747eef0706327138c69792bf28cd525089e4583",
    });
  });

  it("contains no placeholder or copied mainnet configuration", () => {
    expect(Object.keys(NETWORKS)).toEqual(["arcTestnet"]);
    expect(JSON.stringify(NETWORKS).toLowerCase()).not.toContain("mainnet");
  });

  it("canonicalizes EVM addresses without changing their bytes", () => {
    expect(
      EvmAddressSchema.parse("0x8004A818BFB912233c491871b3d84c89A494BD9e"),
    ).toBe("0x8004a818bfb912233c491871b3d84c89a494bd9e");
    expect(
      TransactionHashSchema.parse(
        "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ),
    ).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("keeps exact decimal values as bounded canonical strings", () => {
    for (const value of ["0", "1", "1.01", "0.000000001"]) {
      expect(CanonicalDecimalSchema.parse(value)).toBe(value);
    }
    for (const value of ["01", "1.0", "-1", "1e2", "1."]) {
      expect(() => CanonicalDecimalSchema.parse(value)).toThrow();
    }
  });

  it("validates exact build markers", () => {
    expect(
      BuildInfoSchema.parse({
        service: "openarc-api",
        version: "0.0.0",
        commitSha: "local",
      }),
    ).toEqual({ service: "openarc-api", version: "0.0.0", commitSha: "local" });
    expect(() =>
      BuildInfoSchema.parse({
        service: "openarc-api",
        version: "0.0.0",
        commitSha: "bad marker",
      }),
    ).toThrow();
  });
});
