if (typeof ethers === "undefined") {
  console.error("Ethers.js not loaded. Please ensure the script is included.");
  const banner = document.getElementById("errorBanner");
  if (banner) {
    banner.hidden = false;
    banner.innerText = "Error: Ethers.js not loaded";
  }
  throw new Error("Ethers.js not loaded");
}

let provider;
let signer;
let contract;
let userAddress;
let cachedBalance = 0n;
let watchOnly = false;
let demoMode = false;
let activeContract = "0x53911907277be8f6E6B2d3D63A5796410EfA5A0e";
let historyFromBlock = 7956764;
let lastPulse = null;

const CONTRACT_ADDRESS = "0x53911907277be8f6E6B2d3D63A5796410EfA5A0e";
const DEPLOYMENT_BLOCK = 7956764;
const SEPOLIA_CHAIN_ID = "11155111";
// Read endpoints, tried in order until one answers. A single hardcoded gateway
// is a single point of failure: the previous one (sepolia.gateway.tenderly.co)
// was retired and took the landing pulse and every ?watch= link down with it.
// NOTE: all three serve recent blocks only. None of them return logs from
// around DEPLOYMENT_BLOCK any more, so historical pulse cannot be rebuilt from
// Transfer events on free infrastructure - it needs the on-chain counters from
// the upgraded implementation, or an archive provider.
const SEPOLIA_READ_RPCS = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://1rpc.io/sepolia",
  "https://sepolia.rpc.thirdweb.com",
];
// Offered to the wallet when Sepolia has to be added to it.
const SEPOLIA_WALLET_RPC = "https://ethereum-sepolia.publicnode.com";
// Public RPCs cap eth_getLogs spans. Stay under the common 50k block limit,
// and keep a few chunks in flight so a multi-million block scan still finishes.
const LOG_CHUNK_SIZE = 40000;
const LOG_BATCH_SIZE = 5;
// Public RPCs retain only a short window of logs - measured at roughly 12k
// blocks on Sepolia, so 10k is inside what is actually served. Scanning back to
// DEPLOYMENT_BLOCK returns nothing but costs 90 round trips, so don't.
const RECENT_WINDOW_BLOCKS = 10000;
const ETHERSCAN_TX = "https://sepolia.etherscan.io/tx/";
const HARDHAT_DEMO_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
// Point this at a deployed ai.py to enable the remote coach. Empty means local
// rules only, which is a complete experience - pulse.js already writes a
// suggestion for every state. The previous Heroku host is gone (404), so
// leaving it listed only bought a failed request on every refresh.
const AI_SERVICE_URL = "";
const AI_LOCAL_URL = "http://127.0.0.1:5000/analyze";
const AI_TIMEOUT_MS = 3000;
const ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function pulseCount() view returns (uint256)",
  "function personalBeats(address) view returns (uint256)",
  "function lastPulseAt(address) view returns (uint256)",
  "function pulseOf(address) view returns (uint256 beats, uint256 lastAt)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event PulseEvent(address indexed sender, uint256 amount, uint256 pulseCount)",
];

class NoEnsProvider extends ethers.BrowserProvider {
  constructor(ethereumProvider) {
    super(ethereumProvider, {
      chainId: parseInt(SEPOLIA_CHAIN_ID, 10),
      name: "sepolia",
      ensAddress: null,
    });
  }

  async resolveName(name) {
    if (typeof name !== "string") {
      throw new Error("Invalid address input for resolveName");
    }
    if (ethers.isAddress(name)) {
      return name;
    }
    throw new Error(`ENS not supported on this network. Please use a raw address instead of: ${name}`);
  }

  async lookupAddress() {
    return null;
  }
}

function $(id) {
  return document.getElementById(id);
}

function showLoading(show) {
  $("loadingSpinner").style.display = show ? "block" : "none";
}

function showError(message) {
  const banner = $("errorBanner");
  if (!message) {
    banner.hidden = true;
    banner.innerText = "";
    return;
  }
  banner.hidden = false;
  banner.innerText = message;
}

function formatWpu(value) {
  const raw = ethers.formatUnits(value, 18);
  if (!raw.includes(".")) {
    return raw;
  }
  return raw.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
}

