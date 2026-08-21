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
let totalSpent = 0;
let cachedBalance = 0n;
let watchOnly = false;
let demoMode = false;
let activeContract = "0x53911907277be8f6E6B2d3D63A5796410EfA5A0e";
let historyFromBlock = 7956764;
let lastPulse = null;

const CONTRACT_ADDRESS = "0x53911907277be8f6E6B2d3D63A5796410EfA5A0e";
const DEPLOYMENT_BLOCK = 7956764;
const SEPOLIA_CHAIN_ID = "11155111";
const SEPOLIA_RPC = "https://sepolia.gateway.tenderly.co";
const SEPOLIA_WALLET_RPC = "https://ethereum-sepolia.publicnode.com";
const ETHERSCAN_TX = "https://sepolia.etherscan.io/tx/";
const HARDHAT_DEMO_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const AI_ENDPOINTS = [
  "http://127.0.0.1:5000/analyze",
  "https://worldpulse-ai-bdaf19009704.herokuapp.com/analyze",
];
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

function spendKey(address) {
  return `wpu:spent:${address.toLowerCase()}`;
}

function loadCachedSpent(address) {
  const raw = localStorage.getItem(spendKey(address));
  if (raw == null) {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function saveCachedSpent(address, spent) {
  localStorage.setItem(spendKey(address), String(spent));
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
  if (pulse.runwayDays == null || !Number.isFinite(pulse.runwayDays)) {
    $("pulseRunway").innerText = pulse.personalBeats === 0 ? "—" : "∞";
  } else if (pulse.runwayDays > 999) {
    $("pulseRunway").innerText = "∞";
  } else {
    $("pulseRunway").innerText = `${Math.max(1, Math.round(pulse.runwayDays))}d`;
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

async function queryTransfers() {
  const latest = await provider.getBlockNumber();
  const sentFilter = contract.filters.Transfer(userAddress, null);
  const recvFilter = contract.filters.Transfer(null, userAddress);

  async function run(fromBlock, toBlock) {
    const [sent, received] = await Promise.all([
      contract.queryFilter(sentFilter, fromBlock, toBlock),
      contract.queryFilter(recvFilter, fromBlock, toBlock),
    ]);
    const merged = [...sent, ...received].sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return a.blockNumber - b.blockNumber;
      }
      return a.index - b.index;
    });
    const seen = new Set();
    return merged.filter((log) => {
      const key = `${log.transactionHash}:${log.index}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  try {
    return await run(historyFromBlock, latest);
  } catch (error) {
    console.warn("Wide log query failed, scanning in chunks", error);
    const chunk = 40000;
    const all = [];
    for (let from = historyFromBlock; from <= latest; from += chunk) {
      const to = Math.min(from + chunk - 1, latest);
      all.push(...await run(from, to));
    }
    const seen = new Set();
    return all.filter((log) => {
      const key = `${log.transactionHash}:${log.index}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }
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
    const logs = await contract.queryFilter(contract.filters.Transfer(), historyFromBlock, latest);
    return logs.filter((log) => log.args.from !== ethers.ZeroAddress).length;
  } catch (error) {
    console.debug("network beat query failed", error.message);
    return 0;
  }
}

async function updateAi(pulse) {
  totalSpent = pulse.sentTotal;
  applyPulse(pulse);
  for (const url of AI_ENDPOINTS) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
  saveCachedSpent(userAddress, pulse.sentTotal);
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
    const network = new ethers.Network("sepolia", BigInt(SEPOLIA_CHAIN_ID));
    network.ensAddress = null;
    provider = new ethers.JsonRpcProvider(SEPOLIA_RPC, network);
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

function sepoliaReadProvider() {
  const network = new ethers.Network("sepolia", BigInt(SEPOLIA_CHAIN_ID));
  network.ensAddress = null;
  return new ethers.JsonRpcProvider(SEPOLIA_RPC, network);
}

async function loadNetworkPulse() {
  try {
    const netProvider = sepoliaReadProvider();
    const netContract = new ethers.Contract(CONTRACT_ADDRESS, ABI, netProvider);
    const latest = await netProvider.getBlockNumber();
    const logs = await netContract.queryFilter(netContract.filters.Transfer(), DEPLOYMENT_BLOCK, latest);
    const nonMint = logs.filter((log) => log.args.from !== ethers.ZeroAddress);
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
      networkBeats: movements.length,
      movements,
    });
    $("networkBpm").innerText = String(pulse.bpm);
    $("networkState").innerText = pulse.state;
    $("networkAge").innerText = pulse.daysSinceLast == null
      ? `${pulse.personalBeats} network beats`
      : `Last beat ${Math.round(pulse.daysSinceLast)}d ago · ${pulse.personalBeats} beats`;
    const feed = $("networkFeed");
    feed.innerHTML = "";
    const recent = logs.slice(-5).reverse();
    $("networkEmpty").hidden = recent.length > 0;
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
  loadNetworkPulse().catch(console.warn);
  if (params.get("demo") === "1") {
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
  const watch = params.get("watch");
  if (watch && ethers.isAddress(watch)) {
    $("watchAddress").value = watch;
    await watchAddress();
  }
}

window.connectWallet = connectWallet;
window.sendWPU = sendWPU;
window.watchAddress = watchAddress;
boot().catch(console.error);
