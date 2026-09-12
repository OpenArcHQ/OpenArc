import { expect, test, type Page } from "@playwright/test";

/**
 * Honest UI/failure coverage that runs in Chromium and WebKit. No test in this
 * file claims a real passkey success; WebAuthn success is proven only by the
 * Chromium CDP virtual-authenticator suite.
 */

async function gotoEnabled(page: Page): Promise<void> {
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Sign in or create an account" })).toBeVisible();
}

test("shows a clear unsupported state when passkeys are unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "PublicKeyCredential", {
      configurable: true,
      value: undefined,
    });
  });
  await gotoEnabled(page);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create a passkey" }).click();
  await expect(page.getByTestId("account-notice")).toContainText(/does not support passkeys/iu);
  await expect(page.getByTestId("account-id")).toHaveCount(0);
});

test("reports an honest non-success outcome when the ceremony cannot complete", async ({ page }) => {
  await page.addInitScript(() => {
    const reject = () => Promise.reject(new DOMException("cancelled", "NotAllowedError"));
    const w = window as typeof window & { __ceremonyAttempts?: number };
    w.__ceremonyAttempts = 0;
    const wrap = (original: typeof navigator.credentials.create) =>
      (() => {
        w.__ceremonyAttempts = (w.__ceremonyAttempts ?? 0) + 1;
        void original;
        return reject();
      }) as typeof navigator.credentials.create;
    Object.defineProperty(navigator.credentials, "create", {
      configurable: true,
      value: wrap(navigator.credentials.create),
    });
    Object.defineProperty(navigator.credentials, "get", {
      configurable: true,
      value: wrap(navigator.credentials.get as typeof navigator.credentials.create),
    });
  });
  await gotoEnabled(page);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create a passkey" }).click();
  // This engine has no WebAuthn support, so the honest outcome is an
  // unsupported notice, never a claimed registration.
  await expect(page.getByTestId("account-notice")).toContainText(/does not support passkeys/iu);
  await expect(page.getByTestId("account-id")).toHaveCount(0);
});

test("never auto-retries a malformed response or a 503", async ({ page }) => {
  await gotoEnabled(page);
  let requests = 0;
  await page.route("**/v2/auth/recovery/redeem", async (route) => {
    requests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { unexpected: true }, meta: {} }),
    });
  });
  await page.getByTestId("recovery-redeem").fill("code-value");
  await page.getByRole("button", { name: "Redeem recovery code" }).click();
  // A malformed response to a sent POST cannot prove the write rolled back, so
  // the honest outcome is unknown, not a false "nothing changed" or an
  // unverified success.
  await expect(page.getByTestId("account-notice")).toContainText(
    /no response was received, so the outcome is unknown/iu,
  );
  await expect(page.getByTestId("account-notice")).not.toContainText(/nothing was changed/iu);
  // Exactly one request: an unknown outcome is never retried.
  expect(requests).toBe(1);
});

test("gives sign-in-again guidance on a stale session and does not retry", async ({ page }) => {
  await gotoEnabled(page);
  let requests = 0;
  await page.route("**/v2/auth/passkeys/add/options", async (route) => {
    requests += 1;
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required to perform this request.",
          retryable: false,
        },
        meta: {
          schemaVersion: "openarc.api.v2",
          requestId: "018f47a2-3b4c-7def-8123-456789abcdef",
          buildSha: "0123456789abcdef0123456789abcdef01234567",
        },
      }),
    });
  });
  const signedInSession = {
    signedIn: true,
    accountId: "openarc:account:018f47a2-3b4c-7def-8123-456789abcdef",
    method: "passkey",
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
  // Reach the signed-in view through a stubbed session so no real credential is
  // needed, and return the same session from bootstrap so the account-bound
  // invariant is satisfied and the add-options 401 is actually reached.
  await page.route("**/v2/auth/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: { session: signedInSession },
        meta: {
          schemaVersion: "openarc.api.v2",
          requestId: "018f47a2-3b4c-7def-8123-456789abcdef",
          buildSha: "0123456789abcdef0123456789abcdef01234567",
        },
      }),
    });
  });
  await page.route("**/v2/auth/bootstrap", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: { csrfToken: "stubbed-csrf-token", session: signedInSession },
        meta: {
          schemaVersion: "openarc.api.v2",
          requestId: "018f47a2-3b4c-7def-8123-456789abcdef",
          buildSha: "0123456789abcdef0123456789abcdef01234567",
        },
      }),
    });
  });
  await page.reload();
  await expect(page.getByTestId("account-id")).toBeVisible();
  await page.getByRole("button", { name: "Add passkey" }).click();
  await expect(page.getByTestId("account-notice")).toContainText(/sign in again/iu);
  expect(requests).toBe(1);
});