function shorten(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function setConnectedUi(connected) {
  $("disconnectedPanel").hidden = connected;
  $("connectedPanel").hidden = !connected;
  $("pulseCard").hidden = !connected;
  $("sendCard").hidden = !connected || watchOnly;
  $("aiCard").hidden = !connected;
  $("historyCard").hidden = !connected;
  $("networkCard").hidden = connected;
  $("connectButton").disabled = connected;
}

function showToast(message) {
  const toast = $("beatToast");
  toast.hidden = false;
  toast.innerText = message;
  $("pulseCard").classList.add("beat-flash");
  setTimeout(() => $("pulseCard").classList.remove("beat-flash"), 900);
  setTimeout(() => {
    toast.hidden = true;
  }, 3200);
}

function shareUrl(address) {
  const url = new URL(window.location.href);
  url.search = "";
  if (address) {
    url.searchParams.set("watch", address);
  }
  return url.toString();
}

function applyPulse(pulse) {
  document.body.dataset.pulse = pulse.state;
  document.documentElement.style.setProperty("--pulse-ms", `${Math.round(60000 / pulse.bpm)}ms`);
  $("pulseBpm").innerText = String(pulse.bpm);
  $("pulseStateLabel").innerText = pulse.state;
  $("pulseScore").innerText = String(pulse.score);
  $("pulseBeats").innerText = String(pulse.personalBeats);
  $("pulseNetwork").innerText = String(pulse.networkBeats);
  // Same threshold the suggestion copy uses, so the tile and the sentence
  // underneath it never describe one number two different ways.
  if (WorldPulseMath.runwayIsMeaningful(pulse.runwayDays)) {
    $("pulseRunway").innerText = `${Math.max(1, Math.round(pulse.runwayDays))}d`;
  } else if (pulse.runwayDays == null && pulse.personalBeats === 0) {
    $("pulseRunway").innerText = "—";
  } else {
    $("pulseRunway").innerText = "∞";
  }
  $("aiSuggestion").innerText = pulse.suggestion;
  const parts = [`On-chain sends: ${Number(pulse.sentTotal.toFixed(6))} WPU`];
  if (pulse.recentBeats) {
    parts.push(`${pulse.recentBeats} this week`);
  }
  if (pulse.daysSinceLast != null) {
    parts.push(`last beat ${Math.round(pulse.daysSinceLast)}d ago`);
  }
  $("spentDisplay").innerText = parts.join(" · ");
}

function renderHistory(logs) {
  const list = $("txList");
  const empty = $("historyEmpty");
  list.innerHTML = "";

  const items = logs.slice(-20).reverse();
  empty.hidden = items.length > 0;

  items.forEach((log) => {
    const from = log.args.from;
    const to = log.args.to;
    const amount = formatWpu(log.args.value);
    const outgoing = from.toLowerCase() === userAddress.toLowerCase();
    const mint = from === ethers.ZeroAddress;
    const burn = to === ethers.ZeroAddress;
    const other = outgoing ? to : from;
    const li = document.createElement("li");
    const dir = document.createElement("span");
    let dirText;
    let dirClass;
    if (mint) {
      dirText = `Minted ${amount} WPU`;
      dirClass = "received";
    } else if (burn) {
      dirText = `Burned ${amount} WPU`;
      dirClass = "sent";
    } else if (outgoing) {
      dirText = `Sent ${amount} WPU`;
      dirClass = "sent";
    } else {
      dirText = `Received ${amount} WPU`;
      dirClass = "received";
    }
    dir.className = `tx-dir ${dirClass}`;
    dir.innerText = dirText;
    const meta = document.createElement("span");
    meta.className = "tx-meta";
    if (!mint && !burn) {
      meta.innerText = `${outgoing ? "to" : "from"} ${shorten(other)}`;
    }
    if (log.transactionHash && !demoMode) {
      if (meta.innerText) {
        meta.appendChild(document.createTextNode(" · "));
      }
      const link = document.createElement("a");
      link.href = `${ETHERSCAN_TX}${log.transactionHash}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.innerText = "tx";
      meta.appendChild(link);
    }
    li.appendChild(dir);
    li.appendChild(meta);
    list.appendChild(li);
  });
}

function sortDedupe(logs) {
  const seen = new Set();
  return logs
    .filter((log) => {
      const key = `${log.transactionHash}:${log.index}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return a.blockNumber - b.blockNumber;
      }
      return a.index - b.index;
    });
}

// Every historical scan goes through here. Asking for the whole span in one
// call fails outright on the public RPCs we use, so chunk unconditionally
// rather than after a guaranteed round-trip failure.
async function queryFilterChunked(target, filter, fromBlock, toBlock) {
  const ranges = [];
  for (let from = fromBlock; from <= toBlock; from += LOG_CHUNK_SIZE) {
    ranges.push([from, Math.min(from + LOG_CHUNK_SIZE - 1, toBlock)]);
  }
  const logs = [];
  for (let i = 0; i < ranges.length; i += LOG_BATCH_SIZE) {
    const batch = ranges.slice(i, i + LOG_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(([from, to]) => target.queryFilter(filter, from, to))
    );
    results.forEach((chunk) => logs.push(...chunk));
  }
  return logs;
}

// The local demo node serves everything; public Sepolia RPCs do not, so clamp
// live scans to the window they actually answer.
function scanFromBlock(latest) {
  if (demoMode) {
    return historyFromBlock;
  }
  return Math.max(historyFromBlock, latest - RECENT_WINDOW_BLOCKS);
}

async function queryTransfers() {
  const latest = await provider.getBlockNumber();
  const fromBlock = scanFromBlock(latest);
  // Sequential so the two scans share one concurrency budget against the RPC.
  const sent = await queryFilterChunked(
    contract,
    contract.filters.Transfer(userAddress, null),
    fromBlock,
    latest
  );
  const received = await queryFilterChunked(
    contract,
    contract.filters.Transfer(null, userAddress),
    fromBlock,
    latest
  );
  return sortDedupe([...sent, ...received]);
}

function movementFromLog(log) {
  const from = log.args.from;
  const to = log.args.to;
  const amount = Number(ethers.formatUnits(log.args.value, 18));
  if (from === ethers.ZeroAddress) {
    return { direction: "minted", amount, from, to };
  }
  if (to === ethers.ZeroAddress) {
    return { direction: "burned", amount, from, to };
  }
  if (from.toLowerCase() === userAddress.toLowerCase()) {
    return { direction: "sent", amount, from, to };
  }
  return { direction: "received", amount, from, to };
}

async function withTimestamps(logs) {
  const blockNums = [...new Set(logs.map((log) => log.blockNumber))];
  const blocks = await Promise.all(blockNums.map((num) => provider.getBlock(num)));
  const times = new Map(blockNums.map((num, index) => [num, Number(blocks[index].timestamp)]));
  return logs.map((log) => {
    const movement = movementFromLog(log);
    movement.timestamp = times.get(log.blockNumber);
    movement.log = log;
    return movement;
  });
}

async function getNetworkBeats() {
  try {
    return Number(await contract.pulseCount());
  } catch (error) {
    console.debug("pulseCount unavailable on this deployment", error.message);
  }
  try {
    const latest = await provider.getBlockNumber();
    const logs = await queryFilterChunked(
      contract,
      contract.filters.Transfer(),
      scanFromBlock(latest),
      latest
    );
    return logs.filter((log) => log.args.from !== ethers.ZeroAddress).length;
  } catch (error) {
    console.debug("network beat query failed", error.message);
    return 0;
  }
}

// A page served over https cannot call http://127.0.0.1 - the browser blocks
// it as mixed content - so only offer the local service when the page itself
// is local. Anything else is a guaranteed console error on every refresh.
function aiEndpoints() {
  const endpoints = [];
  const host = window.location.hostname;
  if (window.location.protocol !== "https:" || host === "localhost" || host === "127.0.0.1") {
    endpoints.push(AI_LOCAL_URL);
  }
  if (AI_SERVICE_URL) {
    endpoints.push(AI_SERVICE_URL);
  }
  return endpoints;
}

async function updateAi(pulse) {
  // applyPulse has already rendered the locally computed suggestion. The coach
  // can only improve on it, so a missing or slow service costs nothing.
  applyPulse(pulse);
  for (const url of aiEndpoints()) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
        body: JSON.stringify({
          totalSpent: pulse.sentTotal,
          balance: Number(ethers.formatUnits(cachedBalance, 18)),
          state: pulse.state,
          bpm: pulse.bpm,
          runwayDays: pulse.runwayDays,
          personalBeats: pulse.personalBeats,
          spendShare: pulse.spendShare,
        }),
      });
      if (!response.ok) {
        continue;
      }
      const data = await response.json();
      if (data.suggestion && (data.source === "pulse" || data.state)) {
        $("aiSuggestion").innerText = data.suggestion;
        return;
      }
    } catch (error) {
      console.debug("AI endpoint skipped:", url, error.message);
    }
  }
}

