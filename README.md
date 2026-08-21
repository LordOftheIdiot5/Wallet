# WorldPulse Wallet

A living wallet for the WorldPulse (WPU) token. **Every send is a heartbeat.** The app shows BPM, a pulse state (dormant / still / steady / racing), runway, and a shareable reading for any address.

Open a pulse with no wallet:

`wallet/index.html?watch=0x8ca1470b3ea971add119ada2271e84bdbfccea2a`

## Why this can get picked up

- **One-click watch links** — `?watch=0x…` loads a public pulse card. Share or post that URL.
- **Network pulse on the landing** — the token’s last beat is visible before anyone connects.
- **Send a beat** — MetaMask on Sepolia, or a local Hardhat demo (`?demo=1`) that climbs BPM from dormant to steady without an extension.
- **Not fake AI** — the coach is explicit rules over on-chain sends.

The live Sepolia token is currently **dormant** (last beat hundreds of days ago). That is the story: the heart is quiet until someone sends.

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

### Local send-a-beat demo

```bash
npx hardhat node
python3 scripts/rpc-proxy.py
npm run demo:deploy
# then open http://127.0.0.1:8080/?demo=1 and click Send WPU
```

Sepolia proxy: `0x53911907277be8f6E6B2d3D63A5796410EfA5A0e`

The live proxy still runs the original implementation until you upgrade it. The wallet reconstructs pulse from `Transfer` logs.

```
SEPOLIA_RPC_URL=https://sepolia.gateway.tenderly.co
PRIVATE_KEY=0x...
npx hardhat run contracts/deploy.js --network sepolia
```
