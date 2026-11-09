import { test, expect } from "@playwright/test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ccc } from "@ckb-ccc/connector-react";

// Wallet mode: the host wallet is already signed in, so the create screen is
// the prototype's form — recipient, amount, period — with no key or connect steps.
test("wallet mode drops the key and connect steps", async ({ page }) => {
  await page.goto("/?mode=wallet");

  await expect(page.getByRole("heading", { name: "Create recovery policy" })).toBeVisible();
  await expect(page.locator(".key-card")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Connect wallet", exact: true })).toHaveCount(0);

  await expect(page.getByLabel("Enter recipient address")).toBeVisible();
  await expect(page.getByLabel("Amount to protect (CKB)")).toBeVisible();
  await expect(page.getByLabel("Inactivity period (epochs)")).toBeVisible();

  // The signed-in account owns the policy, so deploy stays blocked only on the recipient.
  await expect(page.getByText("Needs a recovery recipient address first.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Deploy policy → ACTIVE", exact: true })).toBeDisabled();
});

test("an injected host supplies the signed-in account", async ({ page }) => {
  const privateKey = ccc.hexFrom(secp256k1.utils.randomSecretKey());
  await page.addInitScript(
    `window.__TRANFR_HOST__ = { name: "Acme Wallet", privateKey: ${JSON.stringify(privateKey)} };`,
  );
  await page.goto("/");

  // No ?mode=wallet needed: the host's presence turns wallet mode on.
  await expect(page.locator(".key-card")).toHaveCount(0);
  await expect(page.getByText("Acme Wallet")).toBeVisible();
  await expect(page.getByText("No wallet host detected")).toHaveCount(0);

  const address = await new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet(), privateKey)
    .getRecommendedAddress();
  await expect(page.locator(".wallet-row .mono")).toHaveText(address, { timeout: 30_000 });
});
