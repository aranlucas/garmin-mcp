import { expect } from "e2e";
import { test } from "@e2e-dev/web";

test("Back to day survives a late activity reply", async ({ app, browser, screen }) => {
  test.fail(process.env.E2E_BASELINE === "1", "Known baseline navigation defect");
  await app.open("/e2e/host.html");
  const view = browser.frameLocator("iframe");
  await expect(browser.locator("#settled")).toHaveText("1");
  await view.getByRole("button", { name: "Open activity 123 →" }).tap();
  await view.getByRole("button", { name: "← Back to day" }).tap();
  await screen.getByRole("button", { name: "Resolve pending replies" }).tap();
  await expect(browser.locator("#settled")).toHaveText("2");
  await expect(browser.locator("#context")).toHaveText("");
  await expect(view.getByRole("heading", { level: 1 })).toContainText("October 20");
  await expect(view.getByRole("button", { name: "Open activity 123 →" })).toBeVisible();
});

test("day paging retains selected dates and ignores older replies", async ({
  app,
  browser,
  screen,
}) => {
  test.fail(process.env.E2E_BASELINE === "1", "Known baseline navigation defect");
  await app.open("/e2e/host.html");
  const view = browser.frameLocator("iframe");
  await view.getByRole("button", { name: "Previous day" }).tap();
  await expect(view.getByRole("heading", { level: 1 })).toContainText("October 19");
  await view.getByRole("button", { name: "Previous day" }).tap();
  await expect(browser.locator("#calls")).toContainText('"date":"2026-10-18"');
  await screen.getByRole("button", { name: "Resolve pending replies" }).tap();
  await expect(browser.locator("#settled")).toHaveText("3");
  await expect(view.getByRole("heading", { level: 1 })).toContainText("October 18");
  await expect(view.getByRole("button", { name: "Open activity 123 →" })).toBeVisible();
});

test("the latest selection survives responses delivered in reverse order", async ({
  app,
  browser,
  screen,
}) => {
  test.fail(process.env.E2E_BASELINE === "1", "Known baseline navigation defect");
  await app.open("/e2e/host.html");
  const view = browser.frameLocator("iframe");
  await view.getByRole("button", { name: "Previous day" }).tap();
  await view.getByRole("button", { name: "Next day" }).tap();
  await expect(browser.locator("#calls")).toContainText("get_garmin_day");
  await screen.getByRole("button", { name: "Resolve pending replies" }).tap();
  await expect(browser.locator("#settled")).toHaveText("3");
  await expect(view.getByRole("heading", { level: 1 })).toContainText("October 20");
  await expect(browser.locator("#context")).toContainText("2026-10-20");
});
