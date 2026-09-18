// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {OpenVRF} from "../src/OpenVRF.sol";
import {ExampleConsumer} from "../src/ExampleConsumer.sol";

interface ExampleBroadcastVm {
    function envAddress(string calldata name) external returns (address);
    function startBroadcast(address signer) external;
    function stopBroadcast() external;
}

/// @notice Deploy only ExampleConsumer against the existing configured router.
contract DeployWithExample {
    function run() external returns (ExampleConsumer consumer) {
        ExampleBroadcastVm vm = ExampleBroadcastVm(address(uint160(uint256(keccak256("hevm cheat code")))));
        address deployer = vm.envAddress("DEPLOYER_ADDRESS");
        OpenVRF router = OpenVRF(vm.envAddress("ROUTER_ADDRESS"));
        require(address(router).code.length != 0, "Router has no code");
        require(router.owner() == deployer, "Deployer must own existing router");
        vm.startBroadcast(deployer);
        consumer = new ExampleConsumer(router);
        router.setConsumerAuthorization(address(consumer), true);
        vm.stopBroadcast();
        require(router.authorizedConsumers(address(consumer)), "Consumer not authorized");
        require(address(consumer.randomnessRouter()) == address(router), "Consumer router mismatch");
    }
}
