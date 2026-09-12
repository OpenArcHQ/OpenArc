import { expect, test, type CDPSession, type Page, type Response } from "@playwright/test";

/**
 * Production acceptance for the account slice against the real nginx image.
 *
 * Runs on the lead-provisioned disposable loopback origin only. No auth route
 * or server is injected: the CDP virtual authenticator creates a genuine
 * resident credential that the real SimpleWebAuthn server verifies and the
 * real restricted PostgreSQL store persists. CSP, cookie and storage privacy
 * are observed from the actual production responses, never logged verbatim.
 */

test.describe.configure({ mode: "serial" });

interface VirtualAuthenticator {
  client: CDPSession;
  id: string;
}

async function addVirtualAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { client, id: authenticatorId };
}

async function removeAuthenticator(authenticator: VirtualAuthenticator): Promise<void> {
  await authenticator.client.send("WebAuthn.removeVirtualAuthenticator", {
    authenticatorId: authenticator.id,
  });
}

interface ViolationSink {
  __cspViolations?: string[];
}

/**
 * Records only the effectiveDirective of each CSP violation from before the
 * first navigation. Document bodies, tokens and blocked URIs are never kept.
 */
async function collectCspViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as typeof window & ViolationSink;
    w.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      w.__cspViolations?.push(event.effectiveDirective);
    });
  });
}

async function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as typeof window & ViolationSink).__cspViolations ?? [],
  );
}

function directives(header: string | null): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const part of (header ?? "").split(";")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const [name, ...values] = trimmed.split(/\s+/u);
    if (name !== undefined) result.set(name.toLowerCase(), values);
  }
  return result;
}

async function gotoAccount(page: Page): Promise<Response> {
  const response = await page.goto("/account");
  expect(response).not.toBeNull();
  await expect(page.getByRole("heading", { name: "Sign in or create an account" })).toBeVisible();
  return response as Response;
}

test("serves a strict self-only CSP with no violations during render and registration", async ({
  page,
}) => {
  await collectCspViolations(page);
  const response = await gotoAccount(page);

  const csp = response.headers()["content-security-policy"] ?? null;
  expect(csp).not.toBeNull();
  const parsed = directives(csp);
  expect(parsed.get("script-src") ?? []).toContain("'self'");
  expect(parsed.get("style-src") ?? []).toContain("'self'");
  expect(csp).not.toContain("'unsafe-inline'");
  expect(csp).not.toContain("'unsafe-eval'");

  // Registration executes under the same strict policy.
  const authenticator = await addVirtualAuthenticator(page);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create a passkey" }).click();
  await expect(page.getByTestId("account-id")).toBeVisible();
  expect(await cspViolations(page)).toEqual([]);
  await removeAuthenticator(authenticator);
});

test("loads same-origin CSS and renders the styled account screen on production", async ({
  page,
}) => {
  const stylesheets: string[] = [];
  page.on("response", (response) => {
    const type = response.request().resourceType();
    if (type === "stylesheet") stylesheets.push(response.url());
  });

  await gotoAccount(page);
  await expect(page.locator(".account-shell")).toBeVisible();

  const origin = new URL(page.url()).origin;
  expect(stylesheets.length).toBeGreaterThan(0);
  for (const href of stylesheets) expect(href.startsWith(origin)).toBe(true);

  // account.css is proven applied by a stable computed property on the shell
  // (declared display:flex) rather than a brittle full-CSS hash.
  const display = await page
    .locator(".account-shell")
    .evaluate((element) => getComputedStyle(element).display);
  expect(display).toBe("flex");
  const titleSize = await page
    .locator(".account-title")
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(titleSize).toBeGreaterThan(20);
});

test("uses a hardened __Host- session cookie without exposing it to the page", async ({
  page,
  context,
}) => {
  await gotoAccount(page);
  const authenticator = await addVirtualAuthenticator(page);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create a passkey" }).click();
  await expect(page.getByTestId("account-id")).toBeVisible();

  const origin = new URL(page.url()).origin;
  const cookies = (await context.cookies(origin)).filter((cookie) =>
    cookie.name.includes("session"),
  );
  expect(cookies.length).toBeGreaterThan(0);
  const session = cookies[0];
  expect(session).toBeDefined();
  if (session === undefined) throw new Error("session cookie missing");
  expect(session.name.startsWith("__Host-")).toBe(true);
  expect(session.httpOnly).toBe(true);
  expect(session.secure).toBe(true);
  expect(session.path).toBe("/");
  expect(session.sameSite).toBe("Lax");
  expect(session.domain.startsWith(".")).toBe(false);

  // The HttpOnly cookie is never readable from page script.
  const readable = await page.evaluate(() => document.cookie);
  expect(readable).not.toContain("__Host-");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in or create an account" })).toBeVisible();
  await removeAuthenticator(authenticator);
});

test("keeps session material out of browser storage and the URL", async ({ page }) => {
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

  await gotoAccount(page);
  const authenticator = await addVirtualAuthenticator(page);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create a passkey" }).click();
  await expect(page.getByTestId("account-id")).toBeVisible();

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
  for (const blob of [state.local, state.session, state.href]) {
    expect(blob).not.toMatch(/__Host-/u);
    expect(blob).not.toMatch(/openarc_session/u);
    expect(blob).not.toMatch(/csrf/iu);
    expect(blob).not.toMatch(/private.?key/iu);
  }

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in or create an account" })).toBeVisible();
  await removeAuthenticator(authenticator);
});

test("logout leaves the signed-out form usable on production", async ({ page }) => {
  await gotoAccount(page);
  const authenticator = await addVirtualAuthenticator(page);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create a passkey" }).click();
  await expect(page.getByTestId("account-id")).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in or create an account" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with passkey" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Sign in with wallet" })).toBeEnabled();
  await expect(page.getByRole("checkbox")).toBeEnabled();
  await expect(page.getByTestId("recovery-redeem")).toBeVisible();
  // The walled-off signed-in view is gone.
  await expect(page.getByTestId("account-id")).toHaveCount(0);
  await removeAuthenticator(authenticator);
});
