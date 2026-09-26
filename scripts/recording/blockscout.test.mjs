import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { installCursor, move, validateShots } from './blockscout.mjs';

test('rejects malformed or duplicate capture identities', () => {
  const shot = { id: 'purchase', hash: `0x${'ab'.repeat(32)}` };
  assert.equal(validateShots([shot])[0], shot);
  for (const input of [
    [],
    [shot, shot],
    [{ ...shot, id: '../out' }],
    [{ ...shot, hash: 'invalid' }],
    [{ ...shot, tab: 'Unknown' }],
  ]) {
    assert.throws(() => validateShots(input));
  }
});

test('cursor follows real hover targets at the recorded zoom', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<a href="#">Link</a><input aria-label="Text"><div style="height:300px">Background</div>',
    );
    await page.evaluate(() => {
      document.documentElement.style.zoom = '0.85';
    });
    await installCursor(page);
    for (const [selector, expected] of [
      ['a', 'pointer'],
      ['input', 'text'],
      ['div:not(#recording-cursor)', 'default'],
    ]) {
      const box = await page.locator(selector).boundingBox();
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await move(page, { x: 1, y: 1 }, point, 100);
      const cursor = page.locator('#recording-cursor');
      assert.equal(await cursor.getAttribute('data-variant'), expected);
      const actual = await cursor.boundingBox();
      assert.ok(
        Math.abs(actual.x - point.x) < 1 && Math.abs(actual.y - point.y) < 1,
      );
    }
  } finally {
    await browser.close();
  }
});
