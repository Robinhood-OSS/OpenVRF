// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {OpenVRF, IRandomnessConsumer} from "./OpenVRF.sol";

/// @dev Constructor-based example; a proxy consumer must store the router in its initializer.
abstract contract RandomnessConsumer is IRandomnessConsumer {
    OpenVRF public immutable randomnessRouter;

    constructor(OpenVRF router) {
        require(address(router).code.length > 0, "Invalid router");
        randomnessRouter = router;
    }

    function rawFulfillRandomness(uint256 id, uint256 word) external {
        require(msg.sender == address(randomnessRouter), "Only router");
        _fulfillRandomness(id, word);
    }

    function _fulfillRandomness(uint256 id, uint256 word) internal virtual;
}
