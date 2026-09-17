// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;
import {OpenVRF} from "../src/OpenVRF.sol";
import {RandomnessConsumer} from "../src/RandomnessConsumer.sol";
import {ExampleConsumer} from "../src/ExampleConsumer.sol";

interface Vm {
    function warp(uint256) external;
    function deal(address, uint256) external;
    function etch(address, bytes calldata) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
}

contract TestConsumer is RandomnessConsumer {
    uint256 public calls;
    uint256 public word;
    uint256 public mode;
    constructor(OpenVRF router) RandomnessConsumer(router) {}

    function setMode(uint256 value) external {
        mode = value;
    }

    function request(uint32 gasLimit) external payable returns (uint256) {
        return randomnessRouter.requestRandomness{value: msg.value}(gasLimit);
    }

    function _fulfillRandomness(uint256 id, uint256 value) internal override {
        if (mode == 1) revert("Consumer unavailable");
        if (mode == 2) assembly { for {} 1 {} {} }
        if (mode == 3) {
            // Reentrant delivery must fail without disrupting the outer callback.
            (bool ok,) =
                address(randomnessRouter).call(abi.encodeCall(randomnessRouter.retryCallback, (id, 100_000)));
            require(!ok, "Reentrant delivery succeeded");
        }
        calls++;
        word = value;
        if (mode == 4) assembly { return(0, 1000000) }
    }
}

contract RejectEther {
    function fulfill(OpenVRF router, uint256 id, bytes calldata signature) external {
        router.fulfill(id, signature);
    }

    receive() external payable {
        revert("reject");
    }
}

contract EtherSniper {
    function destroy(address payable target) external payable {
        selfdestruct(target);
    }
}

contract EphemeralConsumer is RandomnessConsumer {
    uint256 public calls;
    constructor(OpenVRF router) RandomnessConsumer(router) {}

    function request(uint32 gasLimit) external payable returns (uint256) {
        return randomnessRouter.requestRandomness{value: msg.value}(gasLimit);
    }

    function _fulfillRandomness(uint256, uint256) internal override {
        calls++;
    }
}

// A consumer that is also the router owner, probing withdrawFees from inside its own callback.
contract OwnerConsumer is RandomnessConsumer {
    bool public lockHeld;
    constructor(OpenVRF router) RandomnessConsumer(router) {}

    function request(uint32 gasLimit) external payable returns (uint256) {
        return randomnessRouter.requestRandomness{value: msg.value}(gasLimit);
    }

    function _fulfillRandomness(uint256, uint256) internal override {
        (bool ok, bytes memory data) =
            address(randomnessRouter).call(abi.encodeCall(randomnessRouter.withdrawFees, (payable(address(this)), 1)));
        require(!ok && data.length == 4, "Reentrant withdrawal succeeded");
        bytes4 selector;
        assembly {
            selector := mload(add(data, 32))
        }
        lockHeld = selector == OpenVRF.ReentrantDelivery.selector;
    }
}

