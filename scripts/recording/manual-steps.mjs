import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const page = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Manual demo steps</title>
<style>
  body { margin: 0; background: #f8fafc; color: #111827; font: 18px system-ui, sans-serif; }
  main { max-width: 720px; margin: 8vh auto; padding: 24px; }
  section { background: white; border: 1px solid #cbd5e1; border-radius: 16px; padding: 32px; box-shadow: 0 12px 36px #0f172a15; }
  h1 { margin: 0 0 24px; font-size: 28px; }
  #count { color: #475569; font-size: 15px; font-weight: 700; }
  h2 { margin: 12px 0; font-size: 27px; }
  #detail { white-space: pre-wrap; line-height: 1.5; }
  button { margin-top: 24px; padding: 14px 28px; border: 0; border-radius: 10px; color: white; background: #1d4ed8; font: inherit; font-weight: 700; cursor: pointer; }
  button:disabled { background: #94a3b8; cursor: default; }
  button:focus-visible { outline: 3px solid #f59e0b; outline-offset: 3px; }
  #message { min-height: 1.5em; color: #b91c1c; font-size: 15px; }
</style>
<main><section>
  <h1 id="title"></h1>
  <div id="count" aria-live="polite"></div>
  <h2 id="label" aria-live="polite"></h2>
  <p id="detail"></p>
  <button id="next" type="button" disabled>Next step</button>
  <p id="message" role="alert"></p>
</section></main>
<script>
  const title = document.getElementById('title');
  const count = document.getElementById('count');
  const label = document.getElementById('label');
  const detail = document.getElementById('detail');
  const next = document.getElementById('next');
  const message = document.getElementById('message');
  let currentToken = null;
  let submitting = false;
  async function refresh() {
    try {
      const response = await fetch('/state', { cache: 'no-store' });
      if (!response.ok) throw new Error('Controller unavailable');
      const state = await response.json();
      title.textContent = state.title;
      count.textContent = state.step ? 'Step ' + state.step : 'Ready';
      label.textContent = state.phase === 'complete' ? 'Demo complete'
        : state.phase === 'failed' ? 'Demo stopped'
        : state.phase === 'closed' ? 'Controller closed'
        : state.phase === 'running' ? 'Action running'
        : state.label;
      detail.textContent = state.phase === 'waiting' ? state.detail || '' : '';
      currentToken = state.phase === 'waiting' ? state.token : null;
      next.disabled = !currentToken || submitting;
      if (state.phase === 'failed') message.textContent = state.error || 'Demo failed';
      else if (!submitting) message.textContent = '';
    } catch {
      next.disabled = true;
      message.textContent = 'Controller unavailable';
    }
  }
  next.addEventListener('click', async () => {
    if (!currentToken || submitting) return;
    submitting = true;
    next.disabled = true;
    const token = currentToken;
    try {
      const response = await fetch('/next', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) throw new Error('This step is no longer active');
    } catch (error) {
      message.textContent = error.message;
    } finally {
      submitting = false;
      await refresh();
    }
  });
  refresh();
  setInterval(refresh, 500);
</script>
</html>`;

function respond(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
  });
  res.end(body);
}

export async function startManualSteps({
  port = 0,
  title = 'Manual demo steps',
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError('port must be an integer from 0 to 65535');
  }
  if (typeof title !== 'string' || !title.trim()) {
    throw new TypeError('title must be a nonempty string');
  }

  let phase = 'running';
  let step = 0;
  let label = '';
  let detail = '';
  let error = '';
  let pending = null;
  let origin;
  let closing;

  const server = createServer(async (req, res) => {
    if (req.headers.host !== new URL(origin).host) {
      respond(res, 403, 'Forbidden');
      return;
    }
    if (req.method === 'GET' && req.url === '/') {
      respond(res, 200, page, 'text/html; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && req.url === '/state') {
      respond(
        res,
        200,
        JSON.stringify({
          title,
          phase,
          step,
          label,
          detail,
          error,
          token: phase === 'waiting' ? pending?.token : null,
        }),
        'application/json; charset=utf-8',
      );
      return;
    }
    if (req.method !== 'POST' || req.url !== '/next') {
      respond(res, 404, 'Not found');
      return;
    }
    if (
      req.headers.origin !== origin ||
      req.headers['content-type']?.split(';', 1)[0] !== 'application/json'
    ) {
      respond(res, 403, 'Forbidden');
      return;
    }
    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024) {
          respond(res, 413, 'Request too large');
          return;
        }
      }
      const token = JSON.parse(body)?.token;
      if (typeof token !== 'string') {
        respond(res, 400, 'Missing step token');
        return;
      }
      if (phase !== 'waiting' || pending?.token !== token) {
        respond(res, 409, 'Step is no longer active');
        return;
      }
      const current = pending;
      pending = null;
      phase = 'running';
      respond(res, 200, 'Next step accepted');
      current.resolve();
    } catch {
      respond(res, 400, 'Invalid request');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;

  function end(nextPhase, reason) {
    if (phase === 'complete' || phase === 'failed' || phase === 'closed')
      return;
    phase = nextPhase;
    error = reason || '';
    if (pending) {
      const current = pending;
      pending = null;
      current.reject(
        new Error(reason || `Manual step controller ${nextPhase}`),
      );
    }
  }

  return {
    url: `${origin}/`,
    wait(nextLabel, nextDetail = '') {
      if (phase !== 'running' || pending) {
        return Promise.reject(new Error('Manual step controller is not ready'));
      }
      if (typeof nextLabel !== 'string' || !nextLabel.trim()) {
        return Promise.reject(
          new TypeError('Step label must be a nonempty string'),
        );
      }
      if (typeof nextDetail !== 'string') {
        return Promise.reject(new TypeError('Step detail must be a string'));
      }
      step += 1;
      label = nextLabel;
      detail = nextDetail;
      phase = 'waiting';
      return new Promise((resolve, reject) => {
        pending = { token: randomUUID(), resolve, reject };
      });
    },
    complete() {
      end('complete');
    },
    fail(cause) {
      end('failed', cause instanceof Error ? cause.message : String(cause));
    },
    async close() {
      if (closing) return closing;
      end('closed');
      closing = new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
