# WorldPulse Wallet

A Sepolia wallet for the WorldPulse (WPU) token. Pulse is the heartbeat of WPU movement: every send or burn is a beat. The wallet shows that rhythm as BPM, a state (dormant / still / steady / racing), and a runway estimate from on-chain activity.

This is useful if you hold WPU on Sepolia and want a dedicated send/activity view with a living pulse. It is not a general-purpose wallet and the coach is rule-based, not a financial advisor.

## What pulse is

- **Beat:** a non-mint token movement from an address (`transfer`, `transferFrom`, or burn).
- **Network pulse:** all beats on WPU.
- **Personal pulse:** beats this address originated.
- **BPM / state:** derived from recency, how much of the stack has already moved, and runway.
- **Runway:** days of WPU left at this address's historical send rate.

The live Sepolia proxy still runs the original implementation until you upgrade it. The wallet therefore reconstructs pulse from ERC-20 `Transfer` logs. Redeploy or upgrade to store `pulseCount`, `personalBeats`, and `lastPulseAt` on-chain.

## Tech stack

- **Contract:** Hardhat, Solidity, OpenZeppelin upgradeable ERC-20
- **Frontend:** HTML, CSS, JavaScript, Ethers.js 6
- **Pulse coach:** Python, Flask (optional; the browser has the same rules)

## Sepolia token

Proxy: `0x53911907277be8f6E6B2d3D63A5796410EfA5A0e`

## Setup

```bash
npm install
pip install -r requirements.txt
npx hardhat compile
npx hardhat test
python3 test/test_ai.py
```

Run the wallet UI:

```bash
npx live-server wallet/ --port=8080
```

Connect a browser wallet on Sepolia to send WPU, or paste an address into **View pulse on Sepolia** for a read-only beat, runway, and activity.

```bash
python3 ai.py
```

Sepolia deploys need a `.env`:

```
SEPOLIA_RPC_URL=https://sepolia.gateway.tenderly.co
PRIVATE_KEY=0x...
```

```bash
npx hardhat run contracts/deploy.js --network sepolia
```

Restrict Flask CORS in production with `CORS_ORIGINS` (comma-separated). The default is `*`.
