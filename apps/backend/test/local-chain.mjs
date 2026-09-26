import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { createPublicClient, createWalletClient, http, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
export const artifact = (name, file = name) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../../contracts/out/${file}.sol/${name}.json`,
        import.meta.url,
      ),
    ),
  );
export async function localChain(t) {
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const p = server.address().port;
      server.close(() => resolve(p));
    });
  });
  const anvil = spawn(
    'anvil',
    ['--host', '127.0.0.1', '--port', String(port), '--silent'],
    { stdio: 'ignore' },
  );
  let spawnError;
  anvil.once('error', (e) => {
    spawnError = e;
  });
  t.after(async () => {
    if (anvil.exitCode === null && !spawnError)
      await new Promise((resolve) => {
        anvil.once('exit', resolve);
        anvil.kill('SIGTERM');
      });
  });
  const transport = http(`http://127.0.0.1:${port}`, { retryCount: 0 });
  const client = createPublicClient({
    chain: foundry,
    transport,
    pollingInterval: 10,
    cacheTime: 0,
  });
  for (let i = 0; ; i++) {
    if (spawnError) throw spawnError;
    try {
      await client.getChainId();
      break;
    } catch (e) {
      if (i > 100) throw e;
      await new Promise((r) => setTimeout(r, 30));
    }
  }
  const wallets = Array.from({ length: 4 }, () =>
    createWalletClient({
      chain: foundry,
      transport,
      account: privateKeyToAccount(generatePrivateKey()),
    }),
  );
  for (const w of wallets)
    await client.request({
      method: 'anvil_setBalance',
      params: [w.account.address, toHex(100n * 10n ** 18n)],
    });
  const receipt = async (hash) => {
    const r = await client.waitForTransactionReceipt({ hash });
    assert.equal(r.status, 'success');
    return r;
  };
  const write = (w, c, functionName, args) =>
    w.writeContract({ ...c, functionName, args }).then(receipt);
  const read = (c, functionName, args) =>
    client.readContract({ ...c, functionName, args });
  const deploy = async (name, args = [], file = name) => {
    const a = artifact(name, file);
    const r = await receipt(
      await wallets[0].deployContract({
        abi: a.abi,
        bytecode: a.bytecode.object,
        args,
      }),
    );
    return { address: r.contractAddress, abi: a.abi };
  };
  return { client, wallets, write, read, deploy, receipt };
}