async function refreshActivity() {
  if (!contract || !userAddress) {
    return;
  }
  const logs = await queryTransfers();
  renderHistory(logs);
  const movements = await withTimestamps(logs);
  const networkBeats = await getNetworkBeats();
  const pulse = WorldPulseMath.computePulse({
    now: Math.floor(Date.now() / 1000),
    balance: Number(ethers.formatUnits(cachedBalance, 18)),
    networkBeats,
    movements,
  });
  const previous = lastPulse;
  lastPulse = pulse;
  await updateAi(pulse);
  if (previous && previous.state !== pulse.state) {
    showToast(`Beat recorded — ${previous.state} → ${pulse.state} · ${pulse.bpm} BPM`);
  } else if (previous && pulse.personalBeats > previous.personalBeats) {
    showToast(`Beat recorded — ${pulse.bpm} BPM`);
  }
}

async function updateBalance() {
  if (!contract || !userAddress) {
    throw new Error("Wallet not connected");
  }
  const balance = await contract.balanceOf(userAddress);
  cachedBalance = balance;
  $("balance").innerText = formatWpu(balance);
}

function detectProvider(walletType) {
  const providers = window.ethereum?.providers || (window.ethereum ? [window.ethereum] : []);

  if (walletType === "metamask") {
    const found = providers.find((p) => p.isMetaMask && !p.isCoinbaseWallet) || window.ethereum;
    if (!found || !found.isMetaMask || found.isCoinbaseWallet) {
      throw new Error("MetaMask not detected. Please ensure MetaMask is installed and active.");
    }
    return found;
  }
  if (walletType === "coinbase") {
    const found = providers.find((p) => p.isCoinbaseWallet) || window.ethereum;
    if (!found || !found.isCoinbaseWallet) {
      throw new Error("Coinbase Wallet not detected.");
    }
    return found;
  }
  if (walletType === "brave") {
    const found = providers.find((p) => p.isBraveWallet) || window.ethereum;
    if (!found || !found.isBraveWallet) {
      throw new Error("Brave Wallet not detected.");
    }
    return found;
  }
  if (!window.ethereum) {
    throw new Error("No injected wallet detected. Please install a wallet like MetaMask.");
  }
  return window.ethereum;
}

