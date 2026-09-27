import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startManualSteps } from './manual-steps.mjs';

async function state(controller) {
  const response = await fetch(new URL('state', controller.url));
  assert.equal(response.status, 200);
  return response.json();
}

function next(controller, token, origin = new URL(controller.url).origin) {
  return fetch(new URL('next', controller.url), {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

function nextWithWrongHost(controller, token) {
  const url = new URL('next', controller.url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          Host: 'other.example',
          Origin: url.origin,
          'Content-Type': 'application/json',
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ token }));
  });
}

test('a step stays paused until its visible Next request', async () => {
  const controller = await startManualSteps({ title: 'Demo control' });
  try {
    let advanced = false;
    const gate = controller
      .wait('Host creates car', 'Review the form')
      .then(() => {
        advanced = true;
      });
    const current = await state(controller);
    assert.equal(current.phase, 'waiting');
    assert.equal(current.step, 1);
    assert.equal(current.label, 'Host creates car');
    assert.equal(current.detail, 'Review the form');
    assert.equal(typeof current.token, 'string');
    await delay(40);
    assert.equal(advanced, false);
    assert.equal((await state(controller)).token, current.token);
    assert.equal((await next(controller, current.token)).status, 200);
    await gate;
    assert.equal(advanced, true);
    assert.equal((await state(controller)).phase, 'running');
    controller.complete();
    assert.equal((await state(controller)).phase, 'complete');
  } finally {
    await controller.close();
  }
});

test('duplicate and stale clicks cannot release a future step', async () => {
  const controller = await startManualSteps();
  try {
    const first = controller.wait('First');
    const firstToken = (await state(controller)).token;
    assert.equal((await next(controller, firstToken)).status, 200);
    await first;
    assert.equal((await next(controller, firstToken)).status, 409);

    let advanced = false;
    const second = controller.wait('Second').then(() => {
      advanced = true;
    });
    const secondToken = (await state(controller)).token;
    assert.notEqual(secondToken, firstToken);
    assert.equal((await next(controller, firstToken)).status, 409);
    await delay(40);
    assert.equal(advanced, false);
    assert.equal((await next(controller, secondToken)).status, 200);
    await second;
    assert.equal(advanced, true);
  } finally {
    await controller.close();
  }
});

test('cross-origin and wrong-host requests cannot advance a step', async () => {
  const controller = await startManualSteps();
  try {
    let advanced = false;
    const gate = controller.wait('Protected').then(() => {
      advanced = true;
    });
    const token = (await state(controller)).token;
    assert.equal(
      (await next(controller, token, 'https://other.example')).status,
      403,
    );
    assert.equal(await nextWithWrongHost(controller, token), 403);
    await delay(40);
    assert.equal(advanced, false);
    assert.equal((await next(controller, token)).status, 200);
    await gate;
  } finally {
    await controller.close();
  }
});
