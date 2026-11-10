import { expect } from "e2e";
import { test } from "@e2e-dev/web";

// CI reruns these journeys against the audited baseline view (1a53cb8) with E2E_BASELINE=1.
// Each journey marks the expected failure only after its actions and the reply barrier
// succeed, so a broken harness or a missing control still fails the baseline run.
const baseline = process.env.E2E_BASELINE === "1";

const replies = "Resolve pending replies";

test("Back to day ignores a late activity reply", async ({ app, browser, screen }) => {
  await app.open("/e2e/host.html");
  const view = browser.frameLocator("iframe");
  const calls = browser.locator("#calls li");
  const context = browser.locator("#context li");

  await view.getByRole("button", { name: "Open activity 20261020 →" }).tap();
  await expect(calls).toHaveText(["get_garmin_activity 20261020"]);
  await view.getByRole("button", { name: "← Back to day" }).tap();
  await expect(view.getByRole("heading", { level: 1 })).toContainText("October 20");
  await screen.getByRole("button", { name: replies }).tap();
  await expect(browser.locator("#settled")).toHaveText("1");

  test.fail(baseline, "R1: the late activity reply reopens the activity and shares its context");
  await expect(context).toHaveCount(0);
  await expect(view.getByRole("heading", { level: 1 })).toContainText("October 20");
  await expect(view.getByRole("button", { name: "Open activity 20261020 →" })).toBeVisible();
});

test("day paging requests consecutive dates while replies are pending", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/e2e/host.html");
  const view = browser.frameLocator("iframe");
  const calls = browser.locator("#calls li");

  await expect(view.getByRole("heading", { level: 1 })).toContainText("October 20");
  await view.getByRole("button", { name: "Previous day" }).tap();
  await expect(calls).toHaveCount(1);
  await view.getByRole("button", { name: "Previous day" }).tap();
  await expect(calls).toHaveCount(2);
  await screen.getByRole("button", { name: replies }).tap();
  await expect(browser.locator("#settled")).toHaveText("2");

  test.fail(baseline, "R2: a loading day pages from the original tool date");
  await expect(calls).toHaveText(["get_garmin_day 2026-10-19", "get_garmin_day 2026-10-18"]);
  await expect(view.getByRole("heading", { level: 1 })).toContainText("October 18");
  await expect(view.getByRole("button", { name: "Open activity 20261018 →" })).toBeVisible();
  await expect(browser.locator("#context li").last()).toContainText("2026-10-18");
});

test("only the latest day request controls the screen and model context", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/e2e/host.html");
  const view = browser.frameLocator("iframe");
  const calls = browser.locator("#calls li");

  await expect(view.getByRole("heading", { level: 1 })).toContainText("October 20");
  await view.getByRole("button", { name: "Previous day" }).tap();
  await expect(calls).toHaveCount(1);
  await view.getByRole("button", { name: "Next day" }).tap();
  await expect(calls).toHaveCount(2);
  // The fixture answers the newest request first; the older reply is then stale.
  await screen.getByRole("button", { name: replies }).tap();
  await expect(browser.locator("#settled")).toHaveText("2");
  // Whichever date the view chose last, independent of how it computed that date.
  const latest = (await calls.last().textContent())?.split(" ").at(-1) ?? "";

  expect(latest).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  test.fail(baseline, "R2: the older reply overwrites the latest selection");
  await expect(
    view.getByRole("button", { name: `Open activity ${latest.replaceAll("-", "")} →` }),
  ).toBeVisible();
  await expect(browser.locator("#context li")).toHaveCount(1);
  await expect(browser.locator("#context li")).toContainText([latest]);
});

test("paging after a failed day request keeps the selected date", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/e2e/host.html?fail=2026-10-19");
  const view = browser.frameLocator("iframe");
  const calls = browser.locator("#calls li");

  await expect(view.getByRole("heading", { level: 1 })).toContainText("October 20");
  await view.getByRole("button", { name: "Previous day" }).tap();
  await expect(calls).toHaveCount(1);
  await screen.getByRole("button", { name: replies }).tap();
  await expect(browser.locator("#settled")).toHaveText("1");
  await expect(view.getByRole("alert")).toHaveText("Garmin day unavailable.");
  await view.getByRole("button", { name: "Previous day" }).tap();
  await expect(calls).toHaveCount(2);
  await screen.getByRole("button", { name: replies }).tap();
  await expect(browser.locator("#settled")).toHaveText("2");

  test.fail(baseline, "R2: an errored day pages from the original tool date");
  await expect(calls).toHaveText(["get_garmin_day 2026-10-19", "get_garmin_day 2026-10-18"]);
  await expect(view.getByRole("heading", { level: 1 })).toContainText("October 18");
  await expect(view.getByRole("button", { name: "Open activity 20261018 →" })).toBeVisible();
});