async function ensureSepolia(ethereumProvider) {
  let chainId;
  try {
    const network = await provider.getNetwork();
    chainId = network.chainId.toString();
  } catch (error) {
    console.warn("eth_chainId not supported, using fallback...", error);
    chainId = await ethereumProvider.request({ method: "net_version" });
  }

  if (chainId === SEPOLIA_CHAIN_ID) {
    return;
  }

  const hexChainId = `0x${parseInt(SEPOLIA_CHAIN_ID, 10).toString(16)}`;
  try {
    await ethereumProvider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hexChainId }],
    });
  } catch (switchError) {
    if (switchError.code === 4902) {
      await ethereumProvider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hexChainId,
            chainName: "Sepolia Test Network",
            rpcUrls: [SEPOLIA_WALLET_RPC],
            nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
            blockExplorerUrls: ["https://sepolia.etherscan.io"],
          },
        ],
      });
    } else {
      throw new Error("Please switch to the Sepolia network in your wallet.");
    }
  }
}

async function connectWallet() {
  try {
    showLoading(true);
    showError("");
    watchOnly = false;
    demoMode = false;
    lastPulse = null;
    historyFromBlock = DEPLOYMENT_BLOCK;
    activeContract = CONTRACT_ADDRESS;
    $("networkPill").innerText = "Sepolia";
    const ethereumProvider = detectProvider($("walletSelect").value);
    provider = new NoEnsProvider(ethereumProvider);
    await ensureSepolia(ethereumProvider);
    await ethereumProvider.request({ method: "eth_requestAccounts" });
    signer = await provider.getSigner();

    if (!ethers.isAddress(CONTRACT_ADDRESS)) {
      throw new Error("Invalid contract address: " + CONTRACT_ADDRESS);
    }
    contract = new ethers.Contract(activeContract, ABI, signer);

    const accounts = await ethereumProvider.request({ method: "eth_accounts" });
    if (!accounts || accounts.length === 0) {
      throw new Error("No accounts found. Please connect your wallet.");
    }
    userAddress = accounts[0];

    $("status").innerText = "Connected";
    $("addressDisplay").innerText = shorten(userAddress);
    setConnectedUi(true);
    await updateBalance();
    await refreshActivity();

    const outgoing = contract.filters.Transfer(userAddress, null);
    const incoming = contract.filters.Transfer(null, userAddress);
    contract.on(outgoing, () => {
      updateBalance().catch(console.error);
      refreshActivity().catch(console.error);
    });
    contract.on(incoming, () => {
      updateBalance().catch(console.error);
      refreshActivity().catch(console.error);
    });

    ethereumProvider.on("accountsChanged", () => window.location.reload());
    ethereumProvider.on("chainChanged", () => window.location.reload());
  } catch (error) {
    console.error("Connection failed:", error.message);
    showError(error.message);
    $("status").innerText = "Disconnected";
  } finally {
    showLoading(false);
  }
}

