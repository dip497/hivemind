import { expect, type Locator } from "@playwright/test";

/** Picks a choice in the app's Select: opens the list from its trigger, clicks the option by name,
 *  and waits for the list to close. */
export async function pick(trigger: Locator, name: string | RegExp): Promise<void> {
  const page = trigger.page();
  await trigger.click();
  await page.getByRole("option", { name, exact: typeof name === "string" }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}
