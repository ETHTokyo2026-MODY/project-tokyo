# Explorer recordings

Read-only Playwright capture of public Sepolia transaction pages. It does not load
wallets or send transactions. Install the pinned development dependencies and a
Chromium browser with `npx playwright install chromium`.

```sh
node scripts/recording/blockscout.mjs /absolute/path/shots.json /absolute/path/output
```

Keep input and output outside the repository. Each shot has a unique `id`, a
transaction `hash`, and optionally `tab` (`Token transfers`, `Internal txns`,
`Logs`, or `Raw trace`). Example:

```json
[
  {
    "id": "purchase",
    "hash": "0x<64 hexadecimal digits>",
    "tab": "Token transfers"
  }
]
```

The recorder waits for the matching hash and a successful receipt before the
usable clip starts. The output manifest records trim points, URL, viewport and
zoom. The visible cursor follows real mouse events with arrow, hand and text
variants; movement uses easing and short pauses. Capture uses Playwright's video
support. Inspect the resulting frames before using footage in a demo: successful
capture alone does not establish that an explorer's internal trace has loaded.

## Manual live-demo steps

`startManualSteps` opens a small controller on `127.0.0.1` with a visible **Next
step** button. Each `wait` pauses the runner until that current step is clicked.
It never queues a click for a later step and does not open wallets or sign
transactions.

```js
import { startManualSteps } from './manual-steps.mjs';

const control = await startManualSteps({ port: 0, title: 'Live demo' });
console.log(control.url); // Open this in a separate browser tab.

await control.wait('Host creates car', 'Check the form before continuing.');
// Run the next action here.
await control.wait('Confirm in the wallet', 'Review the wallet request.');
// Continue only after the wallet has completed its own confirmation.
control.complete(); // The finished state remains visible until close().
await control.close();
```

Call `fail(error)` if the runner stops. Call `close()` during cleanup; it closes
only this controller's local server and rejects a pending step.
