import { describe, expect, it } from "vitest";

import {
  COMMERCE_USDC_FIELD_CLASSES,
  CommerceUsdcAmountSchema,
  CommerceUsdcRepresentationSchema,
  addCommerceUsdcAmounts,
  compareCommerceUsdcAmounts,
  convertCommerceUsdcAmount,
  createCommerceUsdcAmount,
  formatCommerceUsdcAmount,
  subtractCommerceUsdcAmounts,
  type CommerceUsdcAmount,
  type CommerceUsdcRepresentation,
} from "../src/commerce/money.js";

const VERSION = "openarc.usdc-amount.v1";
const NETWORK_ID = "eip155:5042002";
const MAX_UINT256 =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";
const OVER_UINT256 =
  "115792089237316195423570985008687907853269984665640564039457584007913129639936";
const OVERFLOW_MSG = "USDC amount exceeds uint256 range";
const PRECISION_MSG = "USDC amount conversion would lose precision";
const UNDERFLOW_MSG = "USDC amount subtraction underflow";
const UNIT_MSG =
  "USDC amounts must share representation, network, asset, and decimals";

describe("CommerceUsdcAmountSchema", () => {
  it("accepts zero/one/max for both branches with exact fields", () => {
    for (const atomicAmount of ["0", "1", MAX_UINT256]) {
      expect(createCommerceUsdcAmount("native", atomicAmount)).toStrictEqual({
        schemaVersion: VERSION,
        networkId: NETWORK_ID,
        asset: "USDC",
        representation: "native",
        decimals: 18,
        atomicAmount,
      });
      expect(createCommerceUsdcAmount("erc20", atomicAmount)).toStrictEqual({
        schemaVersion: VERSION,
        networkId: NETWORK_ID,
        asset: "USDC",
        representation: "erc20",
        decimals: 6,
        atomicAmount,
      });
    }
  });

  it("rejects injected/unknown keys", () => {
    const valid = createCommerceUsdcAmount("erc20", "1");
    for (const key of ["privatePrompt", "signature", "dataClass", "extra"]) {
      expect(() =>
        CommerceUsdcAmountSchema.parse({ ...valid, [key]: "injected" }),
      ).toThrow();
    }
  });

  it("rejects wrong schemaVersion/network/asset/representation/decimals", () => {
    const native = createCommerceUsdcAmount("native", "1");
    expect(() =>
      CommerceUsdcAmountSchema.parse({ ...native, schemaVersion: "other" }),
    ).toThrow();
    expect(() =>
      CommerceUsdcAmountSchema.parse({ ...native, networkId: "eip155:1" }),
    ).toThrow();
    expect(() =>
      CommerceUsdcAmountSchema.parse({ ...native, asset: "USDT" }),
    ).toThrow();
    expect(() =>
      CommerceUsdcAmountSchema.parse({ ...native, representation: "bitcoin" }),
    ).toThrow();
    expect(() =>
      CommerceUsdcAmountSchema.parse({ ...native, decimals: 6 }),
    ).toThrow();
    const erc20 = createCommerceUsdcAmount("erc20", "1");
    expect(() =>
      CommerceUsdcAmountSchema.parse({ ...erc20, decimals: 18 }),
    ).toThrow();
  });

  it("rejects non-canonical atomicAmount strings", () => {
    const invalid: unknown[] = [
      "01",
      OVER_UINT256,
      "-1",
      "+1",
      " 1",
      "1 ",
      "1.0",
      "1e2",
      "0x1",
      1,
      null,
      undefined,
    ];
    for (const value of invalid) {
      expect(() =>
        createCommerceUsdcAmount("erc20", value as string),
      ).toThrow();
    }
    expect(() =>
      createCommerceUsdcAmount(
        "bitcoin" as unknown as CommerceUsdcRepresentation,
        "1",
      ),
    ).toThrow();
  });

  it("exposes literal union inference without casting", () => {
    const parsed = CommerceUsdcRepresentationSchema.parse("native");
    const literal: "native" | "erc20" = parsed;
    expect(literal).toBe("native");

    const amount: CommerceUsdcAmount = createCommerceUsdcAmount("native", "1");
    if (amount.representation === "native") {
      const decimals: 18 = amount.decimals;
      expect(decimals).toBe(18);
    }
  });
});