async function sendWPU() {
  try {
    showLoading(true);
    showError("");
    if (!contract) {
      throw new Error("Wallet not connected");
    }
    const to = $("recipient").value.trim();
    const amountInput = $("amount").value;
    if (!ethers.isAddress(to)) {
      throw new Error("Enter a valid recipient address");
    }
    if (!amountInput || Number(amountInput) <= 0) {
      throw new Error("Amount must be a positive number");
    }
    const amount = ethers.parseEther(amountInput);
    const balance = await contract.balanceOf(userAddress);
    if (balance < amount) {
      throw new Error("Insufficient WPU balance");
    }
    const tx = await contract.transfer(to, amount);
    await tx.wait();
    $("amount").value = "";
    await updateBalance();
    await refreshActivity();
  } catch (error) {
    console.error("Send failed:", error.message);
    showError(error.message || String(error));
  } finally {
    showLoading(false);
  }
}

async function copyAddress() {
  if (!userAddress) {
    return;
  }
  try {
    await navigator.clipboard.writeText(userAddress);
    $("copyAddress").innerText = "Copied";
    setTimeout(() => {
      $("copyAddress").innerText = "Copy";
    }, 1200);
  } catch (error) {
    showError("Could not copy address");
  }
}

function fillMax() {
  if (cachedBalance > 0n) {
    $("amount").value = ethers.formatUnits(cachedBalance, 18);
  }
}

async function watchAddress() {
  try {
    showLoading(true);
    showError("");
    const input = $("watchAddress").value.trim();
    if (!ethers.isAddress(input)) {
      throw new Error("Enter a valid address to watch");
    }
    watchOnly = true;
    demoMode = false;
    lastPulse = null;
    historyFromBlock = DEPLOYMENT_BLOCK;
    activeContract = CONTRACT_ADDRESS;
    $("networkPill").innerText = "Sepolia";
    provider = await sepoliaReadProvider();
    contract = new ethers.Contract(activeContract, ABI, provider);
    userAddress = ethers.getAddress(input);
    $("status").innerText = "Watching";
    $("addressDisplay").innerText = shorten(userAddress);
    const share = new URL(window.location.href);
    share.search = "";
    share.searchParams.set("watch", userAddress);
    window.history.replaceState({}, "", share);
    setConnectedUi(true);
    await updateBalance();
    await refreshActivity();
  } catch (error) {
    console.error("Watch failed:", error.message);
    showError(error.message || String(error));
    watchOnly = false;
    $("status").innerText = "Disconnected";
  } finally {
    showLoading(false);
  }
}

