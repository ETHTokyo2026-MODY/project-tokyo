import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('published runtime configuration contains only encrypted secrets', () => {
  const source = readFileSync(
    new URL('../apps/web/.env.production', import.meta.url),
    'utf8',
  );
  const entries = source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  assert.ok(entries.length > 1, 'Missing encrypted runtime configuration');
  for (const entry of entries) {
    const match = /^([A-Z_][A-Z_0-9]*)=(?:"([^"]+)"|([^\s"]+))$/.exec(entry);
    assert.ok(match, 'Unexpected runtime configuration format');
    const [, name, quoted, unquoted] = match;
    const value = quoted ?? unquoted;
    assert.ok(
      !name.includes('PRIVATE_KEY'),
      'Private key must stay outside Git',
    );
    assert.ok(
      !name.startsWith('NEXT_PUBLIC_'),
      'Runtime secrets are server-only',
    );
    if (name === 'DOTENV_PUBLIC_KEY_PRODUCTION') {
      assert.match(value, /^(02|03)[0-9a-f]{64}$/);
    } else {
      assert.ok(
        value.startsWith('encrypted:'),
        'Encrypt values before committing',
      );
    }
  }
});
