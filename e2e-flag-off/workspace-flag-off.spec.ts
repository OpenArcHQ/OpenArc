import { expect, test } from "@playwright/test";

test("fails closed when the encrypted workspace build flag is absent", async ({ page }) => {
  const workspaceRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/(v1|rpc|graphql)(\/|\?|$)/u.test(new URL(request.url()).pathname)) {
      workspaceRequests.push(request.url());
    }
  });
  await page.goto("/workspace");
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("link", { name: "Open private workspace" })).toHaveCount(0);
  expect(workspaceRequests).toEqual([]);
});