$("connectButton").addEventListener("click", connectWallet);
$("watchButton").addEventListener("click", watchAddress);
$("sendButton").addEventListener("click", sendWPU);
$("copyAddress").addEventListener("click", copyAddress);
$("maxButton").addEventListener("click", fillMax);
$("disconnectButton").addEventListener("click", () => window.location.reload());
$("watchAddress").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    watchAddress();
  }
});
$("shareButton").addEventListener("click", copyShareLink);
$("tweetButton").addEventListener("click", tweetPulse);
$("demoButton").addEventListener("click", () => {
  const url = new URL(window.location.href);
  url.search = "demo=1";
  window.location.href = url.toString();
});

let readProviderPromise = null;

// Try each public endpoint until one answers, then reuse it for the session.
// Clears the cache on total failure so a later call can retry.
async function sepoliaReadProvider() {
  if (readProviderPromise) {
    return readProviderPromise;
  }
  readProviderPromise = (async () => {
    let lastError;
    for (const url of SEPOLIA_READ_RPCS) {
      const network = new ethers.Network("sepolia", BigInt(SEPOLIA_CHAIN_ID));
      network.ensAddress = null;
      const candidate = new ethers.JsonRpcProvider(url, network);
      try {
        await candidate.getBlockNumber();
        return candidate;
      } catch (error) {
        lastError = error;
        console.warn("Sepolia RPC unavailable:", url, error.message);
        candidate.destroy();
      }
    }
    readProviderPromise = null;
    throw new Error(`No Sepolia RPC reachable (tried ${SEPOLIA_READ_RPCS.length}): ${lastError?.message ?? "unknown"}`);
  })();
  return readProviderPromise;
}

async function loadNetworkPulse() {
  try {
    const netProvider = await sepoliaReadProvider();
    const netContract = new ethers.Contract(CONTRACT_ADDRESS, ABI, netProvider);
    const latest = await netProvider.getBlockNumber();

    // The total is contract state since the pulse upgrade: exact, and served by
    // every node regardless of how little log history it keeps. A flaky read
    // falls back to the window count rather than blanking the whole card.
    let networkBeats = null;
    try {
      networkBeats = Number(await netContract.pulseCount());
    } catch (error) {
      console.debug("pulseCount unavailable, counting the log window", error.message);
    }

    // Recency and the feed still need logs, so ask only for the window the RPC
    // actually retains. Beats older than that are counted but not listed.
    let logs = [];
    try {
      logs = await queryFilterChunked(
        netContract,
        netContract.filters.Transfer(),
        Math.max(DEPLOYMENT_BLOCK, latest - RECENT_WINDOW_BLOCKS),
        latest
      );
    } catch (error) {
      console.debug("recent log window unavailable", error.message);
    }
    const nonMint = logs.filter((log) => log.args.from !== ethers.ZeroAddress);
    if (networkBeats == null) {
      networkBeats = nonMint.length;
    }
    const blockNums = [...new Set(nonMint.map((log) => log.blockNumber))];
    const blocks = await Promise.all(blockNums.map((num) => netProvider.getBlock(num)));
    const times = new Map(blockNums.map((num, index) => [num, Number(blocks[index].timestamp)]));
    const movements = nonMint.map((log) => ({
      direction: "sent",
      amount: Number(ethers.formatUnits(log.args.value, 18)),
      timestamp: times.get(log.blockNumber),
    }));
    const pulse = WorldPulseMath.computePulse({
      now: Math.floor(Date.now() / 1000),
      balance: 0,
      networkBeats,
      movements,
    });
    $("networkBpm").innerText = String(pulse.bpm);
    $("networkState").innerText = pulse.state;
    const beatLabel = `${networkBeats} network beat${networkBeats === 1 ? "" : "s"}`;
    $("networkAge").innerText = pulse.daysSinceLast == null
      ? beatLabel
      : `Last beat ${Math.round(pulse.daysSinceLast)}d ago · ${beatLabel}`;
    const feed = $("networkFeed");
    feed.innerHTML = "";
    const recent = logs.slice(-5).reverse();
    $("networkEmpty").hidden = recent.length > 0;
    // Distinguish "never beaten" from "beaten, but before the log window".
    $("networkEmpty").innerText = networkBeats > 0
      ? "No beats in the last few hours. Send one to wake the pulse."
      : "No public beats yet.";
    recent.forEach((log) => {
      const li = document.createElement("li");
      const minted = log.args.from === ethers.ZeroAddress;
      const amount = formatWpu(log.args.value);
      li.innerText = minted
        ? `Minted ${amount} WPU`
        : `${shorten(log.args.from)} sent ${amount} WPU`;
      feed.appendChild(li);
    });
  } catch (error) {
    console.warn("Network pulse failed", error);
    $("networkAge").innerText = "Could not load live Sepolia beats.";
  }
}

