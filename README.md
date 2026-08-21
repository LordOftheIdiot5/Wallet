# WorldPulse Wallet

A Sepolia wallet for the WorldPulse (WPU) token. It shows your balance, sends WPU, loads activity from on-chain `Transfer` events, and offers a simple spending suggestion based on outgoing transfers.

This is useful if you hold WPU on Sepolia and want a dedicated send/activity view with a budget nudge. It is not a general-purpose wallet and the “AI” is rule-based, not a financial advisor.

## Tech stack

- **Contract:** Hardhat, Solidity, OpenZeppelin upgradeable ERC-20
- **Frontend:** HTML, CSS, JavaScript, Ethers.js 6
- **Spending service:** Python, Flask

## Sepolia token

Proxy: `0x53911907277be8f6E6B2d3D63A5796410EfA5A0e`

The live proxy still runs the original implementation until you upgrade it. The wallet reads standard ERC-20 `Transfer` logs, so send/history/spend tracking work against the current deployment. Redeploy or upgrade to pick up `pulseCount` and `PulseEvent` on `transferFrom`.

## Setup

```bash
npm install
pip install -r requirements.txt
npx hardhat compile
npx hardhat test
python3 -m unittest test.test_ai
```

Run the wallet UI:

```bash
npx live-server wallet/ --port=8080
```

Run the spending service (optional; the UI falls back to the same rules in the browser, then to the hosted Heroku app):

```bash
python3 ai.py
```

Sepolia deploys need a `.env`:

```
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
PRIVATE_KEY=0x...
```

```bash
npx hardhat run contracts/deploy.js --network sepolia
```

Restrict Flask CORS in production with `CORS_ORIGINS` (comma-separated). The default is `*`.
