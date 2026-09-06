/**
 * The assembly test.
 *
 * Every assertion here is about the pieces being *connected*, not about what
 * each does — the unit and component suites own that, run in seconds, and give
 * far better failure messages. What they cannot see is a bundle that never
 * loads, a socket that never opens, or a command that reaches the browser and
 * stops there.
 *
 * Keep it small. An end-to-end suite that grows into a behaviour suite becomes
 * the slowest and flakiest way to learn things that were already known.
 */
import { expect, test } from '@playwright/test';

test('the panel loads from the server and shows what is playing', async ({ page }) => {
  await page.goto('/');

  // Straight from the socket: the server polled the fake, normalised it,
  // broadcast it, and the browser rendered it. Every seam in one assertion.
  await expect(page.getByText('Velocity Division')).toBeVisible();
  await expect(page.getByText('Nitrous Cartel')).toBeVisible();
  await expect(page.getByText('Kitchen').first()).toBeVisible();
});

test('the panel is exactly the device, and nothing scrolls it', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Velocity Division')).toBeVisible();

  // A layout that overflows is broken, not inconvenient (D-039).
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }));

  expect(overflow.x).toBeLessThanOrEqual(0);
  expect(overflow.y).toBeLessThanOrEqual(0);
});

test('a transport tap reaches Spotify and comes back on the socket', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Velocity Division')).toBeVisible();

  await page.getByRole('button', { name: /pause/i }).click();

  // The optimistic layer means this must be true almost immediately — if it
  // took a full poll, the routes would be talking to Spotify directly (D-055).
  await expect(page.getByRole('button', { name: /play/i })).toBeVisible({
    timeout: 1_000,
  });
});

test('the plate grows to hold the devices, and a restricted device shows no slider', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Kitchen' }).click();

  await expect(page.getByText('Study')).toBeVisible();
  await expect(page.getByText('Living Room TV')).toBeVisible();

  // A device reporting no volume gets no slider at all — drawing one at 0
  // would be a confident lie (D-022, D-047).
  //
  // Asserted in both directions on purpose. "The TV has no slider" alone
  // passes just as happily when the selector matches nothing at all, which is
  // how a test ends up proving nothing; pairing it with a device that *does*
  // have one makes the selector prove itself.
  const rows = page.locator('li');
  await expect(
    rows.filter({ hasText: 'Kitchen' }).locator('input[type="range"]'),
  ).toHaveCount(1);
  await expect(
    rows.filter({ hasText: 'Living Room TV' }).locator('input[type="range"]'),
  ).toHaveCount(0);
});

test('the queue is reachable and every row is inert', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Queue' }).click();

  await expect(page.getByText('Coolant')).toBeVisible();

  // Spotify has no reorder, no remove and no jump (D-007, D-051). The only
  // control on this surface is the one that closes it.
  const buttons = await page.locator('section button').allTextContents();
  expect(buttons).toEqual(['Done']);
});

test('search opens and shows the library for an empty query', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Search' }).click();

  // Empty shows the library, not a blank screen (D-031). The fake serves an
  // empty one, so what is asserted is that the surface asked and rendered —
  // not that it found anything.
  await expect(page.getByRole('button', { name: 'Done' })).toBeVisible();
});

test('the API keeps an honest 404 while a stray path shows the panel', async ({
  page,
  request,
}) => {
  const api = await request.get('/api/nonsense');
  expect(api.status()).toBe(404);
  expect(api.headers()['content-type']).toContain('json');

  // A 404 nobody can read from across a room is worse than the app (D-058).
  await page.goto('/devices');
  await expect(page.getByText('Velocity Division')).toBeVisible();
});
