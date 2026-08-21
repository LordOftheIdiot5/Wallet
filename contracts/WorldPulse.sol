// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @title WorldPulse
/// @notice ERC-20 whose extra primitive is a pulse: every non-mint movement is a beat.
/// @dev Storage is append-only. Anything new goes above __gap, and __gap shrinks by
///      the same number of slots, or every balance in the proxy moves.
contract WorldPulse is Initializable, ERC20Upgradeable {
    /// @dev How many recent beats are kept on chain.
    uint256 private constant RECENT_BEATS = 8;
    /// @dev Beat amounts are stored in units of 1e12 wei so a beat fits in one slot.
    ///      Precision is 0.000001 WPU, which is display grade, not accounting grade.
    uint256 private constant AMOUNT_UNIT = 1e12;
    /// @dev Ceiling on a single faucet drip, so a misconfigured faucet cannot drain a reserve.
    uint96 public constant MAX_FAUCET_AMOUNT = 1000e18;

    /// @dev One slot: 20 + 6 + 6 bytes.
    struct Beat {
        address sender;
        uint48 timestamp;
        uint48 amount;
    }

    // --- v1 storage: do not reorder ---
    /// @notice Network-wide beats (transfers and burns, excluding mints).
    uint256 public pulseCount;
    /// @notice Beats originated by each address.
    mapping(address => uint256) public personalBeats;
    /// @notice Timestamp of each address's last beat.
    mapping(address => uint256) public lastPulseAt;

    // --- v2 storage: appended ---
    /// @notice Timestamp of the most recent beat by anyone. Without this, recency
    ///         can only come from logs, which public RPCs retain for about two days.
    uint256 public networkLastPulseAt;
    /// @notice Addresses that have ever sent a beat. Participation, not volume.
    uint32 public uniqueSenders;
    /// @dev Next write position in the recentBeats ring.
    uint8 private recentHead;
    /// @dev Set while the faucet distributes, so a drip is not counted as a beat.
    bool private distributing;
    /// @notice Ring of the most recent beats, readable without any log query.
    Beat[RECENT_BEATS] public recentBeats;
    /// @notice Addresses that have taken their one faucet drip.
    mapping(address => bool) public faucetClaimed;
    /// @notice Where drips come from. Must approve this contract to fund the faucet.
    address public faucetReserve;
    /// @notice Size of a single drip.
    uint96 public faucetAmount;

    uint256[35] private __gap;

    event PulseEvent(address indexed sender, uint256 amount, uint256 pulseCount);
    event FaucetClaim(address indexed account, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize() public initializer {
        __ERC20_init("WorldPulse", "WPU");
        _mint(msg.sender, 1_000_000 * 10 ** 18);
    }

    /// @notice Configures the faucet. Call atomically from upgradeAndCall so it
    ///         cannot be front run between the upgrade and the configuration.
    /// @dev The reserve still has to approve this contract before any drip moves,
    ///      so a wrong reserve here cannot spend tokens on its own.
    function initializeFaucet(address reserve, uint96 amount) public reinitializer(2) {
        require(reserve != address(0), "WorldPulse: reserve required");
        require(amount > 0 && amount <= MAX_FAUCET_AMOUNT, "WorldPulse: amount out of range");
        faucetReserve = reserve;
        faucetAmount = amount;
    }

    function pulseOf(address account) external view returns (uint256 beats, uint256 lastAt) {
        return (personalBeats[account], lastPulseAt[account]);
    }

    /// @notice The whole network reading in one call, newest beat first.
    /// @dev Lets the wallet render pulse without a single eth_getLogs.
    function recentPulse()
        external
        view
        returns (
            address[RECENT_BEATS] memory senders,
            uint256[RECENT_BEATS] memory amounts,
            uint256[RECENT_BEATS] memory timestamps
        )
    {
        for (uint256 i = 0; i < RECENT_BEATS; i++) {
            // recentHead is the next write slot, so head - 1 is the newest beat.
            uint256 index = (uint256(recentHead) + RECENT_BEATS - 1 - i) % RECENT_BEATS;
            Beat storage beat = recentBeats[index];
            senders[i] = beat.sender;
            amounts[i] = uint256(beat.amount) * AMOUNT_UNIT;
            timestamps[i] = beat.timestamp;
        }
    }

    /// @notice How much the faucet can still pay out, given the reserve's balance and allowance.
    function faucetRemaining() public view returns (uint256) {
        if (faucetReserve == address(0)) {
            return 0;
        }
        uint256 approved = allowance(faucetReserve, address(this));
        uint256 held = balanceOf(faucetReserve);
        return approved < held ? approved : held;
    }

    /// @notice Take one drip, once per address, so an address can produce its own beats.
    function claim() external {
        require(faucetReserve != address(0), "WorldPulse: faucet disabled");
        require(msg.sender != faucetReserve, "WorldPulse: reserve cannot claim");
        require(!faucetClaimed[msg.sender], "WorldPulse: already claimed");
        uint256 amount = faucetAmount;
        require(faucetRemaining() >= amount, "WorldPulse: faucet empty");

        faucetClaimed[msg.sender] = true;
        // The reserve's allowance is the consent that lets this move its tokens.
        _spendAllowance(faucetReserve, address(this), amount);

        // Distribution is not circulation. Counting drips would make the reserve's
        // beat count a claim counter and pollute the metric the token exists to show.
        distributing = true;
        _transfer(faucetReserve, msg.sender, amount);
        distributing = false;

        emit FaucetClaim(msg.sender, amount);
    }

    /// @dev Catch transfer, transferFrom, and burn. Skip mint so genesis supply is not a beat.
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from == address(0) || value == 0 || distributing) {
            return;
        }
        if (personalBeats[from] == 0) {
            uniqueSenders += 1;
        }
        pulseCount += 1;
        personalBeats[from] += 1;
        lastPulseAt[from] = block.timestamp;
        networkLastPulseAt = block.timestamp;
        _recordBeat(from, value);
        emit PulseEvent(from, value, pulseCount);
    }

    function _recordBeat(address sender, uint256 value) private {
        uint256 units = value / AMOUNT_UNIT;
        if (units > type(uint48).max) {
            units = type(uint48).max;
        }
        recentBeats[recentHead] = Beat({
            sender: sender,
            timestamp: uint48(block.timestamp),
            amount: uint48(units)
        });
        recentHead = uint8((recentHead + 1) % RECENT_BEATS);
    }
}
