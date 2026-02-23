# .SKI

Standalone two-button wallet controls using real Sui wallet runtime.

## Includes
- Left pill button with connected state (name/address, SUI, USD)
- Right `.SKI` menu button with dropdown under it
- Local signed `.SKI` session layer (message-sign + expiry, no backend required)
- Real wallet modal via `SuiWalletKit.renderModal(...)`
- Extension wallet detection + WaaP support

## Run
```bash
cd /home/brandon/Dev/workspace/wallet-buttons-product
python3 -m http.server 4173 -d public
```

Open: `http://localhost:4173/`

## Cloudflare Worker Deploy
This repo is configured for Cloudflare Worker static assets with `wrangler.jsonc`.

```bash
cd /home/brandon/Dev/workspace/wallet-buttons-product
bun install
bunx wrangler login
bunx wrangler dev
```

Deploy:

```bash
bunx wrangler deploy
```

Important: do not open the app via `file://...`; use `http://localhost` (or deployed `https://...`) so wallet/session behavior has a valid origin.

## Transport
- App-level read queries in `public/app.js` use Sui `GraphQL` (`https://graphql.mainnet.sui.io/graphql`).
- Wallet modal/runtime code in `public/generated/wallet-runtime.js` is generated from upstream wallet kit modules and may still include internal RPC client paths.

## Notes
- Browser wallet connections work without backend APIs.
- `.SKI` standard mode is local-first and does not require `/api/wallet/*` endpoints.
- If you want server-trusted or cross-subdomain sessions, implement your own backend/session layer separately.
- Use the wallet dropdown action `Activate .SKI` to create a signed local session; use `Sign Out .SKI` to clear it.