contract OpenVRFTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant ROUND_TIME = 1727521075 + 999 * 3;
    // Immutable fixture: public evmnet round 1000, fetched from api.drand.sh.
    bytes constant SIGNATURE =
        hex"06fd5996329504d3a56b482d9222bf7205857d0a9559ddd216ca31a286f6a8cc0a120f021aac2f13553fb164f62bc3a5ca32c76dea88a777b39bcf3cac5fdbd6";
    bytes32 constant RANDOMNESS = 0x0e6745667465a6f9dce5d5f994656955080be14c469ff17fc4fc588c925a8504;
    OpenVRF router;
    TestConsumer consumer;

    receive() external payable {}

    function setUp() public {
        vm.warp(ROUND_TIME - 4);
        router = new OpenVRF(address(this), address(0x1234), 0);
        consumer = new TestConsumer(router);
        router.setConsumerAuthorization(address(consumer), true);
    }

    function testRealDrandProofAndCallback() public {
        uint256 id = consumer.request(100_000);
        (, uint64 round,,,,,) = router.requests(id);
        require(round == 1000, "Wrong future round");
        vm.warp(ROUND_TIME);
        vm.prank(address(0x1234));
        router.fulfill(id, SIGNATURE);
        require(router.roundRandomness(round) == RANDOMNESS, "Wrong beacon hash");
        (,,, bool fulfilled, bool delivered, uint256 word,) = router.requests(id);
        uint256 expected = uint256(
            keccak256(
                abi.encode(
                    router.CHAIN_HASH(), RANDOMNESS, block.chainid, address(router), id, address(consumer)
                )
            )
        );
        require(
            fulfilled && delivered && consumer.calls() == 1 && word == expected && consumer.word() == word,
            "Bad callback"
        );
    }

    function testConsumerAndRelayerAuthorizationLifecycle() public {
        uint256 id = consumer.request(100_000);
        router.setConsumerAuthorization(address(consumer), false);
        vm.expectRevert(OpenVRF.UnauthorizedConsumer.selector);
        consumer.request(100_000);

        vm.warp(ROUND_TIME);
        router.setRelayerAuthorization(address(0x1234), false);
        vm.expectRevert(OpenVRF.UnauthorizedRelayer.selector);
        vm.prank(address(0x1234));
        router.fulfill(id, SIGNATURE);

        // Consumer removal never invalidates an existing request; the owner is an emergency relayer.
        router.fulfill(id, SIGNATURE);
        require(consumer.calls() == 1, "Existing request was invalidated");
    }

    function testExactStoredFeeAndDirectRelayerPayment() public {
        uint256 fee = 0.001 ether;
        address relayer = address(0x1234);
        router.setRequestFee(fee);
        vm.deal(address(this), fee * 2);

        vm.expectRevert(OpenVRF.IncorrectFee.selector);
        consumer.request(100_000);
        vm.expectRevert(OpenVRF.IncorrectFee.selector);
        consumer.request{value: fee + 1}(100_000);

        uint256 id = consumer.request{value: fee}(100_000);
        require(address(router).balance == fee, "Fee not collected");
        (,,,,,, uint256 storedFee) = router.requests(id);
        require(storedFee == fee, "Request fee not stored");

        vm.warp(ROUND_TIME);
        uint256 beforeBalance = relayer.balance;
        vm.prank(relayer);
        router.fulfill(id, SIGNATURE);
        (,,,,,, storedFee) = router.requests(id);
        require(storedFee == 0, "Delivered request kept fee");
        require(relayer.balance == beforeBalance + fee && address(router).balance == 0, "Bad direct payment");
    }

    function testFeeIsFixedPerRequestAndPaidDirectly() public {
        uint256 firstFee = 0.001 ether;
        uint256 secondFee = 0.002 ether;
        address relayer = address(0x1234);
        vm.deal(address(this), firstFee + secondFee);
        router.setRequestFee(firstFee);
        uint256 firstId = consumer.request{value: firstFee}(100_000);
        router.setRequestFee(secondFee);
        uint256 secondId = consumer.request{value: secondFee}(100_000);
        (,,,,,, uint256 storedFirstFee) = router.requests(firstId);
        (,,,,,, uint256 storedSecondFee) = router.requests(secondId);
        require(storedFirstFee == firstFee && storedSecondFee == secondFee, "Fee changed retroactively");
        vm.warp(ROUND_TIME);
        vm.startPrank(relayer);
        router.fulfill(firstId, SIGNATURE);
        router.fulfill(secondId, SIGNATURE);
        vm.stopPrank();
        require(relayer.balance == firstFee + secondFee, "Stored fees were not paid directly");
    }

    function testRejectedDirectPaymentLeavesRequestPending() public {
        uint256 fee = 0.001 ether;
        router.setRequestFee(fee);
        vm.deal(address(this), fee);
        uint256 id = consumer.request{value: fee}(100_000);
        RejectEther relayer = new RejectEther();
        router.setRelayerAuthorization(address(relayer), true);
        vm.warp(ROUND_TIME);
        vm.expectRevert(OpenVRF.WithdrawalFailed.selector);
        relayer.fulfill(router, id, SIGNATURE);
        (,,, bool fulfilled,,, uint256 storedFee) = router.requests(id);
        require(!fulfilled && storedFee == fee, "Failed payment changed request");
    }

    function testReservedFeesCannotBeWithdrawnBeforeFulfillment() public {
        uint256 fee = 0.001 ether;
        address relayer = address(0x1234);
        router.setRequestFee(fee);
        vm.deal(address(this), fee);
        uint256 id = consumer.request{value: fee}(100_000);
        require(router.reservedFees() == fee, "Fee not reserved");
        vm.expectRevert(OpenVRF.WithdrawalFailed.selector);
        router.withdrawFees(payable(address(this)), fee);
        vm.warp(ROUND_TIME);
        uint256 beforeBalance = relayer.balance;
        vm.prank(relayer);
        router.fulfill(id, SIGNATURE);
        require(router.reservedFees() == 0, "Reservation not released");
        require(relayer.balance == beforeBalance + fee && address(router).balance == 0, "Reserved fee not paid");
    }

    function testOwnerWithdrawsOnlyUnreservedExcess() public {
        uint256 fee = 0.001 ether;
        router.setRequestFee(fee);
        vm.deal(address(this), fee * 2);
        uint256 id = consumer.request{value: fee}(100_000);
        new EtherSniper().destroy{value: fee}(payable(address(router)));
        require(address(router).balance == fee * 2, "Forced ether missing");
        vm.expectRevert(OpenVRF.WithdrawalFailed.selector);
        router.withdrawFees(payable(address(this)), fee + 1);
        uint256 beforeBalance = address(this).balance;
        router.withdrawFees(payable(address(this)), fee);
        require(
            address(router).balance == fee && address(this).balance == beforeBalance + fee, "Bad excess recovery"
        );
        vm.warp(ROUND_TIME);
        router.fulfill(id, SIGNATURE);
        require(address(router).balance == 0 && router.reservedFees() == 0, "Reserved fee not paid");
    }

    function testWithdrawFeesSharesDeliveryLock() public {
        OpenVRF ownedRouter = new OpenVRF(address(this), address(0x1234), 0);
        OwnerConsumer ownerConsumer = new OwnerConsumer(ownedRouter);
        ownedRouter.setConsumerAuthorization(address(ownerConsumer), true);
        ownedRouter.transferOwnership(address(ownerConsumer));
        uint256 id = ownerConsumer.request(100_000);
        vm.warp(ROUND_TIME);
        vm.prank(address(0x1234));
        ownedRouter.fulfill(id, SIGNATURE);
        require(ownerConsumer.lockHeld(), "withdrawFees bypassed the delivery lock");
    }

    function testOwnerTransferMovesEmergencyAuthority() public {
        address newOwner = address(0xBEEF);
        router.transferOwnership(newOwner);
        require(router.owner() == newOwner, "Ownership not transferred");

        vm.expectRevert();
        router.setRequestFee(1);
        vm.prank(newOwner);
        router.setRequestFee(1);
        require(router.requestFee() == 1, "New owner lacks administration");
    }

    function testRejectsInvalidAuthorizationAccounts() public {
        vm.expectRevert(OpenVRF.InvalidAccount.selector);
        router.setConsumerAuthorization(address(0), true);
        vm.expectRevert(OpenVRF.InvalidAccount.selector);
        router.setRelayerAuthorization(address(0), true);
        vm.expectRevert(OpenVRF.InvalidAccount.selector);
        router.withdrawFees(payable(address(0)), 0);
    }

    function testCannotFulfillEarlyOrWithWrongRound() public {
        uint256 id = consumer.request(100_000);
        vm.expectRevert(OpenVRF.NotReady.selector);
        router.fulfill(id, SIGNATURE);
        vm.warp(ROUND_TIME + 3);
        vm.expectRevert();
        router.proveRound(SIGNATURE, 1001);
    }

    function testBadSignatureLeavesRequestPending() public {
        uint256 id = consumer.request(100_000);
        vm.warp(ROUND_TIME);
        bytes memory wrong = SIGNATURE;
        wrong[0] = 0;
        vm.expectRevert();
        router.fulfill(id, wrong);
        (,,, bool fulfilled,,,) = router.requests(id);
        require(!fulfilled, "Invalid proof accepted");
        vm.expectRevert();
        router.fulfill(id, hex"1234");
    }

    function testNoDuplicateCallback() public {
        uint256 id = consumer.request(100_000);
        vm.warp(ROUND_TIME);
        router.fulfill(id, SIGNATURE);
        vm.expectRevert(OpenVRF.AlreadyFulfilled.selector);
        router.fulfill(id, SIGNATURE);
        vm.expectRevert(OpenVRF.InvalidCallback.selector);
        router.retryCallback(id, 100_000);
    }

    function testRevertedCallbackCanRetrySameResult() public {
        uint256 fee = 0.001 ether;
        address retryRelayer = address(0xBEEF);
        router.setRequestFee(fee);
        vm.deal(address(this), fee);
        uint256 id = consumer.request{value: fee}(100_000);
        consumer.setMode(1);
        vm.warp(ROUND_TIME);
        router.fulfill(id, SIGNATURE);
        (,,, bool fulfilled, bool delivered, uint256 word,) = router.requests(id);
        require(fulfilled && !delivered, "Proof lost on callback revert");
        require(address(this).balance == fee, "Proof relayer did not receive fee");
        consumer.setMode(0);
        router.setRelayerAuthorization(address(0x1234), false);
        vm.expectRevert(OpenVRF.UnauthorizedRelayer.selector);
        vm.prank(address(0x1234));
        router.retryCallback(id, 150_000);
        router.setRelayerAuthorization(retryRelayer, true);
        vm.prank(retryRelayer);
        router.retryCallback(id, 150_000);
        require(consumer.calls() == 1 && consumer.word() == word, "Retry changed result");
        require(retryRelayer.balance == 0, "Retry relayer took proof fee");
    }

    function testFirstProofRelayerEarnsFeeAndAuthorizedRaceCannotChangeIt() public {
        uint256 fee = 0.001 ether;
        address firstRelayer = address(0x1234);
        address secondRelayer = address(0xBEEF);
        router.setRelayerAuthorization(secondRelayer, true);
        router.setRequestFee(fee);
        vm.deal(address(this), fee);
        uint256 id = consumer.request{value: fee}(100_000);
        vm.warp(ROUND_TIME);
        vm.prank(firstRelayer);
        router.fulfill(id, SIGNATURE);
        vm.expectRevert(OpenVRF.AlreadyFulfilled.selector);
        vm.prank(secondRelayer);
        router.fulfill(id, SIGNATURE);
        require(firstRelayer.balance == fee, "First proof relayer lost fee");
        require(secondRelayer.balance == 0, "Losing relayer earned fee");
    }

    function testZeroFeeProofAndCallbackCreateNoClaim() public {
        uint256 id = consumer.request(100_000);
        vm.warp(ROUND_TIME);
        vm.prank(address(0x1234));
        router.fulfill(id, SIGNATURE);
        require(address(0x1234).balance == 0, "Zero-fee request created payment");
        (,,,,,, uint256 storedFee) = router.requests(id);
        require(storedFee == 0, "Zero-fee request retained value");
    }

    function testOutOfGasCallbackPreservesProof() public {
        uint256 id = consumer.request(100_000);
        consumer.setMode(2);
        vm.warp(ROUND_TIME);
        router.fulfill(id, SIGNATURE);
        (,,, bool fulfilled, bool delivered,,) = router.requests(id);
        require(fulfilled && !delivered, "Out of gas discarded proof");
        consumer.setMode(0);
        router.retryCallback(id, 100_000);
        require(consumer.calls() == 1, "Retry failed");
    }

    function testDestroyedConsumerStaysRetryable() public {
        EphemeralConsumer ephemeral = new EphemeralConsumer(router);
        router.setConsumerAuthorization(address(ephemeral), true);
        uint256 id = ephemeral.request(100_000);
        // Simulate a selfdestructed consumer: the address persists but holds no code.
        vm.etch(address(ephemeral), "");
        require(address(ephemeral).code.length == 0, "Consumer not destroyed");
        vm.warp(ROUND_TIME);
        router.fulfill(id, SIGNATURE);
        (,,, bool fulfilled, bool delivered,,) = router.requests(id);
        require(fulfilled && !delivered, "Destroyed consumer recorded as delivered");
        router.retryCallback(id, 100_000);
        (,,,, delivered,,) = router.requests(id);
        require(!delivered, "Retry to destroyed consumer delivered");
    }

    function testIncreaseCallbackGasAfterFailure() public {
        uint256 id = consumer.request(25_000);
        vm.warp(ROUND_TIME);
        router.fulfill(id, SIGNATURE);
        (,,, bool fulfilled, bool delivered, uint256 word,) = router.requests(id);
        require(fulfilled && !delivered, "Expected insufficient callback gas");
        router.retryCallback(id, 100_000);
        require(consumer.calls() == 1 && consumer.word() == word, "Larger gas retry failed");
    }

    function testUnderfundedDeliveryRevertsWithoutPartialState() public {
        uint256 id = consumer.request(1_000_000);
        vm.warp(ROUND_TIME);
        (bool success,) = address(router).call{gas: 500_000}(abi.encodeCall(router.fulfill, (id, SIGNATURE)));
        require(!success, "Underfunded delivery accepted");
        (,,, bool fulfilled, bool delivered,,) = router.requests(id);
        require(!fulfilled && !delivered, "Partial state committed");
        router.fulfill(id, SIGNATURE);
        require(consumer.calls() == 1, "Properly funded delivery failed");
    }

    function testReturnDataCannotExhaustRouter() public {
        uint256 id = consumer.request(1_000_000);
        consumer.setMode(4);
        vm.warp(ROUND_TIME);
        router.fulfill(id, SIGNATURE);
        (,,, bool fulfilled,,,) = router.requests(id);
        require(fulfilled, "Return data discarded proof");
    }

    function testReentrantCallbackAndUnauthorizedCaller() public {
        vm.expectRevert();
        consumer.rawFulfillRandomness(1, 42);
        uint256 id = consumer.request(100_000);
        router.setRelayerAuthorization(address(consumer), true);
        consumer.setMode(3);
        vm.warp(ROUND_TIME);
        router.fulfill(id, SIGNATURE);
        require(consumer.calls() == 1, "Callback not delivered once");
    }

    function testInvalidRequestsAndRetries() public {
        vm.expectRevert(OpenVRF.UnauthorizedConsumer.selector);
        vm.prank(address(0x1234));
        router.requestRandomness(100_000);
        vm.expectRevert(OpenVRF.InvalidRequest.selector);
        consumer.request(0);
        vm.expectRevert(OpenVRF.InvalidRequest.selector);
        consumer.request(1_000_001);
        vm.expectRevert(OpenVRF.InvalidRequest.selector);
        router.fulfill(999, SIGNATURE);
        vm.expectRevert(OpenVRF.InvalidCallback.selector);
        router.retryCallback(999, 100_000);
    }

    function testRequestsHaveDistinctWords() public {
        uint256 a = consumer.request(100_000);
        uint256 b = consumer.request(100_000);
        vm.warp(ROUND_TIME);
        router.fulfill(a, SIGNATURE);
        router.fulfill(b, SIGNATURE);
        (,,,,, uint256 first,) = router.requests(a);
        (,,,,, uint256 second,) = router.requests(b);
        require(first != second, "Domain separation failed");
    }

    function testFuzzFutureRound(uint32 offset) public {
        uint256 timestamp = router.GENESIS() + offset;
        vm.warp(timestamp);
        uint256 id = consumer.request(100_000);
        (, uint64 round,,,,,) = router.requests(id);
        uint256 availableAt = router.GENESIS() + (uint256(round) - 1) * 3;
        require(availableAt > timestamp + 3 && availableAt <= timestamp + 6, "Bad round boundary");
    }

    function testSecondFutureRoundAtEveryPeriodBoundary() public {
        for (uint256 offset = 0; offset < 3; offset++) {
            uint256 timestamp = router.GENESIS() + 300 + offset;
            vm.warp(timestamp);
            uint256 id = consumer.request(100_000);
            (, uint64 round,,,,,) = router.requests(id);
            require(round == 103, "Must select second future round");
            uint256 availableAt = router.GENESIS() + (uint256(round) - 1) * 3;
            require(availableAt - timestamp == 6 - offset, "Incorrect lead time");
        }
    }

    function testLiveRoundReferenceVectors() public {
        // Public API fixtures from the three successful Robinhood smoke-test rounds.
        // https://api.drand.sh/<CHAIN_HASH>/public/<round>
        uint64[3] memory rounds = [uint64(20395695), uint64(20395697), uint64(20395701)];
        bytes[3] memory signatures = [
            bytes(
                hex"06cc13be3c0bd4f606951704eef794a8949fdf30f6fffa6a8b124f65a39a1d9e10284d65ca123945945f11e30ef4b7cc26004ad4efe3d15702bd421bae12be57"
            ),
            bytes(
                hex"265f9af5b5f4b191ea7a524959949f27804d68bbfa48aa946d12a9becc05b3bc26eb14fb7a10633ad0ae0f341aa2e746585c89d4edc9ece6fe10df80a691e17b"
            ),
            bytes(
                hex"11f66d48523a18df7cbbf95b524db1be8355276b9fe00b77a0447a4c6c2203d5114b283a0e91b29a400364d231a6a0e33603bd4861de4e89f5ee7e377e424e71"
            )
        ];
        bytes32[3] memory hashes = [
            bytes32(0xbe294246aba0dbfd05169da53975ea06d4230c64e862e7ff5255bcc8d51e2df3),
            bytes32(0x7e7e8d2495466ba35b921c7a23da72180049e209aea5b1bc5dd099935332a2d0),
            bytes32(0xf13db743f07d6a6ceb967fbe2897dbbc4dc92a613744d91b77527017c00c047b)
        ];
        for (uint256 i; i < rounds.length; i++) {
            uint256 target = router.GENESIS() + (uint256(rounds[i]) - 1) * router.PERIOD();
            vm.warp(target - 4);
            uint256 id = consumer.request(100_000);
            (, uint64 selected,,,,,) = router.requests(id);
            require(selected == rounds[i], "Fixture round mismatch");
            vm.warp(target);
            router.fulfill(id, signatures[i]);
            require(router.roundRandomness(selected) == hashes[i], "Reference hash mismatch");
            (,,, bool fulfilled, bool delivered, uint256 word,) = router.requests(id);
            require(fulfilled && delivered && consumer.word() == word, "Fixture callback mismatch");
        }
        require(consumer.calls() == 3, "Missing fixture callback");
    }

    function testOutOfOrderDeliveryMapsToCorrectRequest() public {
        ExampleConsumer example = new ExampleConsumer(router);
        router.setConsumerAuthorization(address(example), true);
        uint256 first = example.request();
        uint256 second = example.request();
        vm.warp(ROUND_TIME);
        router.fulfill(second, SIGNATURE);
        require(!example.received(first) && example.received(second), "Wrong request delivered");
        router.fulfill(first, SIGNATURE);
        (,,,,, uint256 firstWord,) = router.requests(first);
        (,,,,, uint256 secondWord,) = router.requests(second);
        require(example.results(first) == firstWord && example.results(second) == secondWord, "Mixed results");
    }

    function testDifferentConsumersReceiveDistinctWords() public {
        ExampleConsumer a = new ExampleConsumer(router);
        ExampleConsumer b = new ExampleConsumer(router);
        router.setConsumerAuthorization(address(a), true);
        router.setConsumerAuthorization(address(b), true);
        uint256 first = a.request();
        uint256 second = b.request();
        vm.warp(ROUND_TIME);
        router.fulfill(first, SIGNATURE);
        router.fulfill(second, SIGNATURE);
        require(a.received(first) && b.received(second), "Missing consumer delivery");
        require(!a.received(second) && !b.received(first), "Cross-consumer delivery");
        require(a.results(first) != b.results(second), "Equal derived words");
    }

    function testDifferentRoutersReceiveDistinctWords() public {
        OpenVRF otherRouter = new OpenVRF(address(this), address(0x1234), 0);
        ExampleConsumer a = new ExampleConsumer(router);
        ExampleConsumer b = new ExampleConsumer(otherRouter);
        router.setConsumerAuthorization(address(a), true);
        otherRouter.setConsumerAuthorization(address(b), true);
        uint256 first = a.request();
        uint256 second = b.request();
        require(first == second, "Expected matching local IDs");
        vm.warp(ROUND_TIME);
        router.fulfill(first, SIGNATURE);
        otherRouter.fulfill(second, SIGNATURE);
        require(a.results(first) != b.results(second), "Equal derived words");
    }

    function testRepeatedRegistryProofKeepsSameBeaconHash() public {
        router.proveRound(SIGNATURE, 1000);
        bytes32 beforeHash = router.roundRandomness(1000);
        router.proveRound(SIGNATURE, 1000);
        require(beforeHash == RANDOMNESS && router.roundRandomness(1000) == beforeHash, "Beacon changed");
    }
}
