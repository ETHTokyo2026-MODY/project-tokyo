import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkBody, checkTitle } from './check-pr.mjs';

describe('checkTitle', () => {
  it('accepts conventional titles with and without scope', () => {
    assert.deepEqual(checkTitle('feat: add yen formatter'), []);
    assert.deepEqual(checkTitle('fix(web): handle empty input'), []);
    assert.deepEqual(checkTitle('docs: update plan'), []);
    assert.deepEqual(checkTitle('chore: bump prettier'), []);
    assert.deepEqual(checkTitle('test: cover format yen'), []);
    assert.deepEqual(checkTitle('ci: add checks and pr format validation'), []);
    assert.deepEqual(checkTitle('refactor: extract helper'), []);
    assert.deepEqual(checkTitle('style: fix spacing'), []);
    assert.deepEqual(checkTitle('perf: cache formatter'), []);
    assert.deepEqual(checkTitle('build: update next'), []);
  });

  it('rejects an unknown type', () => {
    const errors = checkTitle('wip: add something');
    assert.ok(errors.some((error) => error.includes('must match')));
  });

  it('rejects an invalid scope', () => {
    assert.ok(checkTitle('feat(Web): add something').length > 0);
    assert.ok(checkTitle('feat(web_app): add something').length > 0);
    assert.ok(checkTitle('feat(): add something').length > 0);
  });

  it('rejects a summary that does not start with a lowercase letter', () => {
    const errors = checkTitle('feat: Add something');
    assert.ok(errors.some((error) => error.includes('lowercase letter')));
  });

  it('rejects a trailing period', () => {
    const errors = checkTitle('feat: add something.');
    assert.ok(errors.some((error) => error.includes('period')));
  });

  it('rejects a title longer than 72 characters', () => {
    const title =
      'feat: this title is way too long and should fail the seventy two character limit xx';
    assert.ok(title.length > 72);
    const errors = checkTitle(title);
    assert.ok(errors.some((error) => error.includes('72')));
  });

  it('rejects a malformed title', () => {
    assert.ok(checkTitle('feat add something').length > 0);
    assert.ok(checkTitle('feat:add something').length > 0);
    assert.ok(checkTitle('').length > 0);
  });
});

function validBody(overrides = {}) {
  return [
    '## What changed',
    '',
    overrides.what ?? 'Added CI checks.',
    '',
    '## How it was tested',
    '',
    overrides.tested ?? 'Ran npm test.',
    '',
    '## AI usage',
    '',
    overrides.ai ?? 'Written by a Cursor cloud agent.',
    '',
  ].join('\n');
}

describe('checkBody', () => {
  it('accepts a complete body and ignores preamble or footer comments', () => {
    const body = [
      'Ignore this preamble.',
      '',
      validBody().trimEnd(),
      '',
      '<!-- CURSOR_AGENT_PR_BODY_END -->',
      'tool footer',
    ].join('\n');
    assert.deepEqual(checkBody(body), []);
  });

  it('rejects a missing section', () => {
    const body = [
      '## What changed',
      '',
      'Added CI checks.',
      '',
      '## How it was tested',
      '',
      'Ran npm test.',
      '',
    ].join('\n');
    const errors = checkBody(body);
    assert.ok(errors.some((error) => error.includes('## AI usage')));
  });

  it('rejects an empty section that only has the template comment', () => {
    const body = validBody({
      what: '<!-- Short summary of the change and why it is needed. -->',
    });
    const errors = checkBody(body);
    assert.ok(errors.some((error) => error.includes('## What changed')));
  });

  it('rejects sections out of order', () => {
    const body = [
      '## How it was tested',
      '',
      'Ran npm test.',
      '',
      '## What changed',
      '',
      'Added CI checks.',
      '',
      '## AI usage',
      '',
      'Written by a Cursor cloud agent.',
      '',
    ].join('\n');
    const errors = checkBody(body);
    assert.ok(errors.some((error) => error.includes('order')));
  });
});
