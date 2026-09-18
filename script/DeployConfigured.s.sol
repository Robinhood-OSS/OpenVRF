// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {OpenVRF} from "../src/OpenVRF.sol";

interface ConfiguredBroadcastVm {
    function envAddress(string calldata name) external returns (address);
    function envOr(string calldata name, uint256 defaultValue) external returns (uint256);
    function envOr(string calldata name, address defaultValue) external returns (address);
    function startBroadcast(address signer) external;
    function stopBroadcast() external;
}

/// @notice Deploy only the router and optionally authorize an existing consumer.
contract DeployConfigured {
    function run() external returns (OpenVRF router) {
        ConfiguredBroadcastVm vm = ConfiguredBroadcastVm(address(uint160(uint256(keccak256("hevm cheat code")))));
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        address owner = vm.envAddress("OWNER_ADDRESS");
        address relayer = vm.envAddress("RELAYER_ADDRESS");
        require(owner == deployer, "Owner must be deployer to authorize consumer");
        uint256 fee = vm.envOr("REQUEST_FEE_WEI", uint256(0));
        address consumer = vm.envOr("CONSUMER_ADDRESS", address(0));
        vm.startBroadcast(deployer);
        router = new OpenVRF(owner, relayer, fee); // Constructor authorizes the initial relayer.
        if (consumer != address(0)) router.setConsumerAuthorization(consumer, true);
        vm.stopBroadcast();
        require(router.owner() == owner, "Owner mismatch");
        require(router.authorizedRelayers(relayer), "Relayer not authorized");
        if (consumer != address(0)) require(router.authorizedConsumers(consumer), "Consumer not authorized");
    }
}
