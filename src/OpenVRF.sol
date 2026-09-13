// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {EvmnetRegistry} from "bls-solidity/demos/EvmnetRegistry.sol";
import {Ownable} from "openzeppelin-contracts/access/Ownable.sol";

interface IRandomnessConsumer {
    function rawFulfillRandomness(uint256 requestId, uint256 randomWord) external;
}

/// @notice Drand evmnet verification with authorized consumers and relayers.
/// @dev The owner manages access and fees but cannot alter, cancel, or redraw a request.
contract OpenVRF is EvmnetRegistry, Ownable {
    uint256 public constant GENESIS = 1727521075;
    uint256 public constant PERIOD = 3;
    uint256 public constant MIN_DELAY = PERIOD;
    uint32 public constant MAX_CALLBACK_GAS = 1_000_000;
    bytes32 public constant CHAIN_HASH = 0x04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3;

    struct Request {
        address consumer;
        uint64 round;
        uint32 callbackGasLimit;
        bool fulfilled;
        bool delivered;
        uint256 randomWord;
        uint256 fee;
    }

    uint256 public nextRequestId = 1;
    uint256 public requestFee;
    mapping(uint256 => Request) public requests;
    mapping(address => bool) public authorizedConsumers;
    mapping(address => bool) public authorizedRelayers;
    bool private delivering;

    event ConsumerAuthorizationUpdated(address indexed consumer, bool authorized);
    event RelayerAuthorizationUpdated(address indexed relayer, bool authorized);
    event RequestFeeUpdated(uint256 oldFee, uint256 newFee);
    event FeesWithdrawn(address indexed recipient, uint256 amount);
    event RelayerFeePaid(uint256 indexed requestId, address indexed relayer, uint256 amount);
    event RandomnessRequested(uint256 indexed requestId, address indexed consumer, uint64 round);
    event RandomnessFulfilled(uint256 indexed requestId, uint256 randomWord);
    event CallbackAttempted(uint256 indexed requestId, bool success);

    error InvalidRequest();
    error NotReady();
    error AlreadyFulfilled();
    error InvalidCallback();
    error InsufficientGas();
    error ReentrantDelivery();
    error UnauthorizedConsumer();
    error UnauthorizedRelayer();
    error InvalidAccount();
    error IncorrectFee();
    error WithdrawalFailed();

    constructor(address initialOwner, address initialRelayer, uint256 initialRequestFee)
        Ownable(initialOwner)
    {
        if (initialRelayer == address(0)) revert InvalidAccount();
        authorizedRelayers[initialRelayer] = true;
        requestFee = initialRequestFee;
        emit RelayerAuthorizationUpdated(initialRelayer, true);
        emit RequestFeeUpdated(0, initialRequestFee);
    }

    modifier onlyRelayer() {
        _checkRelayer();
        _;
    }

    modifier deliveryLock() {
        _beforeDelivery();
        _;
        _afterDelivery();
    }

    function _afterDelivery() private {
        delivering = false;
    }

    function _beforeDelivery() private {
        if (delivering) revert ReentrantDelivery();
        delivering = true;
    }

    function _checkRelayer() private view {
        if (msg.sender != owner() && !authorizedRelayers[msg.sender]) revert UnauthorizedRelayer();
    }

    /// @notice Allows or blocks a consumer from creating new requests.
    /// @dev Existing requests remain valid after the consumer is removed.
    function setConsumerAuthorization(address consumer, bool authorized) external onlyOwner {
        if (consumer == address(0)) revert InvalidAccount();
        authorizedConsumers[consumer] = authorized;
        emit ConsumerAuthorizationUpdated(consumer, authorized);
    }

    /// @notice Allows or blocks a hot relayer account from fulfilling requests.
    /// @dev The current owner is always an emergency relayer without a mapping entry.
    function setRelayerAuthorization(address relayer, bool authorized) external onlyOwner {
        if (relayer == address(0)) revert InvalidAccount();
        authorizedRelayers[relayer] = authorized;
        emit RelayerAuthorizationUpdated(relayer, authorized);
    }

    /// @notice Sets the exact native-token fee required for each new request.
    function setRequestFee(uint256 newFee) external onlyOwner {
        uint256 oldFee = requestFee;
        requestFee = newFee;
        emit RequestFeeUpdated(oldFee, newFee);
    }

    /// @notice Emergency recovery of native tokens by the owner.
    /// @dev This can withdraw fees reserved for pending requests and make their fulfillment fail.
    function withdrawFees(address payable recipient, uint256 amount) external onlyOwner {
        if (recipient == address(0)) revert InvalidAccount();
        (bool success,) = recipient.call{value: amount}("");
        if (!success) revert WithdrawalFailed();
        emit FeesWithdrawn(recipient, amount);
    }

    function requestRandomness(uint32 callbackGasLimit) external payable returns (uint256 id) {
        if (!authorizedConsumers[msg.sender]) revert UnauthorizedConsumer();
        if (msg.value != requestFee) revert IncorrectFee();
        if (msg.sender.code.length == 0 || callbackGasLimit < 25_000 || callbackGasLimit > MAX_CALLBACK_GAS) {
            revert InvalidRequest();
        }
        // Select the second future evmnet round: 4-6 seconds after the block timestamp.
        // Fast mode assumes a fresh timestamp and stable sequencer ordering, not L1 finality.
        uint256 roundValue = (block.timestamp + MIN_DELAY - GENESIS) / PERIOD + 2;
        if (roundValue > type(uint64).max) revert InvalidRequest();
        // Checked against uint64.max immediately above.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 round = uint64(roundValue);
        id = nextRequestId++;
        requests[id] = Request({
            consumer: msg.sender,
            round: round,
            callbackGasLimit: callbackGasLimit,
            fulfilled: false,
            delivered: false,
            randomWord: 0,
            fee: msg.value
        });
        emit RandomnessRequested(id, msg.sender, round);
    }

    function fulfill(uint256 id, bytes calldata signature) external onlyRelayer deliveryLock {
        Request storage request = requests[id];
        if (request.consumer == address(0)) revert InvalidRequest();
        if (request.fulfilled) revert AlreadyFulfilled();
        if (block.timestamp < GENESIS + (uint256(request.round) - 1) * PERIOD) revert NotReady();
        // Inherited registry verifies the pinned evmnet BLS public key and round.
        this.proveRound(signature, request.round);
        request.randomWord = uint256(
            keccak256(
                abi.encode(
                    CHAIN_HASH,
                    roundRandomness[request.round],
                    block.chainid,
                    address(this),
                    id,
                    request.consumer
                )
            )
        );
        request.fulfilled = true;
        emit RandomnessFulfilled(id, request.randomWord);
        if (request.fee != 0) {
            uint256 fee = request.fee;
            request.fee = 0;
            (bool paid,) = payable(msg.sender).call{value: fee}("");
            if (!paid) revert WithdrawalFailed();
            emit RelayerFeePaid(id, msg.sender, fee);
        }
        _deliver(id, request);
    }

    /// @notice Retry the same result after a consumer revert or inadequate callback gas.
    /// @dev An authorized relayer may increase delivery gas; the result and recipient cannot change.
    function retryCallback(uint256 id, uint32 callbackGasLimit) external onlyRelayer deliveryLock {
        Request storage request = requests[id];
        if (
            !request.fulfilled || request.delivered || callbackGasLimit < request.callbackGasLimit
                || callbackGasLimit > MAX_CALLBACK_GAS
        ) revert InvalidCallback();
        request.callbackGasLimit = callbackGasLimit;
        _deliver(id, request);
    }

    function _deliver(uint256 id, Request storage request) private {
        bytes memory payload =
            abi.encodeCall(IRandomnessConsumer.rawFulfillRandomness, (id, request.randomWord));
        uint256 callGas = request.callbackGasLimit;
        address consumer = request.consumer;
        // Reserve gas for post-call storage/events and EIP-150's withheld 1/64.
        if (gasleft() < callGas + callGas / 63 + 60_000) revert InsufficientGas();
        request.delivered = true;
        bool success;
        // Do not copy arbitrary consumer return data into memory.
        assembly {
            success := call(callGas, consumer, 0, add(payload, 32), mload(payload), 0, 0)
        }
        request.delivered = success;
        emit CallbackAttempted(id, success);
    }
}
