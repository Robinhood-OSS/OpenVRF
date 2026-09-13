// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import {RandomnessConsumer} from "./RandomnessConsumer.sol";
import {OpenVRF} from "./OpenVRF.sol";

/// @notice Minimal callback demonstration. Add application-specific access control before sponsoring requests.
contract ExampleConsumer is RandomnessConsumer {
    mapping(uint256 => uint256) public results;
    mapping(uint256 => bool) public received;

    constructor(OpenVRF router) RandomnessConsumer(router) {}

    function request() external payable returns (uint256) {
        return randomnessRouter.requestRandomness{value: msg.value}(100_000);
    }

    function _fulfillRandomness(uint256 id, uint256 word) internal override {
        results[id] = word;
        received[id] = true;
    }
}
