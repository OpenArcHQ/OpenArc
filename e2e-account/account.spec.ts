import { expect, test, type CDPSession, type Page } from "@playwright/test";

/**
 * Real browser-crypto acceptance for the account slice.
 *
 * A Chromium CDP virtual authenticator creates a genuine user-verified resident
 * credential that the real SimpleWebAuthn server verifies and the real
 * PostgreSQL store persists. Nothing in the crypto path is mocked.
 */

test.describe.configure({ mode: "serial" });

interface VirtualAuthenticator {
  client: CDPSession;
  id: string;
}

async function addVirtualAuthenticator(
  page: Page,
  transport: "internal" | "usb" = "internal",
): Promise<VirtualAuthenticator> {
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport,
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { client, id: authenticatorId };
}

async function setPresence(
  authenticator: VirtualAuthenticator,
  automatic: boolean,
): Promise<void> {
  await authenticator.client.send("WebAuthn.setAutomaticPresenceSimulation", {
    authenticatorId: authenticator.id,
    enabled: automatic,
  });
}

async function credentialsCount(authenticator: VirtualAuthenticator): Promise<number> {
  const result = await authenticator.client.send("WebAuthn.getCredentials", {
    authenticatorId: authenticator.id,
  });
  return result.credentials.length;
}

/**
 * Waits for a genuinely fresh passkey login. The account id may already be
 * visible from a recovery bootstrap, so the fresh-login notice (not the
 * unchanged id) is what establishes success.
 */
async function signInWithPasskey(page: Page, accountId: string): Promise<void> {
  await page.getByRole("button", { name: "Sign in with passkey" }).click();
  await expect(page.getByTestId("account-notice")).toContainText(/signed in with your passkey/iu);
  await expect(page.getByTestId("account-id")).toHaveText(accountId);
}

async function removeAuthenticator(authenticator: VirtualAuthenticator): Promise<void> {
  await authenticator.client.send("WebAuthn.removeVirtualAuthenticator", {
    authenticatorId: authenticator.id,
  });
}

function redeemInput(page: Page) {
  return page.getByTestId("recovery-redeem");
}

