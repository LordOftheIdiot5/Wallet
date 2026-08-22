// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IPulse {
    function lastPulseAt(address) external view returns (uint256);
}

/// @title PulseVault
/// @notice Opt-in vault that delays withdrawals by how much they look like a
///         theft, and lets a guardian cancel one while the delay runs.
///
/// @dev Design constraints, each deliberate, because a recovery mechanism is
///      only worth having if it cannot become a seizure mechanism:
///
///      1. There is no admin, owner or issuer role anywhere in this contract.
///         Nobody - including its deployer - can move another account's funds.
///      2. It is opt-in. Not depositing changes nothing, and the underlying
///         ERC-20 is untouched, so composability is unaffected.
///      3. A guardian can only CANCEL, returning funds to the depositor's vault
///         balance. A guardian can never redirect, withdraw or receive. A
///         compromised guardian cannot steal - only obstruct.
///      4. Removing a guardian is timelocked and the guardian cannot cancel
///         their own removal, so obstruction is bounded rather than permanent.
///      5. Delays are bounded by maxDelay. Nothing can be locked indefinitely.
///
///      What this does NOT do: recover funds already stolen. Nothing can, short
///      of an authority able to seize, which is the thing being avoided here.
contract PulseVault {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    IPulse public immutable pulse;

    uint64 public immutable minDelay;        // every withdrawal waits at least this
    uint64 public immutable largeShareDelay; // added when draining most of a vault
    uint64 public immutable dormancyDelay;   // added when the address has been silent
    uint64 public immutable dormancyWindow;  // how long counts as silent
    uint64 public immutable maxDelay;        // hard ceiling, always reachable
    uint64 public immutable guardianDelay;   // timelock on removing a guardian

    struct Pending {
        address to;
        uint256 amount;
        uint64 readyAt;
    }

    struct GuardianChange {
        address next;
        uint64 readyAt;
    }

    mapping(address => uint256) public balanceOf;
    mapping(address => address) public guardianOf;
    mapping(address => Pending) public pendingOf;
    mapping(address => GuardianChange) public guardianChangeOf;

    event Deposited(address indexed account, uint256 amount);
    event WithdrawRequested(address indexed account, address indexed to, uint256 amount, uint64 readyAt);
    event WithdrawExecuted(address indexed account, address indexed to, uint256 amount);
    event WithdrawCancelled(address indexed account, address indexed by);
    event GuardianSet(address indexed account, address indexed guardian);
    event GuardianChangeStarted(address indexed account, address indexed next, uint64 readyAt);
    event GuardianChangeCancelled(address indexed account);

    constructor(
        address token_,
        address pulse_,
        uint64 minDelay_,
        uint64 largeShareDelay_,
        uint64 dormancyDelay_,
        uint64 dormancyWindow_,
        uint64 maxDelay_,
        uint64 guardianDelay_
    ) {
        require(token_ != address(0) && pulse_ != address(0), "PulseVault: addresses required");
        require(maxDelay_ >= minDelay_, "PulseVault: max below min");
        require(maxDelay_ <= 14 days, "PulseVault: max delay too long");
        require(guardianDelay_ <= 14 days, "PulseVault: guardian delay too long");
        token = IERC20(token_);
        pulse = IPulse(pulse_);
        minDelay = minDelay_;
        largeShareDelay = largeShareDelay_;
        dormancyDelay = dormancyDelay_;
        dormancyWindow = dormancyWindow_;
        maxDelay = maxDelay_;
        guardianDelay = guardianDelay_;
    }

    // --- deposits ---

    function deposit(uint256 amount) external {
        require(amount > 0, "PulseVault: nothing to deposit");
        balanceOf[msg.sender] += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    // --- the delay ---

    /// @notice How long a withdrawal would have to wait. Ordinary use barely
    ///         notices; the shape of a drain waits the longest.
    function delayFor(address account, uint256 amount) public view returns (uint64) {
        uint256 held = balanceOf[account];
        uint256 delay = minDelay;

        // Proportional, not a threshold. A step here would be gameable: ten
        // withdrawals of a tenth each would clear a "half the vault" test and
        // total less waiting than one drain. Scaling with the fraction removed
        // makes splitting strictly worse - n slices cost n x minDelay plus the
        // same share penalty in total, so the thief pays (n-1) x minDelay extra.
        if (held > 0) {
            delay += (uint256(largeShareDelay) * amount) / held;
        }

        // Silent for a long time, then moving: the classic drain signature, and
        // in pulse terms a flatline followed by one enormous spike.
        uint256 last = pulse.lastPulseAt(account);
        if (last == 0 || block.timestamp - last > dormancyWindow) {
            delay += dormancyDelay;
        }

        return delay > maxDelay ? maxDelay : uint64(delay);
    }

    // --- withdrawals ---

    /// @dev One pending withdrawal at a time, on purpose. It means splitting a
    ///      drain into small amounts to dodge the large-share delay costs the
    ///      thief minDelay per slice, so the total wait goes up rather than down.
    function requestWithdraw(address to, uint256 amount) external {
        require(to != address(0), "PulseVault: recipient required");
        require(amount > 0 && amount <= balanceOf[msg.sender], "PulseVault: amount exceeds balance");
        require(pendingOf[msg.sender].amount == 0, "PulseVault: withdrawal already pending");

        uint64 readyAt = uint64(block.timestamp) + delayFor(msg.sender, amount);
        pendingOf[msg.sender] = Pending({ to: to, amount: amount, readyAt: readyAt });
        emit WithdrawRequested(msg.sender, to, amount, readyAt);
    }

    function executeWithdraw() external {
        Pending memory request = pendingOf[msg.sender];
        require(request.amount > 0, "PulseVault: nothing pending");
        require(block.timestamp >= request.readyAt, "PulseVault: still waiting");
        require(request.amount <= balanceOf[msg.sender], "PulseVault: balance moved");

        delete pendingOf[msg.sender];
        balanceOf[msg.sender] -= request.amount;
        token.safeTransfer(request.to, request.amount);
        emit WithdrawExecuted(msg.sender, request.to, request.amount);
    }

    /// @notice Cancel a pending withdrawal. Callable by the depositor or their
    ///         guardian.
    /// @dev The funds go nowhere - they simply stay in the depositor's vault
    ///      balance. This is what makes a compromised guardian an obstruction
    ///      rather than a thief: there is no path here that pays the caller.
    function cancelWithdraw(address account) external {
        require(
            msg.sender == account || msg.sender == guardianOf[account],
            "PulseVault: not owner or guardian"
        );
        require(pendingOf[account].amount > 0, "PulseVault: nothing pending");
        delete pendingOf[account];
        emit WithdrawCancelled(account, msg.sender);
    }

    // --- guardians ---

    /// @notice Appoint a guardian, or begin replacing one.
    /// @dev The first appointment is immediate: there is nobody to protect the
    ///      depositor from yet. Every later change is timelocked, so a thief
    ///      holding the key cannot instantly swap the guardian out.
    function setGuardian(address guardian) external {
        if (guardianOf[msg.sender] == address(0)) {
            guardianOf[msg.sender] = guardian;
            emit GuardianSet(msg.sender, guardian);
            return;
        }
        uint64 readyAt = uint64(block.timestamp) + guardianDelay;
        guardianChangeOf[msg.sender] = GuardianChange({ next: guardian, readyAt: readyAt });
        emit GuardianChangeStarted(msg.sender, guardian, readyAt);
    }

    function executeGuardianChange() external {
        GuardianChange memory change = guardianChangeOf[msg.sender];
        require(change.readyAt != 0, "PulseVault: no change pending");
        require(block.timestamp >= change.readyAt, "PulseVault: still waiting");
        delete guardianChangeOf[msg.sender];
        guardianOf[msg.sender] = change.next;
        emit GuardianSet(msg.sender, change.next);
    }

    /// @notice Abandon a pending guardian change.
    /// @dev Depositor only. A guardian able to cancel their own removal could
    ///      obstruct forever, which would turn protection into a hostage
    ///      situation. This is the single most important restriction here.
    function cancelGuardianChange() external {
        require(guardianChangeOf[msg.sender].readyAt != 0, "PulseVault: no change pending");
        delete guardianChangeOf[msg.sender];
        emit GuardianChangeCancelled(msg.sender);
    }
}