async function copyShareLink() {
  const url = shareUrl(userAddress);
  try {
    await navigator.clipboard.writeText(url);
    $("shareButton").innerText = "Link copied";
    setTimeout(() => {
      $("shareButton").innerText = "Share";
    }, 1400);
  } catch (error) {
    showError("Could not copy share link");
  }
}

function tweetPulse() {
  const url = shareUrl(userAddress);
  const pulse = lastPulse;
  const text = pulse
    ? `WorldPulse is ${pulse.state} at ${pulse.bpm} BPM. Last beat ${pulse.daysSinceLast == null ? "never" : `${Math.round(pulse.daysSinceLast)}d ago`}.`
    : "WorldPulse — every send is a heartbeat.";
  window.open(
    `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
    "_blank",
    "noopener,noreferrer"
  );
}

async function startDemo() {
  const response = await fetch("demo-config.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Local demo is not deployed. Run npx hardhat node, then npm run demo:deploy, then open ?demo=1.");
  }
  const cfg = await response.json();
  const rpc = String(cfg.rpc || "");
  if (!rpc.includes("127.0.0.1") && !rpc.includes("localhost")) {
    throw new Error("Demo mode only talks to a local Hardhat node.");
  }
  demoMode = true;
  watchOnly = false;
  lastPulse = null;
  activeContract = cfg.contract;
  historyFromBlock = 0;
  $("networkPill").innerText = "Local demo";
  provider = new ethers.JsonRpcProvider(rpc, 31337);
  signer = new ethers.Wallet(HARDHAT_DEMO_KEY, provider);
  contract = new ethers.Contract(activeContract, ABI, signer);
  userAddress = await signer.getAddress();
  $("recipient").value = cfg.recipient;
  $("amount").value = "10";
  $("status").innerText = "Demo";
  $("addressDisplay").innerText = shorten(userAddress);
  $("sendHint").innerText = "This send hits the local Hardhat node. After it lands, BPM should climb from dormant to steady.";
  setConnectedUi(true);
  await updateBalance();
  await refreshActivity();
}

async function boot() {
  const params = new URLSearchParams(window.location.search);
  const watch = params.get("watch");
  const demo = params.get("demo") === "1";
  // The landing card is hidden the moment we connect, watch or demo, so
  // loading it in those cases only races the view the visitor asked for and
  // burns the shared RPC's rate limit.
  if (!demo && !watch) {
    loadNetworkPulse().catch(console.warn);
  }
  if (demo) {
    try {
      showLoading(true);
      showError("");
      await startDemo();
    } catch (error) {
      console.error(error);
      showError(error.message || String(error));
    } finally {
      showLoading(false);
    }
    return;
  }
  if (watch && ethers.isAddress(watch)) {
    $("watchAddress").value = watch;
    await watchAddress();
  }
}

window.connectWallet = connectWallet;
window.sendWPU = sendWPU;
window.watchAddress = watchAddress;
boot().catch(console.error);
