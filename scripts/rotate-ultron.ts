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
        env: {
        ...process.env,
        PATH: `/usr/local/bin:${process.env.PATH}`,
        // When bun is installed as a snap, XDG_CONFIG_HOME is
        // redirected into ~/snap/bun-js/<rev>/.config, which hides the
        // wrangler OAuth token stored by `wrangler login` at the real
        // ~/.config/.wrangler/. Force the spawned wrangler back to the
        // user's host config so it sees the login.
        XDG_CONFIG_HOME: `${process.env.HOME}/.config`,
    },
    });
    if (list.status !== 0 || !list.stdout.includes('"ULTRON_PRIVATE_KEY"')) {
        console.error('\n[rotate-ultron] wrangler reported success but ULTRON_PRIVATE_KEY is NOT in `wrangler secret list`.');
        console.error('[rotate-ultron] Fresh key was generated in-memory only and is now discarded.');
        console.error('[rotate-ultron] Run `npx wrangler login` (missing OAuth scopes can cause silent failures), then re-run this script.');
        process.exit(2);
    }
    console.log('');
    console.log(`New Ultron public Sui address: ${address}`);
    console.log('Next steps:');
    console.log('  1. Delete legacy binding:  npx wrangler secret delete SHADE_KEEPER_PRIVATE_KEY');
    console.log('  2. Sweep references to the old Ultron address in docs/memory.');
    console.log('  3. Run the Regigigas rumble ceremony in brando.sui\u2019s browser session.');
});