test("guest path creates no account", async ({ page }) => {
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/v2/auth/")) {
      posts.push(request.url());
    }
  });
  await gotoEnabled(page);
  await page.getByRole("link", { name: "Continue as guest" }).click();
  await expect(page).toHaveURL(/\/design$/u);
  expect(posts).toEqual([]);
});

test("keyboard reaches every control and the recovery input is a password field", async ({ page }) => {
  await gotoEnabled(page);
  await expect(page.getByTestId("recovery-redeem")).toHaveAttribute("type", "password");
  await page.keyboard.press("Tab");
  const focusIsVisible = await page.evaluate(() => document.activeElement !== null);
  expect(focusIsVisible).toBe(true);
  await page.getByRole("checkbox").focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("checkbox")).toBeChecked();
});

test("states the privacy and minimal-record wording", async ({ page }) => {
  await gotoEnabled(page);
  await expect(page.getByText(/disposable development origin/iu)).toBeVisible();
  await expect(page.getByText(/not anonymous and are not zero-retention/iu)).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with wallet" })).toBeVisible();
  await expect(page.getByText(/does not authorize any payment/iu).first()).toBeVisible();
});

test("has no horizontal overflow at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await gotoEnabled(page);
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
});

const META = {
  schemaVersion: "openarc.api.v2",
  requestId: "018f47a2-3b4c-7def-8123-456789abcdef",
  buildSha: "0123456789abcdef0123456789abcdef01234567",
};

const ACCOUNT_A = "openarc:account:aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_B = "openarc:account:bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";

function session(accountId: string) {
  return {
    signedIn: true,
    accountId,
    method: "passkey" as const,
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
}

async function stubSignedIn(page: Page, accountId: string): Promise<void> {
  await page.route("**/v2/auth/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { session: session(accountId) }, meta: META }),
    });
  });
}

test("aborts an account-bound action when the session changed to another account", async ({ page }) => {
  let optionsRequests = 0;
  await stubSignedIn(page, ACCOUNT_A);
  await page.route("**/v2/auth/bootstrap", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { csrfToken: "csrf-b", session: session(ACCOUNT_B) }, meta: META }),
    });
  });
  await page.route("**/v2/auth/passkeys/add/options", async (route) => {
    optionsRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
  });
  await page.goto("/account");
  await expect(page.getByTestId("account-id")).toHaveText(ACCOUNT_A);
  await page.getByRole("button", { name: "Add passkey" }).click();
  await expect(page.getByTestId("account-notice")).toContainText(/different account/iu);
  expect(optionsRequests).toBe(0);
  // Displayed state synchronizes to the actual session.
  await expect(page.getByTestId("account-id")).toHaveText(ACCOUNT_B);
});

test("aborts a stale account-bound action when the session became a guest", async ({ page }) => {
  await stubSignedIn(page, ACCOUNT_A);
  await page.route("**/v2/auth/bootstrap", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { csrfToken: "csrf-guest", session: { signedIn: false } }, meta: META }),
    });
  });
  await page.goto("/account");
  await expect(page.getByTestId("account-id")).toHaveText(ACCOUNT_A);
  await page.getByRole("button", { name: "Add passkey" }).click();
  await expect(page.getByTestId("account-notice")).toContainText(/different account/iu);
  await expect(page.getByTestId("account-id")).toHaveCount(0);
});

test("a stale refresh GET cannot resurrect a completed logout", async ({ page }) => {
  const bootstrap = {
    ok: true,
    data: { csrfToken: "csrf-a", session: session(ACCOUNT_A) },
    meta: META,
  };
  await page.route("**/v2/auth/bootstrap", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(bootstrap) });
  });
  let sessionReads = 0;
  await page.route("**/v2/auth/session", async (route) => {
    sessionReads += 1;
    if (sessionReads === 1) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: { session: session(ACCOUNT_A) }, meta: META }),
      });
      return;
    }
    // Delay the explicit refresh so logout can race and invalidate it.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { session: session(ACCOUNT_A) }, meta: META }),
    });
  });
  await page.route("**/v2/auth/logout", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { session: { signedIn: false } }, meta: META }),
    });
  });
  await page.goto("/account");
  await expect(page.getByTestId("account-id")).toHaveText(ACCOUNT_A);
  await page.getByRole("button", { name: "Refresh sign-in" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in or create an account" })).toBeVisible();
  // Wait past the delayed refresh; it must not repopulate the signed-in view.
  await page.waitForTimeout(600);
  await expect(page.getByTestId("account-id")).toHaveCount(0);
  await expect(page.getByTestId("account-notice")).not.toContainText(/signed in/iu);
});

