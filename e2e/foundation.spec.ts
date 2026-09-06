import { expect, test } from "@playwright/test";

test("renders the Testnet-only M00 foundation with an exact build marker", async ({ page, baseURL }) => {
  const appOrigin = new URL(baseURL ?? "").origin;
  const externalRequests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== appOrigin) externalRequests.push(request.url());
  });

  await page.goto("/");

  await expect(page).toHaveTitle(/OpenArc/u);
  await expect(page.getByRole("heading", { name: "See the full arc of every agent action." })).toBeVisible();
  const network = page.locator("#network");
  await expect(network.getByText("Arc Testnet, exactly.")).toBeVisible();
  await expect(network.getByText("eip155:5042002", { exact: true })).toBeVisible();
  await expect(page.getByTestId("build-sha")).toHaveText("BUILD e2e-foundation");
  await expect
    .poll(() => page.locator('meta[name="openarc-build-sha"]').getAttribute("content"))
    .toBe("e2e-foundation");
  expect(externalRequests).toEqual([]);
});
