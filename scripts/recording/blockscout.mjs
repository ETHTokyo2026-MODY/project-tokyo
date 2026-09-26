import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

// Read-only explorer footage. Input contains public transaction hashes only.
export function validateShots(shots) {
  if (!Array.isArray(shots) || !shots.length)
    throw Error('Provide a nonempty shot list');
  const ids = new Set();
  for (const shot of shots) {
    if (
      !/^[a-z0-9-]{1,80}$/.test(shot.id) ||
      ids.has(shot.id) ||
      !/^0x[0-9a-fA-F]{64}$/.test(shot.hash)
    )
      throw Error('Invalid or duplicate shot');
    if (
      shot.tab &&
      !['Token transfers', 'Internal txns', 'Logs', 'Raw trace'].includes(
        shot.tab,
      )
    )
      throw Error('Unsupported explorer tab');
    ids.add(shot.id);
  }
  return shots;
}

// The overlay follows actual browser mouse events; it never changes page data.
export async function installCursor(page) {
  await page.evaluate(() => {
    const old = document.getElementById('recording-cursor');
    old?.remove();
    const cursor = document.createElement('div');
    cursor.id = 'recording-cursor';
    Object.assign(cursor.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '28px',
      height: '32px',
      zIndex: '2147483647',
      pointerEvents: 'none',
      filter: 'drop-shadow(0 1px 2px #0008)',
    });
    const arrow =
      '<path d="M4 2v24l6-6 5 10 5-3-5-9h9Z" fill="white" stroke="#161616" stroke-width="1.7"/>';
    const hand =
      '<path d="M9 17V4a3 3 0 0 1 6 0v9c3-3 5-1 5 1 4-2 6 1 6 4v6c0 6-4 8-10 8-5 0-7-4-10-8l-3-5c-2-4 2-6 6-2Z" fill="white" stroke="#161616" stroke-width="1.7"/>';
    const text =
      '<path d="M9 3h10M14 3v25M9 28h10" fill="none" stroke="white" stroke-width="5"/><path d="M9 3h10M14 3v25M9 28h10" fill="none" stroke="#161616" stroke-width="2"/>';
    document.documentElement.append(cursor);
    const update = (e) => {
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const style = target ? getComputedStyle(target).cursor : 'default';
      const variant =
        style === 'text' || target?.matches('input,textarea')
          ? 'text'
          : style === 'pointer' ||
              target?.closest('a,button,[role="tab"],summary')
            ? 'pointer'
            : 'default';
      cursor.dataset.variant = variant;
      cursor.innerHTML = `<svg viewBox="0 0 32 36" width="28" height="32">${variant === 'text' ? text : variant === 'pointer' ? hand : arrow}</svg>`;
      // CSS zoom scales fixed positioning too; compensate so the overlay stays at the mouse.
      const zoom =
        parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
      cursor.style.left = `${e.clientX / zoom}px`;
      cursor.style.top = `${e.clientY / zoom}px`;
      cursor.style.transform = `scale(${1 / zoom})`;
      cursor.style.transformOrigin = 'top left';
    };
    document.addEventListener('mousemove', update);
  });
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function move(page, from, to, duration = 650) {
  const start = Date.now();
  for (let step = 1; step <= 32; step++) {
    const t = step / 32,
      eased = t * t * (3 - 2 * t);
    await page.mouse.move(
      from.x + (to.x - from.x) * eased,
      from.y + (to.y - from.y) * eased,
    );
    await pause(Math.max(0, start + duration * t - Date.now()));
  }
  return to;
}

export async function record(shots, output) {
  validateShots(shots);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    for (const shot of shots) {
      const context = await browser.newContext({
        viewport: { width: 1600, height: 1000 },
        recordVideo: { dir: output, size: { width: 1600, height: 1000 } },
      });
      const page = await context.newPage();
      const url = `https://eth-sepolia.blockscout.com/tx/${shot.hash}`;
      const started = Date.now();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page
          .getByText('Success', { exact: true })
          .first()
          .waitFor({ timeout: 20000 });
        await page
          .getByText(shot.hash, { exact: true })
          .first()
          .waitFor({ timeout: 5000 });
        await page.evaluate(() => {
          document.documentElement.style.zoom = '0.85';
        });
        await installCursor(page);
        await page.mouse.move(1150, 150);
        const contentStart = (Date.now() - started) / 1000;
        await pause(800);
        let position = { x: 1150, y: 150 };
        if (shot.tab) {
          const tab = page.getByRole('tab', { name: shot.tab, exact: true });
          const box = await tab.boundingBox();
          if (!box) throw Error(`Tab is not visible: ${shot.tab}`);
          position = await move(page, position, {
            x: box.x + box.width / 2,
            y: box.y + box.height / 2,
          });
          await pause(350);
          await page.mouse.click(position.x, position.y);
          await pause(1400);
        }
        position = await move(page, position, { x: 600, y: 520 }, 850);
        await pause(1800);
        await move(page, position, { x: 1150, y: 650 }, 850);
        await pause(1800);
        await page.screenshot({ path: join(output, `${shot.id}.png`) });
        const contentEnd = (Date.now() - started) / 1000;
        await page.close();
        const destination = join(output, `${shot.id}.webm`);
        await page.video().saveAs(destination);
        results.push({
          ...shot,
          url,
          path: resolve(destination),
          contentStart,
          contentEnd,
          viewport: { width: 1600, height: 1000 },
          zoom: 0.85,
        });
        await writeFile(
          join(output, 'manifest.json'),
          JSON.stringify(results, null, 2) + '\n',
          { mode: 0o600 },
        );
        console.log(`Recorded ${shot.id}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return results;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output)
    throw Error(
      'Usage: node scripts/recording/blockscout.mjs SHOTS.json OUTPUT_DIRECTORY',
    );
  await record(JSON.parse(await readFile(input, 'utf8')), resolve(output));
}
