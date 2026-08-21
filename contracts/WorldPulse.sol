// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @title WorldPulse
/// @notice ERC-20 whose extra primitive is a pulse: every non-mint movement is a beat.
contract WorldPulse is Initializable, ERC20Upgradeable {
    /// @notice Network-wide beats (transfers and burns, excluding mints).
    uint256 public pulseCount;
    /// @notice Beats originated by each address.
    mapping(address => uint256) public personalBeats;
    /// @notice Timestamp of each address's last beat.
    mapping(address => uint256) public lastPulseAt;
    uint256[47] private __gap;

    event PulseEvent(address indexed sender, uint256 amount, uint256 pulseCount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize() public initializer {
        __ERC20_init("WorldPulse", "WPU");
        _mint(msg.sender, 1_000_000 * 10 ** 18);
    }

    function pulseOf(address account) external view returns (uint256 beats, uint256 lastAt) {
        return (personalBeats[account], lastPulseAt[account]);
    }

    /// @dev Catch transfer, transferFrom, and burn. Skip mint so genesis supply is not a beat.
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from != address(0) && value > 0) {
            pulseCount += 1;
            personalBeats[from] += 1;
            lastPulseAt[from] = block.timestamp;
            emit PulseEvent(from, value, pulseCount);
        }
    }
}
