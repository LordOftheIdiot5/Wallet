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
    /// @dev Ceiling on an epoch's emission, so a fat-fingered config cannot mint a fortune.
    uint128 public constant MAX_EMISSION_PER_EPOCH = 10_000e18;
    /// @notice Hard cap. Nothing in this contract can mint past it, ever.
    uint256 public constant MAX_SUPPLY = 21_000_000e18;
    uint256 private constant ACC_PRECISION = 1e18;

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
    /// @dev Counted toward uniqueSenders already. Deliberately not derived from
    ///      personalBeats: addresses that beat before this storage existed have
    ///      a non-zero count already, and keying off that would make them
    ///      permanently uncountable. This measures participation observed since
    ///      pulse tracking began, which is a definition that stays honest.
    mapping(address => bool) private hasBeaten;

    // --- v3 storage: circulation-weighted emission ---
    /// @notice Length of an emission epoch. Zero means emission is off.
    uint64 public epochLength;
    /// @notice A transfer below this does not earn emission. Raises the cost of
    ///         farming beats with dust.
    uint96 public minBeatAmount;
    /// @notice Per address, per epoch, beats past this earn nothing. The main
    ///         brake on farming: an attacker has to spread across funded
    ///         addresses rather than loop one.
    uint8 public maxCountedBeatsPerEpoch;
    /// @notice Total minted for a full epoch, split between that epoch's beaters.
    uint128 public emissionPerEpoch;
    /// @notice Qualifying beats per epoch, network wide.
    mapping(uint256 => uint256) public epochBeats;
    /// @notice Qualifying beats per epoch, per address. Capped as above.
    mapping(uint256 => mapping(address => uint256)) public epochBeatsOf;
    /// @notice Epochs an address has already drawn its share from.
    mapping(uint256 => mapping(address => bool)) public emissionClaimed;

    // --- v4 storage: rhythm and reach ---
    /// @notice Consecutive epochs an address has beaten in. Regularity is the
    ///         one thing a farm cannot buy: funding more addresses is instant,
    ///         thirty days of showing up is not.
    mapping(address => uint32) public streak;
    /// @dev Last epoch an address beat in, for deciding continue vs reset.
    mapping(address => uint64) public lastBeatEpoch;
    /// @notice Distinct recipients an address reached in an epoch. Five sends to
    ///         one address is a loop; five sends to five is circulation.
    mapping(uint256 => mapping(address => uint32)) public epochReach;
    /// @dev Whether a given sender already reached a given recipient this epoch.
    mapping(uint256 => mapping(address => mapping(address => bool))) private reached;
    /// @notice Emission weight per epoch, network wide and per address.
    mapping(uint256 => uint256) public epochWeight;
    mapping(uint256 => mapping(address => uint256)) public epochWeightOf;
    /// @notice Ceiling on the streak multiplier, so an early participant cannot
    ///         accumulate an unbeatable head start.
    uint8 public maxStreakBonus;

    // --- v5 storage: proof of introduction ---
    /// @notice Whether an address has ever received WPU. The token can only be
    ///         introduced to someone once.
    mapping(address => bool) public everHeld;
    /// @notice Who first sent WPU to an address. Set once, never overwritten.
    mapping(address => address) public introducedBy;
    /// @dev Whether that introducer has been paid for this address yet.
    mapping(address => bool) public introductionCredited;
    /// @notice Introductions that came alive in an epoch, per introducer.
    mapping(uint256 => mapping(address => uint32)) public epochIntroductions;
    /// @notice What a vested introduction is worth, in units of reach.
    uint8 public introductionBonus;

    // --- v6 storage: monetary policy ---
    /// @notice Per-epoch emission before halving and before the circulation
    ///         scaling. The schedule, not the outcome.
    uint128 public baseEmission;
    /// @notice Epochs between halvings.
    uint64 public halvingEpochs;
    /// @notice Epoch the schedule started from.
    uint64 public emissionStartEpoch;
    /// @notice Share of each epoch's emission reserved for holders, in basis
    ///         points. The rest goes to circulation.
    uint16 public holderShareBps;
    /// @notice Beats in an epoch at which emission reaches its scheduled size.
    ///         Below this it scales down, so a quiet network mints less.
    uint32 public targetBeatsPerEpoch;
    /// @notice How recently an address must have beaten to collect holder yield.
    uint64 public livenessWindow;
    /// @dev Accumulated yield per token, scaled by 1e18.
    uint256 public accYieldPerToken;
    uint64 public lastAccrualAt;
    /// @dev Yield promised but not yet minted. Counted against the cap so the
    ///      ceiling cannot be breached by outstanding promises.
    uint256 public promisedYield;
    mapping(address => uint256) private yieldDebt;
    mapping(address => uint256) public accruedYield;

    uint256[11] private __gap;

    event PulseEvent(address indexed sender, uint256 amount, uint256 pulseCount);
    event FaucetClaim(address indexed account, uint256 amount);
    event EmissionClaimed(address indexed account, uint256 indexed epoch, uint256 amount);
    event IntroductionVested(address indexed introducer, address indexed newcomer, uint256 indexed epoch);
    event YieldClaimed(address indexed account, uint256 amount);

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

    /// @notice Turns on circulation-weighted emission. Call atomically from
    ///         upgradeAndCall so the reinitializer cannot be front run.
    function initializeEmission(
        uint64 epochLength_,
        uint128 emissionPerEpoch_,
        uint96 minBeatAmount_,
        uint8 maxCountedBeatsPerEpoch_
    ) public reinitializer(3) {
        require(epochLength_ > 0, "WorldPulse: epoch required");
        require(emissionPerEpoch_ > 0 && emissionPerEpoch_ <= MAX_EMISSION_PER_EPOCH,
            "WorldPulse: emission out of range");
        require(maxCountedBeatsPerEpoch_ > 0, "WorldPulse: cap required");
        epochLength = epochLength_;
        emissionPerEpoch = emissionPerEpoch_;
        minBeatAmount = minBeatAmount_;
        maxCountedBeatsPerEpoch = maxCountedBeatsPerEpoch_;
    }

    /// @notice Turns on the streak multiplier. Emission works without it - the
    ///         bonus is simply zero - so this can land in a later upgrade.
    function initializeStreaks(uint8 maxStreakBonus_) public reinitializer(4) {
        require(maxStreakBonus_ > 0, "WorldPulse: bonus required");
        maxStreakBonus = maxStreakBonus_;
    }

    /// @notice Turns on proof of introduction. Emission works without it - the
    ///         bonus is simply zero - so it can land in a later upgrade.
    function initializeIntroductions(uint8 introductionBonus_) public reinitializer(5) {
        require(introductionBonus_ > 0, "WorldPulse: bonus required");
        introductionBonus = introductionBonus_;
    }

    /// @notice Turns on the capped, halving, circulation-linked schedule and
    ///         the holder share.
    function initializeSupplyPolicy(
        uint128 baseEmission_,
        uint64 halvingEpochs_,
        uint16 holderShareBps_,
        uint32 targetBeatsPerEpoch_,
        uint64 livenessWindow_
    ) public reinitializer(6) {
        require(baseEmission_ > 0, "WorldPulse: emission required");
        require(halvingEpochs_ > 0, "WorldPulse: halving required");
        require(holderShareBps_ <= 10_000, "WorldPulse: share out of range");
        require(targetBeatsPerEpoch_ > 0, "WorldPulse: target required");
        baseEmission = baseEmission_;
        halvingEpochs = halvingEpochs_;
        holderShareBps = holderShareBps_;
        targetBeatsPerEpoch = targetBeatsPerEpoch_;
        livenessWindow = livenessWindow_;
        emissionStartEpoch = uint64(currentEpoch());
        lastAccrualAt = uint64(block.timestamp);
    }

    /// @notice What the schedule alone would emit for an epoch, before the
    ///         network's own activity is taken into account.
    function scheduledEmission(uint256 epoch) public view returns (uint256) {
        if (baseEmission == 0 || epoch < emissionStartEpoch) {
            return emissionPerEpoch; // pre-policy behaviour
        }
        uint256 halvings = (epoch - emissionStartEpoch) / halvingEpochs;
        if (halvings > 63) {
            return 0;
        }
        return uint256(baseEmission) >> halvings;
    }

    /// @notice What an epoch actually emits: the schedule, scaled by how much
    ///         the network circulated. A dormant epoch mints nothing at all.
    function epochEmission(uint256 epoch) public view returns (uint256) {
        uint256 scheduled = scheduledEmission(epoch);
        if (targetBeatsPerEpoch == 0) {
            return scheduled;
        }
        uint256 beats = epochBeats[epoch];
        if (beats >= targetBeatsPerEpoch) {
            return scheduled;
        }
        return (scheduled * beats) / targetBeatsPerEpoch;
    }

    /// @dev The share of an epoch that goes to circulation rather than holders.
    ///      Before the supply policy exists holderShareBps is zero, so this is
    ///      the whole emission and older behaviour is unchanged.
    function _circulationPool(uint256 epoch) private view returns (uint256) {
        return (epochEmission(epoch) * (10_000 - holderShareBps)) / 10_000;
    }

    /// @notice Room left under the cap, counting yield already promised.
    function mintableHeadroom() public view returns (uint256) {
        uint256 used = totalSupply() + promisedYield;
        return used >= MAX_SUPPLY ? 0 : MAX_SUPPLY - used;
    }

    /// @dev Holder yield streams continuously from the current epoch's holder
    ///      share. Lazy accumulator, so no loop over epochs is ever needed.
    function _accrue() private {
        uint64 nowTs = uint64(block.timestamp);
        if (lastAccrualAt == 0 || nowTs <= lastAccrualAt) {
            lastAccrualAt = nowTs;
            return;
        }
        uint256 supply = totalSupply();
        uint256 elapsed = nowTs - lastAccrualAt;
        lastAccrualAt = nowTs;
        if (supply == 0 || holderShareBps == 0 || epochLength == 0) {
            return;
        }
        uint256 pool = (epochEmission(currentEpoch()) * holderShareBps) / 10_000;
        uint256 amount = (pool * elapsed) / epochLength;
        uint256 headroom = mintableHeadroom();
        if (amount > headroom) {
            amount = headroom;
        }
        if (amount == 0) {
            return;
        }
        promisedYield += amount;
        accYieldPerToken += (amount * ACC_PRECISION) / supply;
    }

    function _settle(address account) private {
        if (account == address(0)) {
            return;
        }
        uint256 owed = (balanceOf(account) * (accYieldPerToken - yieldDebt[account])) / ACC_PRECISION;
        if (owed > 0) {
            accruedYield[account] += owed;
        }
        yieldDebt[account] = accYieldPerToken;
    }

    /// @notice Yield an address has banked but not taken.
    function pendingYield(address account) external view returns (uint256) {
        return accruedYield[account]
            + (balanceOf(account) * (accYieldPerToken - yieldDebt[account])) / ACC_PRECISION;
    }

    /// @notice Whether an address has beaten recently enough to collect.
    function isAlive(address account) public view returns (bool) {
        if (livenessWindow == 0) {
            return true;
        }
        uint256 last = lastPulseAt[account];
        return last != 0 && block.timestamp - last <= livenessWindow;
    }

    /// @notice Take banked holder yield.
    /// @dev Accrual is unconditional - a dormant holder keeps banking, they
    ///      simply cannot collect until they beat again. Nothing is ever
    ///      forfeited, which keeps the invariant that no balance is reduced by
    ///      anyone's inactivity. The honest limitation: someone can go quiet
    ///      for a year and revive with one beat to collect. The gate is an
    ///      incentive to participate, not a punishment for not having.
    function claimYield() external {
        _accrue();
        _settle(msg.sender);
        require(isAlive(msg.sender), "WorldPulse: pulse too quiet to collect");
        uint256 amount = accruedYield[msg.sender];
        require(amount > 0, "WorldPulse: nothing accrued");
        accruedYield[msg.sender] = 0;
        promisedYield -= amount;
        _mint(msg.sender, amount);
        emit YieldClaimed(msg.sender, amount);
    }

    function currentEpoch() public view returns (uint256) {
        return epochLength == 0 ? 0 : block.timestamp / epochLength;
    }

    /// @notice What an address can still draw for a finished epoch.
    function claimableEmission(address account, uint256 epoch) public view returns (uint256) {
        if (epochLength == 0 || epoch >= currentEpoch() || emissionClaimed[epoch][account]) {
            return 0;
        }
        uint256 mine = epochWeightOf[epoch][account];
        uint256 total = epochWeight[epoch];
        if (mine == 0 || total == 0) {
            return 0;
        }
        return (_circulationPool(epoch) * mine) / total;
    }

    /// @notice Draw your share of an epoch's emission, in proportion to the
    ///         beats you contributed. Holding earns nothing; only motion does.
    /// @dev Purely additive. No balance is ever reduced by this or by anyone's
    ///      inactivity - the only thing that lowers a balance is its owner spending.
    function claimEmission(uint256 epoch) external {
        require(epochLength > 0, "WorldPulse: emission disabled");
        require(epoch < currentEpoch(), "WorldPulse: epoch still open");
        require(!emissionClaimed[epoch][msg.sender], "WorldPulse: already claimed");
        uint256 mine = epochWeightOf[epoch][msg.sender];
        require(mine > 0, "WorldPulse: no weight that epoch");

        emissionClaimed[epoch][msg.sender] = true;
        uint256 amount = (_circulationPool(epoch) * mine) / epochWeight[epoch];
        uint256 headroom = mintableHeadroom();
        if (amount > headroom) {
            amount = headroom;
        }
        require(amount > 0, "WorldPulse: cap reached");
        _mint(msg.sender, amount);
        emit EmissionClaimed(msg.sender, epoch, amount);
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
        // Bank yield at the old balances before they change, or a transfer
        // would silently move the sender's accrual to the recipient.
        _accrue();
        _settle(from);
        _settle(to);
        super._update(from, to, value);
        _noteReceipt(from, to, value);
        if (from == address(0) || value == 0 || distributing) {
            return;
        }
        if (!hasBeaten[from]) {
            hasBeaten[from] = true;
            uniqueSenders += 1;
        }
        pulseCount += 1;
        personalBeats[from] += 1;
        lastPulseAt[from] = block.timestamp;
        networkLastPulseAt = block.timestamp;
        _recordBeat(from, value);
        _creditEpochBeat(from, to, value);
        emit PulseEvent(from, value, pulseCount);
    }

    /// @dev Emission qualification is stricter than the pulse metric on purpose.
    ///      pulseCount stays an honest record of movement; this decides what gets
    ///      paid for, and paying for movement invites manufacturing it.
    function _creditEpochBeat(address from, address to, uint256 value) private {
        if (epochLength == 0) {
            return;
        }
        // Shuffling between your own two addresses is not circulation.
        if (from == to) {
            return;
        }
        // Dust is cheap; make a qualifying beat cost something to produce.
        if (value < minBeatAmount) {
            return;
        }
        uint256 epoch = block.timestamp / epochLength;
        uint256 mine = epochBeatsOf[epoch][from];
        // Past the cap an address earns nothing more, so farming means funding
        // and gassing more addresses rather than looping one.
        if (mine >= maxCountedBeatsPerEpoch) {
            return;
        }
        epochBeatsOf[epoch][from] = mine + 1;
        epochBeats[epoch] += 1;

        // Whoever first handed this address WPU gets paid now, not when they
        // handed it over. Paying on the introduction itself would pay for
        // generating addresses, which costs nothing; paying when the newcomer
        // beats means the sybil has to actually participate to collect - and an
        // address that participates is the thing being bought anyway.
        _vestIntroduction(from, epoch);

        _updateStreak(from, epoch);
        // Reach only rises for a recipient this sender has not paid this epoch,
        // so repeating the same counterparty adds beats but no weight.
        if (!reached[epoch][from][to]) {
            reached[epoch][from][to] = true;
            epochReach[epoch][from] += 1;
        }
        _reweigh(from, epoch);
    }

    /// @dev Records that an address has now held WPU, and who introduced it.
    ///      Written for every receipt including mints, so "never held" means
    ///      exactly that.
    function _noteReceipt(address from, address to, uint256 value) private {
        if (to == address(0) || value == 0 || everHeld[to]) {
            return;
        }
        everHeld[to] = true;
        // A faucet drip is distribution, not an introduction. Crediting the
        // reserve for handing out its own tokens would let it farm the bonus.
        if (from != address(0) && !distributing) {
            introducedBy[to] = from;
        }
    }

    /// @dev Credits an introducer once the address they brought in beats for
    ///      real. If the introducer is already at the epoch's cap the credit is
    ///      left unclaimed rather than burned, so it can land in a later epoch.
    function _vestIntroduction(address newcomer, uint256 epoch) private {
        address introducer = introducedBy[newcomer];
        if (introducer == address(0) || introductionCredited[newcomer]) {
            return;
        }
        uint256 counted = epochIntroductions[epoch][introducer];
        if (counted >= maxCountedBeatsPerEpoch) {
            return;
        }
        introductionCredited[newcomer] = true;
        epochIntroductions[epoch][introducer] = uint32(counted + 1);
        _reweigh(introducer, epoch);
        emit IntroductionVested(introducer, newcomer, epoch);
    }

    /// @dev A streak continues only from the immediately preceding epoch. Miss
    ///      one and it starts over, which is what makes it a rhythm rather than
    ///      a lifetime total.
    function _updateStreak(address account, uint256 epoch) private {
        uint64 last = lastBeatEpoch[account];
        if (last == uint64(epoch)) {
            return; // already counted this epoch
        }
        streak[account] = (last != 0 && uint256(last) + 1 == epoch) ? streak[account] + 1 : 1;
        lastBeatEpoch[account] = uint64(epoch);
    }

    /// @notice Emission weight: how far you reached plus who you brought in,
    ///         multiplied by how reliably you have been showing up.
    function weightOf(address account, uint256 epoch) public view returns (uint256) {
        uint256 base = epochReach[epoch][account]
            + uint256(introductionBonus) * epochIntroductions[epoch][account];
        if (base == 0) {
            return 0;
        }
        uint256 bonus = streak[account];
        if (bonus > maxStreakBonus) {
            bonus = maxStreakBonus;
        }
        return base * (1 + bonus);
    }

    /// @dev Recompute this address's weight and fold the difference into the
    ///      epoch total, so the running sum always matches the parts.
    function _reweigh(address account, uint256 epoch) private {
        uint256 previous = epochWeightOf[epoch][account];
        uint256 current = weightOf(account, epoch);
        if (current == previous) {
            return;
        }
        epochWeightOf[epoch][account] = current;
        epochWeight[epoch] = epochWeight[epoch] - previous + current;
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