test("registers, persists, logs out, logs in, adds a key, redeems a code and recovers", async ({
  page,
}) => {
  const authenticator = await addVirtualAuthenticator(page);

  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Sign in or create an account" })).toBeVisible();

  // Register a real resident credential.
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create a passkey" }).click();
  await expect(page.getByTestId("account-id")).toBeVisible();
  const accountId = await page.getByTestId("account-id").textContent();
  expect(accountId).toMatch(/^openarc:account:/u);
  expect(await credentialsCount(authenticator)).toBe(1);

  // Reload reads the live server session; no re-registration.
  await page.reload();
  await expect(page.getByTestId("account-id")).toHaveText(accountId ?? "");
  expect(await credentialsCount(authenticator)).toBe(1);

  // Logout ends the server session and clears the view.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in or create an account" })).toBeVisible();

  // Real login with the same discoverable credential. Await the fresh-login
  // success, not the account id (which may already be visible).
  await signInWithPasskey(page, accountId ?? "");

  // Add a second passkey on a second authenticator (resident credentials are
  // unique per authenticator, so a distinct key requires a distinct device).
  // Keep exactly one authenticator registered per ceremony: the existing
  // device's credential count is asserted first, then it is removed so the
  // browser cannot select the excluded device.
  expect(await credentialsCount(authenticator)).toBe(1);
  await removeAuthenticator(authenticator);
  const secondAuthenticator = await addVirtualAuthenticator(page, "usb");
  await page.getByRole("button", { name: "Add passkey" }).click();
  await expect(page.getByTestId("account-notice")).toContainText("Passkey added");
  expect(await credentialsCount(secondAuthenticator)).toBe(1);

  // Generate a one-time recovery code set (shown only in memory).
  await page.getByRole("button", { name: "Generate recovery codes" }).click();
  await page.getByRole("button", { name: "Replace codes" }).click();
  await expect(page.getByTestId("recovery-codes")).toBeVisible();
  const codes = await page.getByTestId("recovery-codes").locator("code").allTextContents();
  expect(codes).toHaveLength(8);
  const firstCode = codes[0] ?? "";
  expect(firstCode.length).toBeGreaterThan(0);

  // Hide clears the display immediately.
  await page.getByRole("button", { name: "Hide codes" }).click();
  await expect(page.getByTestId("recovery-codes")).toHaveCount(0);

  // Logout, redeem a code, then confirm replay is denied.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in or create an account" })).toBeVisible();
  await redeemInput(page).fill(firstCode);
  await page.getByRole("button", { name: "Redeem recovery code" }).click();
  await expect(page.getByTestId("account-id")).toHaveText(accountId ?? "");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in or create an account" })).toBeVisible();
  await redeemInput(page).fill(firstCode);
  await page.getByRole("button", { name: "Redeem recovery code" }).click();
  await expect(page.getByTestId("account-notice")).toBeVisible();
  await expect(page.getByTestId("account-id")).toHaveCount(0);

  // Sign in with a passkey, generate a second code set, then use it.
  await signInWithPasskey(page, accountId ?? "");
  await page.getByRole("button", { name: "Generate recovery codes" }).click();
  await page.getByRole("button", { name: "Replace codes" }).click();
  await expect(page.getByTestId("recovery-codes")).toBeVisible();
  const secondSet = await page.getByTestId("recovery-codes").locator("code").allTextContents();
  expect(secondSet).toHaveLength(8);
  await page.getByRole("button", { name: "Hide codes" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in or create an account" })).toBeVisible();
  await redeemInput(page).fill(secondSet[0] ?? "");
  await page.getByRole("button", { name: "Redeem recovery code" }).click();
  await expect(page.getByTestId("account-id")).toHaveText(accountId ?? "");

  // A recovery session can add a replacement passkey, but the account's
  // existing resident credential is excluded, so a genuinely new third
  // authenticator is required. Preserve the current device's count, then
  // remove it so only the replacement is registered during the ceremony.
  expect(await credentialsCount(secondAuthenticator)).toBe(1);
  await removeAuthenticator(secondAuthenticator);
  const thirdAuthenticator = await addVirtualAuthenticator(page, "usb");
  await page.getByRole("button", { name: "Add passkey" }).click();
  await expect(page.getByTestId("account-notice")).toContainText("Passkey added");
  expect(await credentialsCount(thirdAuthenticator)).toBe(1);

  // The replacement passkey signs in after another logout.
  await page.getByRole("button", { name: "Sign out" }).click();
  await signInWithPasskey(page, accountId ?? "");
});

test("a cancelled real ceremony reports cancellation without success", async ({ page }) => {
  const authenticator = await addVirtualAuthenticator(page);
  await setPresence(authenticator, false);
  await page.goto("/account");
  const options = page.waitForResponse((response) =>
    response.url().includes("/v2/auth/passkeys/register/options"),
  );
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create a passkey" }).click();
  // Wait until the registration ceremony is actually pending, then remove the
  // authenticator while the browser is awaiting user presence, forcing a real
  // NotAllowed cancellation instead of racing the options round-trip.
  await options;
  await page.waitForTimeout(200);
  await authenticator.client.send("WebAuthn.removeVirtualAuthenticator", {
    authenticatorId: authenticator.id,
  });
  // This browser can leave a pending ceremony unresolved after its
  // authenticator disappears, so also exercise the real navigation abort the
  // page wires to WebAuthnAbortService. Either path must report cancellation.
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await expect(page.getByTestId("account-notice")).toContainText(/cancelled/iu);
  await expect(page.getByTestId("account-id")).toHaveCount(0);
});

test("keeps credentials and recovery codes out of storage, URL and logs", async ({ page }) => {
  const consoleLines: string[] = [];
  await page.addInitScript(() => {
    const w = window as typeof window & { __storageWrites?: string[] };
    w.__storageWrites = [];
    for (const store of [window.localStorage, window.sessionStorage]) {
      const setItem = store.setItem.bind(store);
      store.setItem = (key: string, value: string) => {
        w.__storageWrites?.push(key);
        setItem(key, value);
      };
    }
  });
  page.on("console", (message) => consoleLines.push(message.text()));

  const authenticator = await addVirtualAuthenticator(page);
  await page.goto("/account");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create a passkey" }).click();
  await expect(page.getByTestId("account-id")).toBeVisible();
  await page.getByRole("button", { name: "Generate recovery codes" }).click();
  // Generating replaces the existing set, so the real user flow confirms the
  // replacement before the panel can appear.
  await page.getByRole("button", { name: "Replace codes" }).click();
  await expect(page.getByTestId("recovery-codes")).toBeVisible();
  const codes = await page.getByTestId("recovery-codes").locator("code").allTextContents();
  expect(codes).toHaveLength(8);
  const joined = codes.join("|");

  const state = await page.evaluate(() => {
    const w = window as typeof window & { __storageWrites?: string[] };
    return {
      writes: w.__storageWrites ?? [],
      local: JSON.stringify(window.localStorage),
      session: JSON.stringify(window.sessionStorage),
      href: window.location.href,
    };
  });
  expect(state.writes).toEqual([]);
  expect(state.local).not.toContain(joined);
  expect(state.session).not.toContain(joined);
  expect(state.href).not.toContain(codes[0] ?? "___");

  // Hiding on visibility change clears the in-memory display.
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByTestId("recovery-codes")).toHaveCount(0);
  for (const line of consoleLines) expect(line).not.toContain(joined);
  expect(await credentialsCount(authenticator)).toBe(1);
});
