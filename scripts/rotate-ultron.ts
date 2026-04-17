// One-shot: generate a fresh Ed25519 Sui keypair, pipe the bech32
// secret to `wrangler secret put ULTRON_PRIVATE_KEY`, and print only
// the public Sui address. The secret never touches stdout, the process
// environment, or disk.
//
// Runs ahead of the Regigigas rumble: a Path B rotation gives brando's
// browser a fresh Ed25519 private key to import-DKG with IKA, without
// ever exposing the prior Ultron secret over the network. Old Ultron
// address is retired; downstream references must be swept after rotation.
//
// Usage: `bun run scripts/rotate-ultron.ts`

import { spawn, spawnSync } from 'node:child_process';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const WRANGLER = './node_modules/.bin/wrangler';

const kp = Ed25519Keypair.generate();
const bech32 = kp.getSecretKey();
const address = kp.getPublicKey().toSuiAddress();

const childEnv = {
    ...process.env,
    PATH: `/usr/local/bin:${process.env.PATH}`,
    // When bun is installed as a snap, XDG_CONFIG_HOME is redirected
    // into ~/snap/bun-js/<rev>/.config, which hides the wrangler OAuth
    // token at ~/.config/.wrangler/. Force the spawned wrangler back
    // to the user's host config.
    XDG_CONFIG_HOME: `${process.env.HOME}/.config`,
};

const proc = spawn(WRANGLER, ['secret', 'put', 'ULTRON_PRIVATE_KEY'], {
    stdio: ['pipe', 'inherit', 'inherit'],
    env: childEnv,
});
proc.stdin.write(bech32);
proc.stdin.end();

proc.on('exit', (code) => {
    if (code !== 0) {
        console.error('\n[rotate-ultron] wrangler exited non-zero — secret NOT written.');
        process.exit(code ?? 1);
    }
    // Trust-but-verify: wrangler occasionally prints errors yet exits 0
    // when a fetch to its telemetry/auth endpoint 400s. Confirm the
    // binding actually landed before reporting success.
    const list = spawnSync(WRANGLER, ['secret', 'list'], {
        encoding: 'utf8',
        env: childEnv,
    });
    if (list.status !== 0 || !list.stdout.includes('"ULTRON_PRIVATE_KEY"')) {
        console.error('\n[rotate-ultron] wrangler reported success but ULTRON_PRIVATE_KEY is NOT in `wrangler secret list`.');
        console.error('[rotate-ultron] `wrangler secret list` status:', list.status);
        console.error('[rotate-ultron] `wrangler secret list` stdout:\n', list.stdout);
        console.error('[rotate-ultron] `wrangler secret list` stderr:\n', list.stderr);
        console.error('[rotate-ultron] Fresh key was generated in-memory only and is now discarded.');
        process.exit(2);
    }
    console.log('');
    console.log(`New Ultron public Sui address: ${address}`);
    console.log('');
    console.log('Next steps (DO NOT delete SHADE_KEEPER_PRIVATE_KEY yet — old address still holds assets):');
    console.log('  1. Sweep assets from old Ultron address \u2192 new one (SUI, NS, IKA, iUSD, USDC, DWalletCaps, IOUs).');
    console.log('  2. Repoint ultron.sui SuiNS \u2192 new address (suinsTx.setTargetAddress + setDefault).');
    console.log('  3. Sweep hardcoded address references in docs/memory/code.');
    console.log('  4. Run the Regigigas rumble ceremony in brando.sui\u2019s browser session.');
    console.log('  5. Only then, after parallel-run confirms new-address signing works: delete SHADE_KEEPER_PRIVATE_KEY.');
});