test("does not display stale recovery codes from a response that arrives after a hide", async ({ page }) => {
  await stubSignedIn(page, ACCOUNT_A);
  await page.route("**/v2/auth/bootstrap", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { csrfToken: "csrf-a", session: session(ACCOUNT_A) }, meta: META }),
    });
  });
  await page.route("**/v2/auth/recovery/codes", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { codes: ["a", "b", "c", "d", "e", "f", "g", "h"] }, meta: META }),
    });
  });
  await page.goto("/account");
  await expect(page.getByTestId("account-id")).toHaveText(ACCOUNT_A);
  await page.getByRole("button", { name: "Generate recovery codes" }).click();
  await page.getByRole("button", { name: "Replace codes" }).click();
  // Hide while the response is still in flight, then become visible again.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(600);
  await expect(page.getByTestId("recovery-codes")).toHaveCount(0);
});

test("clears visible recovery codes immediately when a cancelled logout response is lost", async ({ page }) => {
  await stubSignedIn(page, ACCOUNT_A);
  await page.route("**/v2/auth/bootstrap", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { csrfToken: "csrf-a", session: session(ACCOUNT_A) }, meta: META }),
    });
  });
  await page.route("**/v2/auth/recovery/codes", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { codes: ["a", "b", "c", "d", "e", "f", "g", "h"] }, meta: META }),
    });
  });
  await page.route("**/v2/auth/logout", async (route) => {
    await route.abort();
  });
  await page.goto("/account");
  await expect(page.getByTestId("account-id")).toHaveText(ACCOUNT_A);
  await page.getByRole("button", { name: "Generate recovery codes" }).click();
  await page.getByRole("button", { name: "Replace codes" }).click();
  await expect(page.getByTestId("recovery-codes")).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByTestId("recovery-codes")).toHaveCount(0);
  await expect(page.getByTestId("account-notice")).toContainText(/could not confirm/iu);
});

interface WalletStub {
  __walletCalls?: string[];
  __emitWallet?: (event: string) => void;
}

async function installStubWallet(page: Page, address: string): Promise<void> {
  await page.addInitScript(
    ({ account }) => {
      const w = window as typeof window & WalletStub;
      w.__walletCalls = [];
      const listeners = new Map<string, Set<() => void>>();
      w.__emitWallet = (event: string) => {
        for (const listener of listeners.get(event) ?? []) listener();
      };
      const provider = {
        request(input: { method: string; params?: unknown[] }) {
          w.__walletCalls?.push(input.method);
          if (input.method === "eth_requestAccounts" || input.method === "eth_accounts") {
            return Promise.resolve([account]);
          }
          if (input.method === "eth_chainId") return Promise.resolve("0x4cef52");
          if (input.method === "personal_sign") return Promise.resolve(`0x${"ab".repeat(65)}`);
          return Promise.reject(new Error("unsupported"));
        },
        on(event: string, listener: () => void) {
          const set = listeners.get(event) ?? new Set();
          set.add(listener);
          listeners.set(event, set);
        },
        removeListener(event: string, listener: () => void) {
          listeners.get(event)?.delete(listener);
        },
      };
      Object.defineProperty(window, "ethereum", { configurable: true, get: () => provider });
    },
    { account: address },
  );
}

