#!/usr/bin/env node
// Anvil-fork e2e for the server ENS library. Does not send real Sepolia txs.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const env = {
  ...process.env,
  RUN_ENS_FORK: '1',
  SEPOLIA_RPC_URL:
    process.env.SEPOLIA_RPC_URL ??
    'https://ethereum-sepolia-rpc.publicnode.com',
  PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH}`,
};
const child = spawn(
  'npm',
  ['test', '--workspace=web', '--', 'lib/ens/ens.fork.test.ts'],
  { cwd: ROOT, env, stdio: 'inherit' },
);
child.on('exit', (code) => process.exit(code ?? 1));