describe("convertCommerceUsdcAmount", () => {
  const erc20ToNative: Array<[string, string]> = [
    ["0", "0"],
    ["1", "1000000000000"],
    ["1230000", "1230000000000000000"],
  ];
  erc20ToNative.forEach(([from, to]) => {
    it(`erc20 ${from} -> native ${to}`, () => {
      expect(
        convertCommerceUsdcAmount(
          createCommerceUsdcAmount("erc20", from),
          "native",
        ).atomicAmount,
      ).toBe(to);
    });
  });

  const nativeToErc20: Array<[string, string]> = [
    ["0", "0"],
    ["1000000000000", "1"],
    ["1230000000000000000", "1230000"],
  ];
  nativeToErc20.forEach(([from, to]) => {
    it(`native ${from} -> erc20 ${to}`, () => {
      expect(
        convertCommerceUsdcAmount(
          createCommerceUsdcAmount("native", from),
          "erc20",
        ).atomicAmount,
      ).toBe(to);
    });
  });

  it("same representation returns an equivalent parsed quantity", () => {
    const native = createCommerceUsdcAmount("native", "42");
    expect(convertCommerceUsdcAmount(native, "native")).toStrictEqual(native);
  });

  it("rejects native->erc20 precision loss", () => {
    expect(() =>
      convertCommerceUsdcAmount(
        createCommerceUsdcAmount("native", "1"),
        "erc20",
      ),
    ).toThrow(PRECISION_MSG);
    expect(() =>
      convertCommerceUsdcAmount(
        createCommerceUsdcAmount("native", "999999999999"),
        "erc20",
      ),
    ).toThrow(PRECISION_MSG);
  });

  it("rejects max erc20->native overflow", () => {
    expect(() =>
      convertCommerceUsdcAmount(
        createCommerceUsdcAmount("erc20", MAX_UINT256),
        "native",
      ),
    ).toThrow(OVERFLOW_MSG);
  });

  it("rejects invalid target even when source is valid", () => {
    expect(() =>
      convertCommerceUsdcAmount(
        createCommerceUsdcAmount("native", "1"),
        "bitcoin" as unknown as CommerceUsdcRepresentation,
      ),
    ).toThrow();
  });

  it("does not mutate its input", () => {
    const amount = createCommerceUsdcAmount("erc20", "7");
    const snapshot = { ...amount };
    convertCommerceUsdcAmount(amount, "native");
    expect(amount).toStrictEqual(snapshot);
  });
});

describe("add/subtract/compare", () => {
  it("adds and subtracts above Number.MAX_SAFE_INTEGER", () => {
    const base = "9007199254740993";
    const one = createCommerceUsdcAmount("erc20", "1");
    expect(
      addCommerceUsdcAmounts(createCommerceUsdcAmount("erc20", base), one)
        .atomicAmount,
    ).toBe("9007199254740994");
    expect(
      subtractCommerceUsdcAmounts(createCommerceUsdcAmount("erc20", base), one)
        .atomicAmount,
    ).toBe("9007199254740992");
  });

  it("max+0 succeeds, max+1 overflows", () => {
    const max = createCommerceUsdcAmount("erc20", MAX_UINT256);
    const zero = createCommerceUsdcAmount("erc20", "0");
    const one = createCommerceUsdcAmount("erc20", "1");
    expect(addCommerceUsdcAmounts(max, zero).atomicAmount).toBe(MAX_UINT256);
    expect(() => addCommerceUsdcAmounts(max, one)).toThrow(OVERFLOW_MSG);
  });

  it("subtraction permits zero and rejects underflow", () => {
    const five = createCommerceUsdcAmount("erc20", "5");
    expect(subtractCommerceUsdcAmounts(five, five).atomicAmount).toBe("0");
    expect(() =>
      subtractCommerceUsdcAmounts(
        createCommerceUsdcAmount("erc20", "1"),
        createCommerceUsdcAmount("erc20", "2"),
      ),
    ).toThrow(UNDERFLOW_MSG);
  });

  it("compare returns -1/0/1", () => {
    const one = createCommerceUsdcAmount("erc20", "1");
    const two = createCommerceUsdcAmount("erc20", "2");
    expect(compareCommerceUsdcAmounts(one, two)).toBe(-1);
    expect(compareCommerceUsdcAmounts(two, one)).toBe(1);
    expect(compareCommerceUsdcAmounts(two, two)).toBe(0);
  });

  it("mismatched valid representations never compare silently", () => {
    const native = createCommerceUsdcAmount("native", "1");
    const erc20 = createCommerceUsdcAmount("erc20", "1000000000000");
    expect(() => addCommerceUsdcAmounts(native, erc20)).toThrow(UNIT_MSG);
    expect(() => subtractCommerceUsdcAmounts(native, erc20)).toThrow(UNIT_MSG);
    expect(() => compareCommerceUsdcAmounts(native, erc20)).toThrow(UNIT_MSG);
  });

  it("validates malformed atomic strings at function boundaries", () => {
    const malformed = {
      ...createCommerceUsdcAmount("erc20", "1"),
      atomicAmount: "01",
    } as unknown as CommerceUsdcAmount;
    const valid = createCommerceUsdcAmount("erc20", "1");
    expect(() => addCommerceUsdcAmounts(malformed, valid)).toThrow();
    expect(() => subtractCommerceUsdcAmounts(valid, malformed)).toThrow();
    expect(() => compareCommerceUsdcAmounts(malformed, malformed)).toThrow();
  });
});