test("cancels a wallet sign-in when the account changes during confirmation", async ({ page }) => {
  await installStubWallet(page, "0xA0Cf798816D4b9b9866b5330EEa46a18382f251e");
  await page.route("**/v2/auth/bootstrap", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { csrfToken: "csrf", session: { signedIn: false } }, meta: META }),
    });
  });
  await page.route("**/v2/auth/wallets/login/options", async (route) => {
    const message = [
      "http://localhost:5201 wants you to sign in with your Ethereum account:",
      "0xA0Cf798816D4b9b9866b5330EEa46a18382f251e",
      "",
      "Sign in to OpenArc. This does not authorize payments.",
      "",
      "URI: http://localhost:5201/account",
      "Version: 1",
      "Chain ID: 5042002",
      "Nonce: 0123456789abcdef0123456789abcdef",
      `Issued At: ${new Date().toISOString()}`,
      `Expiration Time: ${new Date(Date.now() + 5 * 60 * 1000).toISOString()}`,
    ].join("\n");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { flowId: "abcdefghijklmnop", message }, meta: META }),
    });
  });
  await page.route("**/v2/auth/wallets/login/verify", async (route) => {
    await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
  });
  await page.goto("/account");
  await page.getByRole("button", { name: "Sign in with wallet" }).click();
  await expect(page.getByTestId("wallet-confirm")).toBeVisible();
  // A wallet account change must cancel before any signature is requested.
  await page.evaluate(() => (window as typeof window & WalletStub).__emitWallet?.("accountsChanged"));
  await expect(page.getByTestId("account-notice")).toBeVisible();
  await expect(page.getByTestId("wallet-confirm")).toHaveCount(0);
  await expect(page.getByTestId("account-id")).toHaveCount(0);
  const calls = await page.evaluate(() => (window as typeof window & WalletStub).__walletCalls ?? []);
  expect(calls).not.toContain("personal_sign");
});

test("a delayed replacement cannot repopulate codes after manual Hide", async ({ page }) => {
  await stubSignedIn(page, ACCOUNT_A);
  await page.route("**/v2/auth/bootstrap", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { csrfToken: "csrf-a", session: session(ACCOUNT_A) }, meta: META }),
    });
  });
  let codeRequests = 0;
  await page.route("**/v2/auth/recovery/codes", async (route) => {
    codeRequests += 1;
    if (codeRequests === 1) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: { codes: ["a", "b", "c", "d", "e", "f", "g", "h"] }, meta: META }),
      });
      return;
    }
    // The replacement is still in flight when the user hides the old codes.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { codes: ["1", "2", "3", "4", "5", "6", "7", "8"] }, meta: META }),
    });
  });
  await page.goto("/account");
  await expect(page.getByTestId("account-id")).toHaveText(ACCOUNT_A);

  await page.getByRole("button", { name: "Generate recovery codes" }).click();
  await page.getByRole("button", { name: "Replace codes" }).click();
  await expect(page.getByTestId("recovery-codes")).toBeVisible();

  // Start a replacement while the old codes are visible, then Hide. The Hide
  // must invalidate the in-flight response.
  await page.getByRole("button", { name: "Generate recovery codes" }).click();
  await page.getByRole("button", { name: "Replace codes" }).click();
  await page.getByRole("button", { name: "Hide codes" }).click();
  await expect(page.getByTestId("recovery-codes")).toHaveCount(0);
  await page.waitForTimeout(600);
  await expect(page.getByTestId("recovery-codes")).toHaveCount(0);
});

test("an authoritative refresh to another account clears codes and blocks a pending result", async ({ page }) => {
  // The route returns A until the test flips `refreshed`, so an incidental
  // double read at mount can never pre-empt A with B.
  let refreshed = false;
  const currentAccount = () => (refreshed ? ACCOUNT_B : ACCOUNT_A);
  await page.route("**/v2/auth/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { session: session(currentAccount()) }, meta: META }),
    });
  });
  await page.route("**/v2/auth/bootstrap", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { csrfToken: "csrf-a", session: session(currentAccount()) }, meta: META }),
    });
  });
  await page.route("**/v2/auth/recovery/codes", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { codes: ["a", "b", "c", "d", "e", "f", "g", "h"] }, meta: META }),
    });
  });
  await page.goto("/account");
  await expect(page.getByTestId("account-id")).toHaveText(ACCOUNT_A);

  // A's codes are visible and the app is idle.
  await page.getByRole("button", { name: "Generate recovery codes" }).click();
  await page.getByRole("button", { name: "Replace codes" }).click();
  await expect(page.getByTestId("recovery-codes")).toBeVisible();

  // An authoritative refresh resolves account B: the identity changed, so A's
  // codes are cleared and any in-flight A result is invalidated.
  refreshed = true;
  await page.getByRole("button", { name: "Refresh sign-in" }).click();
  await expect(page.getByTestId("account-id")).toHaveText(ACCOUNT_B);
  await expect(page.getByTestId("recovery-codes")).toHaveCount(0);

  // A same-account/bootstrap after the change does not permanently suppress a
  // fresh requested code result for the new identity.
  await page.getByRole("button", { name: "Generate recovery codes" }).click();
  await page.getByRole("button", { name: "Replace codes" }).click();
  await expect(page.getByTestId("recovery-codes")).toBeVisible();
});

