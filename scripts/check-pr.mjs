import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = [
  'feat',
  'fix',
  'docs',
  'chore',
  'test',
  'ci',
  'refactor',
  'style',
  'perf',
  'build',
];

const TITLE_RE = new RegExp(
  `^(${TYPES.join('|')})(?:\\(([a-z0-9-]+)\\))?: (.+)$`,
);

const HEADINGS = ['## What changed', '## How it was tested', '## AI usage'];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

function hasRealText(text) {
  return stripHtmlComments(text).trim() !== '';
}

function findHeading(body, heading, fromIndex = 0) {
  const re = new RegExp(`^${escapeRegExp(heading)}[ \\t]*\\r?$`, 'gm');
  re.lastIndex = fromIndex;
  return re.exec(body);
}

export function checkTitle(title) {
  const errors = [];
  const value = title ?? '';

  if (value.trim() === '') {
    errors.push('PR title is required');
    return errors;
  }

  if (value.length > 72) {
    errors.push('PR title must be at most 72 characters');
  }

  if (value.endsWith('.')) {
    errors.push('PR title must not end with a period');
  }

  const match = value.match(TITLE_RE);
  if (!match) {
    errors.push(
      "PR title must match 'type: summary' or 'type(scope): summary' with a valid type and optional lowercase scope",
    );
    return errors;
  }

  const summary = match[3];
  if (!/^[a-z]/.test(summary)) {
    errors.push('PR title summary must start with a lowercase letter');
  }

  return errors;
}

export function checkBody(body) {
  const errors = [];
  const value = body ?? '';

  const matches = HEADINGS.map((heading) => ({
    heading,
    match: findHeading(value, heading),
  }));

  const missing = matches.filter((item) => item.match === null);
  for (const item of missing) {
    errors.push(`PR body is missing heading '${item.heading}'`);
  }

  const found = matches.filter((item) => item.match !== null);
  let outOfOrder = false;
  for (let i = 1; i < found.length; i += 1) {
    if (found[i].match.index < found[i - 1].match.index) {
      errors.push(
        'PR body headings must appear in order: ## What changed, ## How it was tested, ## AI usage',
      );
      outOfOrder = true;
      break;
    }
  }

  if (missing.length > 0 || outOfOrder) {
    return errors;
  }

  for (let i = 0; i < HEADINGS.length; i += 1) {
    const start = matches[i].match.index + matches[i].match[0].length;
    let end = value.length;

    if (i < HEADINGS.length - 1) {
      end = matches[i + 1].match.index;
    } else {
      const nextH2 = value.slice(start).search(/^##[ \t]/m);
      if (nextH2 !== -1) {
        end = start + nextH2;
      }
    }

    if (!hasRealText(value.slice(start, end))) {
      errors.push(`PR body section '${HEADINGS[i]}' must contain real text`);
    }
  }

  return errors;
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return fileURLToPath(import.meta.url) === resolve(entry);
}

function main() {
  const title = process.env.PR_TITLE ?? '';
  const body = process.env.PR_BODY ?? '';
  const errors = [...checkTitle(title), ...checkBody(body)];

  if (errors.length === 0) {
    console.log('PR title and body look good.');
    return;
  }

  console.error('PR format check failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
}

if (isMainModule()) {
  main();
}
