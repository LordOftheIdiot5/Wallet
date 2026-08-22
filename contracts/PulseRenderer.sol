// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/utils/Base64.sol";

interface IWorldPulse {
    function personalBeats(address) external view returns (uint256);
    function lastPulseAt(address) external view returns (uint256);
    function streak(address) external view returns (uint32);
    function pulseCount() external view returns (uint256);
    function uniqueSenders() external view returns (uint32);
    function networkLastPulseAt() external view returns (uint256);
}

/// @title PulseRenderer
/// @notice Draws an address's pulse as an ECG, entirely on chain.
/// @dev Deliberately a separate contract rather than part of WorldPulse. The
///      token is already close to the 24kB code limit, string building is bulky,
///      and a renderer that reads through an interface can be redeployed or
///      replaced without touching the proxy holding everyone's balances.
contract PulseRenderer {
    using Strings for uint256;

    IWorldPulse public immutable pulse;

    uint256 private constant DAY = 86400;
    uint256 private constant WIDTH = 600;
    uint256 private constant HEIGHT = 200;
    uint256 private constant BASELINE = 120;

    constructor(address pulse_) {
        require(pulse_ != address(0), "PulseRenderer: token required");
        pulse = IWorldPulse(pulse_);
    }

    /// @notice A simplified reading of the same model the wallet uses. It works
    ///         from recency and rhythm only, because share-of-holdings is not
    ///         worth the gas to reconstruct here.
    function readingOf(address account)
        public
        view
        returns (uint256 bpm, string memory state, uint256 beats, uint256 sinceLast)
    {
        beats = pulse.personalBeats(account);
        uint256 last = pulse.lastPulseAt(account);
        sinceLast = last == 0 ? 0 : block.timestamp - last;

        if (beats == 0 || last == 0) {
            return (48, "dormant", beats, 0);
        }
        if (sinceLast > 14 * DAY) {
            return (48, "dormant", beats, sinceLast);
        }
        if (sinceLast > 2 * DAY) {
            return (56, "still", beats, sinceLast);
        }
        // streak arrived after emission did, so a proxy on an older
        // implementation has no such function. Read it defensively rather than
        // making the renderer refuse to draw anything at all.
        uint256 bonus = 0;
        try pulse.streak(account) returns (uint32 current) {
            bonus = current;
        } catch {
            bonus = 0;
        }
        if (bonus > 6) {
            bonus = 6;
        }
        return (62 + bonus * 4, "steady", beats, sinceLast);
    }

    /// @notice The ECG trace as an SVG polyline, spikes spaced by BPM.
    function renderSVG(address account) public view returns (string memory) {
        (uint256 bpm, string memory state, uint256 beats, uint256 sinceLast) = readingOf(account);
        // Faster pulse, more spikes across the same width.
        uint256 spikes = bpm / 14;
        if (spikes < 3) {
            spikes = 3;
        }
        string memory colour = _colourFor(state);

        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 200" width="600" height="200">',
            '<rect width="600" height="200" fill="#070b16"/>',
            '<polyline fill="none" stroke="', colour, '" stroke-width="3" stroke-linejoin="round" points="',
            _trace(spikes),
            '"/>',
            '<text x="20" y="34" fill="#eaf3ff" font-family="monospace" font-size="18">',
            _short(account),
            '</text>',
            '<text x="20" y="176" fill="', colour, '" font-family="monospace" font-size="22">',
            bpm.toString(), ' BPM &#183; ', state,
            '</text>',
            '<text x="580" y="176" fill="#8ea0c4" font-family="monospace" font-size="14" text-anchor="end">',
            beats.toString(), ' beats', _ageSuffix(beats, sinceLast),
            '</text>',
            '</svg>'
        );
    }

    /// @notice The same image as a data URI, for anywhere that wants one string.
    function renderDataURI(address account) external view returns (string memory) {
        return string.concat(
            "data:image/svg+xml;base64,",
            Base64.encode(bytes(renderSVG(account)))
        );
    }

    function _colourFor(string memory state) private pure returns (string memory) {
        bytes32 s = keccak256(bytes(state));
        if (s == keccak256("dormant")) {
            return "#8ea0c4";
        }
        if (s == keccak256("still")) {
            return "#e0c35a";
        }
        return "#3ee0c5";
    }

    /// @dev Flat line with evenly spaced QRS complexes: small dip, tall spike,
    ///      deeper dip, back to baseline.
    function _trace(uint256 spikes) private pure returns (string memory points) {
        uint256 step = WIDTH / (spikes + 1);
        points = "0,120";
        for (uint256 i = 1; i <= spikes; i++) {
            uint256 x = step * i;
            points = string.concat(
                points, " ",
                (x - 14).toString(), ",120 ",
                (x - 9).toString(), ",134 ",
                x.toString(), ",44 ",
                (x + 9).toString(), ",150 ",
                (x + 16).toString(), ",120"
            );
        }
        return string.concat(points, " 600,120");
    }

    function _ageSuffix(uint256 beats, uint256 sinceLast) private pure returns (string memory) {
        if (beats == 0 || sinceLast == 0) {
            return "";
        }
        if (sinceLast < 3600) {
            return string.concat(" &#183; ", (sinceLast / 60).toString(), "m ago");
        }
        if (sinceLast < DAY) {
            return string.concat(" &#183; ", (sinceLast / 3600).toString(), "h ago");
        }
        return string.concat(" &#183; ", (sinceLast / DAY).toString(), "d ago");
    }

    function _short(address account) private pure returns (string memory) {
        bytes memory full = bytes(Strings.toHexString(uint160(account), 20));
        bytes memory out = new bytes(13);
        for (uint256 i = 0; i < 6; i++) {
            out[i] = full[i];
        }
        out[6] = ".";
        out[7] = ".";
        out[8] = ".";
        for (uint256 i = 0; i < 4; i++) {
            out[9 + i] = full[38 + i];
        }
        return string(out);
    }
}