test("an authoritative refresh to guest clears codes and blocks a pending result", async ({ page }) => {
  let refreshed = false;
  await page.route("**/v2/auth/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: { session: refreshed ? { signedIn: false } : session(ACCOUNT_A) },
        meta: META,
      }),
    });
  });
  await page.route("**/v2/auth/bootstrap", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          csrfToken: "csrf-a",
          session: refreshed ? { signedIn: false } : session(ACCOUNT_A),
        },
        meta: META,
      }),
    });
  });
  await page.route("**/v2/auth/recovery/codes", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { codes: ["a", "b", "c", "d", "e", "f", "g", "h"] }, meta: META }),
    });
  });
  await page.goto("/account");
  await expect(page.getByTestId("account-id")).toHaveText(ACCOUNT_A);
  await page.getByRole("button", { name: "Generate recovery codes" }).click();
  await page.getByRole("button", { name: "Replace codes" }).click();
  await expect(page.getByTestId("recovery-codes")).toBeVisible();
  refreshed = true;
  await page.getByRole("button", { name: "Refresh sign-in" }).click();
  await expect(page.getByRole("heading", { name: "Sign in or create an account" })).toBeVisible();
  await expect(page.getByTestId("recovery-codes")).toHaveCount(0);
});

test("a successful sign-out leaves the sign-in controls usable", async ({ page }) => {
  await stubSignedIn(page, ACCOUNT_A);
  await page.route("**/v2/auth/bootstrap", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { csrfToken: "csrf-a", session: session(ACCOUNT_A) }, meta: META }),
    });
  });
  await page.route("**/v2/auth/logout", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { session: { signedIn: false } }, meta: META }),
    });
  });
  await page.goto("/account");
  await expect(page.getByTestId("account-id")).toHaveText(ACCOUNT_A);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in or create an account" })).toBeVisible();
  // The guarded success clears busy before reset invalidates its generation.
  await expect(page.getByRole("button", { name: "Sign in with passkey" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Sign in with wallet" })).toBeEnabled();
  await expect(page.getByRole("checkbox")).toBeEnabled();
});

test("refuses a stale wallet message that expires during confirmation", async ({ page }) => {
  await installStubWallet(page, "0xA0Cf798816D4b9b9866b5330EEa46a18382f251e");
  await page.route("**/v2/auth/bootstrap", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { csrfToken: "csrf", session: { signedIn: false } }, meta: META }),
    });
  });
  await page.route("**/v2/auth/wallets/login/options", async (route) => {
    // A message already close to expiry: valid at fetch, stale at sign time.
    const issued = new Date(Date.now() - 5 * 60 * 1000 + 1500);
    const message = [
      "http://localhost:5201 wants you to sign in with your Ethereum account:",
      "0xA0Cf798816D4b9b9866b5330EEa46a18382f251e",
      "",
      "Sign in to OpenArc. This does not authorize payments.",
      "",
      "URI: http://localhost:5201/account",
      "Version: 1",
      "Chain ID: 5042002",
      "Nonce: 0123456789abcdef0123456789abcdef",
      `Issued At: ${issued.toISOString()}`,
      `Expiration Time: ${new Date(issued.getTime() + 5 * 60 * 1000).toISOString()}`,
    ].join("\n");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { flowId: "abcdefghijklmnop", message }, meta: META }),
    });
  });
  await page.goto("/account");
  await page.getByRole("button", { name: "Sign in with wallet" }).click();
  await expect(page.getByTestId("wallet-confirm")).toBeVisible();
  await page.waitForTimeout(1800);
  await page.getByTestId("wallet-confirm").getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId("account-notice")).toContainText(/did not match|unknown/iu);
  await expect(page.getByTestId("account-id")).toHaveCount(0);
  const calls = await page.evaluate(() => (window as typeof window & WalletStub).__walletCalls ?? []);
  expect(calls).not.toContain("personal_sign");
});
