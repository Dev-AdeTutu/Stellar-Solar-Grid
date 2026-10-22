// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title SolarGridBridge
 * @notice Target EVM Chain (Ethereum / Polygon / Arbitrum) Bridge & Wrapped SOLAR (wSOLAR) Manager
 */
contract SolarGridBridge {
    string public constant name = "Wrapped Stellar Solar Token";
    string public constant symbol = "wSOLAR";
    uint8 public constant decimals = 7;

    address public admin;
    bool public paused;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(uint256 => bool) public processedStellarNonces;

    event TokensWrapped(address indexed recipient, uint256 amount, uint256 stellarNonce);
    event TokensUnwrapped(address indexed sender, string stellarRecipient, uint256 amount);
    event CrossChainMeterPayment(address indexed payer, string meterId, uint256 amount);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only admin");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "Bridge paused");
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    function setPaused(bool _paused) external onlyAdmin {
        paused = _paused;
    }

    function mintWrapped(
        address recipient,
        uint256 amount,
        uint256 stellarNonce
    ) external onlyAdmin whenNotPaused {
        require(!processedStellarNonces[stellarNonce], "Nonce already processed");
        processedStellarNonces[stellarNonce] = true;
        totalSupply += amount;
        balanceOf[recipient] += amount;
        emit TokensWrapped(recipient, amount, stellarNonce);
    }

    function burnAndUnwrap(string calldata stellarRecipient, uint256 amount) external whenNotPaused {
        require(balanceOf[msg.sender] >= amount && amount > 0, "Insufficient wSOLAR");
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        emit TokensUnwrapped(msg.sender, stellarRecipient, amount);
    }

    function paySolarMeterCrossChain(string calldata meterId, uint256 amount) external whenNotPaused {
        require(balanceOf[msg.sender] >= amount && amount > 0, "Insufficient wSOLAR");
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        emit CrossChainMeterPayment(msg.sender, meterId, amount);
    }
}
