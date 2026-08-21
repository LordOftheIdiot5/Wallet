# WorldPulse Wallet

A living wallet for the WorldPulse (WPU) token. **Every send is a heartbeat.** The app shows BPM, a pulse state (dormant / still / steady / racing), runway, and a shareable reading for any address.

Live at **https://lordoftheidiot5.github.io/Wallet/**

Open a pulse with no wallet, no extension, nothing to install:

https://lordoftheidiot5.github.io/Wallet/?watch=0x8ca1470b3ea971add119ada2271e84bdbfccea2a

## Why this can get picked up

- **One-click watch links** — `?watch=0x…` loads a public pulse card. Share or post that URL.
- **Network pulse on the landing** — the token’s last beat is visible before anyone connects.
- **Send a beat** — MetaMask on Sepolia, or a local Hardhat demo (`?demo=1`) that climbs BPM from dormant to steady without an extension.
- **Not fake AI** — the coach is explicit rules over on-chain sends.

The live Sepolia token is **beating**. The counters reset when the proxy was upgraded to the pulse implementation, so the reading starts from that upgrade rather than from the token's whole history.

## What pulse is

- **Beat:** a non-mint movement (`transfer`, `transferFrom`, burn)
- **BPM / state / score:** recency + how much of the stack has already moved
- **Runway:** days of WPU left at the historical send rate

## Setup

```bash
npm install
pip install -r requirements.txt
npx hardhat compile
npx hardhat test
python3 test/test_ai.py
npx live-server wallet/ --port=8080
```

The coach works without any of this — `wallet/pulse.js` writes a suggestion for
every pulse state locally. Running `python ai.py` gives the wallet a service to
prefer, and it is picked up automatically while the page is served from
localhost. To use a deployed instance, set `AI_SERVICE_URL` in `wallet/app.js`;
the localhost endpoint is skipped on an https page, where browsers block it as
mixed content.

### Local send-a-beat demo

```bash
npx hardhat node
python3 scripts/rpc-proxy.py
npm run demo:deploy
# then open http://127.0.0.1:8080/?demo=1 and click Send WPU
```

Sepolia proxy: `0x53911907277be8f6E6B2d3D63A5796410EfA5A0e`

The proxy runs the pulse implementation, so `pulseCount`, `personalBeats` and
`lastPulseAt` are contract state the wallet reads directly. That matters more
than it sounds: free public RPCs retain only about 12k blocks of logs, so pulse
cannot be rebuilt from `Transfer` events for anything older than roughly two
days. Logs are still used for the activity list, within that window.

To deploy or upgrade, put these in `.env` (gitignored) and run the script.
`node scripts/check-env.js` validates the config first without printing the key,
and `npx hardhat run scripts/preflight-upgrade.js` prices an upgrade on a fork
before one touches the chain.

```
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
PRIVATE_KEY=0x...
npx hardhat run contracts/deploy.js --network sepolia    # first deployment
npx hardhat run contracts/upgrade.js --network sepolia   # upgrade the proxy
```