describe("formatCommerceUsdcAmount", () => {
  const cases: Array<[CommerceUsdcRepresentation, string, string]> = [
    ["native", "0", "0"],
    ["native", "1", "0.000000000000000001"],
    ["native", "100000000000000000", "0.1"],
    ["native", "1000000000000000000", "1"],
    ["native", "1234567890123456789", "1.234567890123456789"],
    ["erc20", "1", "0.000001"],
    ["erc20", "1000000", "1"],
    ["erc20", "1230000", "1.23"],
    ["erc20", "1230001", "1.230001"],
    ["erc20", "123456789000000", "123456789"],
  ];
  cases.forEach(([representation, atomicAmount, expected]) => {
    it(`format ${representation} ${atomicAmount} -> ${expected}`, () => {
      expect(
        formatCommerceUsdcAmount(
          createCommerceUsdcAmount(representation, atomicAmount),
        ),
      ).toBe(expected);
    });
  });
});

describe("COMMERCE_USDC_FIELD_CLASSES", () => {
  it("is frozen with exact organization_protected keys", () => {
    expect(Object.isFrozen(COMMERCE_USDC_FIELD_CLASSES)).toBe(true);
    expect(Object.keys(COMMERCE_USDC_FIELD_CLASSES).sort()).toStrictEqual(
      [
        "schemaVersion",
        "networkId",
        "asset",
        "representation",
        "decimals",
        "atomicAmount",
      ].sort(),
    );
    for (const value of Object.values(COMMERCE_USDC_FIELD_CLASSES)) {
      expect(value).toBe("organization_protected");
    }
  });
});

describe("bounded deterministic property loop", () => {
  it("roundtrips, add/sub inverse, compare antisymmetry", () => {
    for (let i = 0; i <= 200; i += 1) {
      const erc20 = createCommerceUsdcAmount("erc20", String(i));
      const native = convertCommerceUsdcAmount(erc20, "native");
      expect(convertCommerceUsdcAmount(native, "erc20").atomicAmount).toBe(
        String(i),
      );

      const a = createCommerceUsdcAmount("erc20", String(i * 1000));
      const b = createCommerceUsdcAmount("erc20", String(i));
      expect(
        subtractCommerceUsdcAmounts(addCommerceUsdcAmounts(a, b), b)
          .atomicAmount,
      ).toBe(a.atomicAmount);
      expect(
        compareCommerceUsdcAmounts(a, b) +
          compareCommerceUsdcAmounts(b, a),
      ).toBe(0);
    }

    const large = "115792089237316195423570985008687907853269984665640564039457584007913129639934";
    const largeA = createCommerceUsdcAmount("erc20", large);
    const largeB = createCommerceUsdcAmount("erc20", "1");
    expect(
      subtractCommerceUsdcAmounts(addCommerceUsdcAmounts(largeA, largeB), largeB)
        .atomicAmount,
    ).toBe(large);
  });
});
