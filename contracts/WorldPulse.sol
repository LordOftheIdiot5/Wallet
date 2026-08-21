pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

contract WorldPulse is Initializable, ERC20Upgradeable {
    /// @notice Number of token movements (transfers and burns), excluding mints.
    uint256 public pulseCount;
    uint256[49] private __gap;

    event PulseEvent(address indexed sender, uint256 amount, uint256 pulseCount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize() public initializer {
        __ERC20_init("WorldPulse", "WPU");
        _mint(msg.sender, 1_000_000 * 10 ** 18);
    }

    /// @dev Catch transfer, transferFrom, and burn. Skip mint so the initial
    /// supply does not count as spending.
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from != address(0) && value > 0) {
            pulseCount += 1;
            emit PulseEvent(from, value, pulseCount);
        }
    }
}
