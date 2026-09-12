import { expect, test, type Page } from "@playwright/test";
import type * as ViemAccounts from "../apps/api/node_modules/viem/_types/accounts/index.js";

/**
 * Resolved through the API workspace's pinned viem dependency; the frontend
 * must not gain a signer dependency of its own. The runtime module is loaded
 * from the API package while its declarations come from the same package's
 * type build.
 */
const viemAccountsPath = "../apps/api/node_modules/viem/_esm/accounts/index.js";
let viemAccounts: typeof ViemAccounts | undefined;

test.beforeAll(async () => {
  viemAccounts = (await import(viemAccountsPath)) as typeof ViemAccounts;
});

function viem(): typeof ViemAccounts {
  if (viemAccounts === undefined) throw new Error("viem test dependency not loaded");
  return viemAccounts;
}

/**
 * Real SIWE acceptance with a synthetic EOA.
 *
 * The private key is generated in this Node test process only and is never
 * written to a page, file or log. The page sees a narrowly mocked EIP-1193
 * provider that forwards only `personal_sign` to a Node-side exposed signer;
 * the real server verifies the resulting SIWE signature.
 */

async function installWallet(
  page: Page,
  signerAddress: string,
  sign: (hex: string) => Promise<string>,
  accountOverride?: string,
): Promise<void> {
  await page.exposeFunction("__eoaSign", (hexMessage: string) => sign(hexMessage));
  await page.addInitScript(
    ({ account }) => {
      const w = window as typeof window & { __walletCalls?: string[]; __wallet?: unknown };
      w.__walletCalls = [];
      const noop = () => undefined;
      w.__wallet = {
        request(input: { method: string; params?: unknown[] }) {
          w.__walletCalls?.push(input.method);
          if (input.method === "eth_requestAccounts" || input.method === "eth_accounts") {
            return Promise.resolve([account]);
          }
          if (input.method === "eth_chainId") return Promise.resolve("0x4cef52");
          if (input.method === "personal_sign") {
            const hex = input.params?.[0];
            if (typeof hex !== "string") return Promise.reject(new Error("bad"));
            return (window as typeof window & { __eoaSign: (h: string) => Promise<string> }).__eoaSign(hex);
          }
          return Promise.reject(new Error("unsupported"));
        },
        on: noop,
        removeListener: noop,
      };
      Object.defineProperty(window, "ethereum", {
        configurable: true,
        get: () => w.__wallet,
      });
    },
    { account: accountOverride ?? signerAddress },
  );
}

async function walletCalls(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as typeof window & { __walletCalls?: string[] }).__walletCalls ?? [],
  );
}

/**
 * Replaces the injected provider at runtime with a distinct wallet so the
 * link step links a different address than the one used to sign in.
 */
async function overrideWallet(
  page: Page,
  account: string,
  sign: (hex: string) => Promise<string>,
): Promise<void> {
  const signerName = `__eoaSign_${Math.abs(
    account.split("").reduce((total, character) => total + character.charCodeAt(0), 0),
  )}`;
  await page.exposeFunction(signerName, (hexMessage: string) => sign(hexMessage));
  await page.evaluate(
    ({ address, fn }) => {
      const w = window as typeof window & {
        __wallet?: unknown;
        __secondary?: {
          request(input: { method: string; params?: unknown[] }): Promise<unknown>;
          on?: (event: string, listener: (...args: unknown[]) => void) => void;
          removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
        };
      };
      const noop = () => undefined;
      w.__secondary = {
        request(input) {
          if (input.method === "eth_requestAccounts" || input.method === "eth_accounts") {
            return Promise.resolve([address]);
          }
          if (input.method === "eth_chainId") return Promise.resolve("0x4cef52");
          if (input.method === "personal_sign") {
            const hex = input.params?.[0];
            if (typeof hex !== "string") return Promise.reject(new Error("bad"));
            return (window as unknown as Record<string, (h: string) => Promise<string>>)[fn]!(hex);
          }
          return Promise.reject(new Error("unsupported"));
        },
        on: noop,
        removeListener: noop,
      };
      Object.defineProperty(window, "ethereum", {
        configurable: true,
        get: () => w.__secondary,
      });
    },
    { address: account, fn: signerName },
  );
}

test.describe.configure({ mode: "serial" });

test("signs in and links a wallet with only account access and personal_sign", async ({ page }) => {
  const privateKey = viem().generatePrivateKey();
  const account = viem().privateKeyToAccount(privateKey);
  await installWallet(page, account.address, (hex) =>
    account.signMessage({ message: { raw: hex as `0x${string}` } }),
  );
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Sign in or create an account" })).toBeVisible();

  await page.getByRole("button", { name: "Sign in with wallet" }).click();
  await expect(page.getByTestId("wallet-confirm")).toBeVisible();
  const shown = (await page.getByTestId("wallet-message").textContent()) ?? "";
  expect(shown).toContain("wants you to sign in with your Ethereum account:");
  expect(shown).toContain("Sign in to OpenArc. This does not authorize payments.");
  expect(shown).toContain("Chain ID: 5042002");
  const accountUri = new URL(page.url()).origin + "/account";
  expect(shown).toContain(`URI: ${accountUri}`);

  await page.getByTestId("wallet-confirm").getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId("account-id")).toBeVisible();

  const calls = await walletCalls(page);
  expect(calls).toContain("eth_requestAccounts");
  expect(calls.filter((name) => name === "personal_sign")).toHaveLength(1);
  for (const forbidden of [
    "eth_sendTransaction",
    "wallet_sendCalls",
    "eth_signTypedData_v4",
    "wallet_switchEthereumChain",
    "wallet_addEthereumChain",
  ]) {
    expect(calls).not.toContain(forbidden);
  }

  // Link a distinct wallet from the signed-in view.
  const linked = viem().privateKeyToAccount(viem().generatePrivateKey());
  await overrideWallet(page, linked.address, (hex) =>
    linked.signMessage({ message: { raw: hex as `0x${string}` } }),
  );
  await page.getByRole("button", { name: "Link wallet" }).click();
  await expect(page.getByTestId("wallet-confirm")).toBeVisible();
  await page.getByTestId("wallet-confirm").getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId("account-notice")).toContainText("Wallet linked");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in or create an account" })).toBeVisible();
});

test("a wrong account cannot sign in", async ({ page }) => {
  const privateKey = viem().generatePrivateKey();
  const account = viem().privateKeyToAccount(privateKey);
  const other = viem().privateKeyToAccount(viem().generatePrivateKey());
  // The provider reports the expected address but signs with a different key.
  await installWallet(
    page,
    account.address,
    (hex) => other.signMessage({ message: { raw: hex as `0x${string}` } }),
  );
  await page.goto("/account");
  await page.getByRole("button", { name: "Sign in with wallet" }).click();
  await expect(page.getByTestId("wallet-confirm")).toBeVisible();
  await page.getByTestId("wallet-confirm").getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId("account-notice")).toBeVisible();
  await expect(page.getByTestId("account-id")).toHaveCount(0);
});

test("a rejected personal_sign cannot sign in", async ({ page }) => {
  const privateKey = viem().generatePrivateKey();
  const account = viem().privateKeyToAccount(privateKey);
  await installWallet(page, account.address, async () => {
    throw new Error("user rejected");
  });
  await page.goto("/account");
  await page.getByRole("button", { name: "Sign in with wallet" }).click();
  await expect(page.getByTestId("wallet-confirm")).toBeVisible();
  await page.getByTestId("wallet-confirm").getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId("account-notice")).toBeVisible();
  await expect(page.getByTestId("account-id")).toHaveCount(0);
});
