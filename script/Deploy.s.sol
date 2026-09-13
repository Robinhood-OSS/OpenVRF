// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import {OpenVRF} from "../src/OpenVRF.sol";

interface BroadcastVm {
    function envAddress(string calldata name) external returns (address);
    function envOr(string calldata name, uint256 defaultValue) external returns (uint256);
    function startBroadcast() external;
    function stopBroadcast() external;
}

contract Deploy {
    function run() external returns (OpenVRF router) {
        BroadcastVm vm = BroadcastVm(address(uint160(uint256(keccak256("hevm cheat code")))));
        address owner = vm.envAddress("OWNER_ADDRESS");
        address relayer = vm.envAddress("RELAYER_ADDRESS");
        uint256 requestFee = vm.envOr("REQUEST_FEE_WEI", uint256(0));
        vm.startBroadcast();
        router = new OpenVRF(owner, relayer, requestFee);
        vm.stopBroadcast();
    }
}
