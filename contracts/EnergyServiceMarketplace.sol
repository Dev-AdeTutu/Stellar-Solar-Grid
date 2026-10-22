// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title EnergyServiceMarketplace
 * @dev Marketplace for prosumers to offer diverse energy services
 */
contract EnergyServiceMarketplace is Ownable, ReentrancyGuard, Pausable {
    
    enum ServiceType {
        BackupPower,
        PeakShaving,
        FrequencyRegulation,
        LoadBalancing,
        DemandResponse
    }
    
    enum ServiceStatus {
        Active,
        Inactive,
        Suspended
    }
    
    enum RequestStatus {
        Open,
        Accepted,
        InProgress,
        Completed,
        Disputed,
        Cancelled
    }
    
    struct Service {
        uint256 serviceId;
        address provider;
        ServiceType serviceType;
        string description;
        uint256 pricePerKWh;
        uint256 availableCapacity;
        uint256 minimumDuration;
        ServiceStatus status;
        uint256 totalRating;
        uint256 ratingCount;
        uint256 createdAt;
    }
    
    struct ServiceRequest {
        uint256 requestId;
        address requester;
        ServiceType serviceType;
        uint256 requiredCapacity;
        uint256 duration;
        uint256 maxPricePerKWh;
        uint256 startTime;
        RequestStatus status;
        uint256 createdAt;
    }
    
    struct Bid {
        uint256 bidId;
        uint256 requestId;
        uint256 serviceId;
        address provider;
        uint256 pricePerKWh;
        string proposal;
        bool accepted;
        uint256 createdAt;
    }
    
    struct ServiceDelivery {
        uint256 deliveryId;
        uint256 requestId;
        uint256 bidId;
        address provider;
        address consumer;
        uint256 agreedPrice;
        uint256 capacity;
        uint256 duration;
        uint256 startTime;
        uint256 endTime;
        bool paymentReleased;
        bool disputed;
        uint256 deliveredEnergy;
    }
    
    struct Review {
        address reviewer;
        uint256 rating;
        string comment;
        uint256 timestamp;
    }
    
    struct Dispute {
        uint256 disputeId;
        uint256 deliveryId;
        address initiator;
        string reason;
        bool resolved;
        address resolver;
        string resolution;
        uint256 createdAt;
        uint256 resolvedAt;
    }
    
    uint256 private serviceCounter;
    uint256 private requestCounter;
    uint256 private bidCounter;
    uint256 private deliveryCounter;
    uint256 private disputeCounter;
    
    uint256 public platformFeePercent = 2;
    uint256 public constant MAX_FEE_PERCENT = 10;
    
    mapping(uint256 => Service) public services;
    mapping(uint256 => ServiceRequest) public serviceRequests;
    mapping(uint256 => Bid) public bids;
    mapping(uint256 => ServiceDelivery) public deliveries;
    mapping(uint256 => Dispute) public disputes;
    mapping(uint256 => uint256[]) public requestBids;
    mapping(uint256 => Review[]) public serviceReviews;
    mapping(address => uint256[]) public providerServices;
    mapping(address => uint256) public escrowBalances;
    
    event ServiceListed(uint256 indexed serviceId, address indexed provider, ServiceType serviceType);
    event ServiceUpdated(uint256 indexed serviceId, ServiceStatus status);
    event ServiceRequestCreated(uint256 indexed requestId, address indexed requester, ServiceType serviceType);
    event BidPlaced(uint256 indexed bidId, uint256 indexed requestId, address indexed provider);
    event BidAccepted(uint256 indexed bidId, uint256 indexed requestId);
    event DeliveryStarted(uint256 indexed deliveryId, uint256 indexed requestId);
    event DeliveryCompleted(uint256 indexed deliveryId, uint256 deliveredEnergy);
    event PaymentReleased(uint256 indexed deliveryId, address indexed provider, uint256 amount);
    event ReviewSubmitted(uint256 indexed serviceId, address indexed reviewer, uint256 rating);
    event DisputeCreated(uint256 indexed disputeId, uint256 indexed deliveryId);
    event DisputeResolved(uint256 indexed disputeId, address resolver);
    event FundsDeposited(address indexed user, uint256 amount);
    event FundsWithdrawn(address indexed user, uint256 amount);
    
    constructor() Ownable(msg.sender) {}
    
    modifier onlyProvider(uint256 serviceId) {
        require(services[serviceId].provider == msg.sender, "Not service provider");
        _;
    }
    
    modifier onlyRequester(uint256 requestId) {
        require(serviceRequests[requestId].requester == msg.sender, "Not requester");
        _;
    }
    
    function listService(
        ServiceType _serviceType,
        string memory _description,
        uint256 _pricePerKWh,
        uint256 _availableCapacity,
        uint256 _minimumDuration
    ) external whenNotPaused returns (uint256) {
        require(bytes(_description).length > 0, "Description required");
        require(_pricePerKWh > 0, "Invalid price");
        require(_availableCapacity > 0, "Invalid capacity");
        
        serviceCounter++;
        uint256 serviceId = serviceCounter;
        
        services[serviceId] = Service({
            serviceId: serviceId,
            provider: msg.sender,
            serviceType: _serviceType,
            description: _description,
            pricePerKWh: _pricePerKWh,
            availableCapacity: _availableCapacity,
            minimumDuration: _minimumDuration,
            status: ServiceStatus.Active,
            totalRating: 0,
            ratingCount: 0,
            createdAt: block.timestamp
        });
        
        providerServices[msg.sender].push(serviceId);
        emit ServiceListed(serviceId, msg.sender, _serviceType);
        return serviceId;
    }
    
    function updateService(
        uint256 _serviceId,
        uint256 _pricePerKWh,
        uint256 _availableCapacity,
        ServiceStatus _status
    ) external onlyProvider(_serviceId) {
        Service storage service = services[_serviceId];
        if (_pricePerKWh > 0) service.pricePerKWh = _pricePerKWh;
        if (_availableCapacity > 0) service.availableCapacity = _availableCapacity;
        service.status = _status;
        emit ServiceUpdated(_serviceId, _status);
    }
    
    function createServiceRequest(
        ServiceType _serviceType,
        uint256 _requiredCapacity,
        uint256 _duration,
        uint256 _maxPricePerKWh,
        uint256 _startTime
    ) external payable whenNotPaused returns (uint256) {
        require(_requiredCapacity > 0, "Invalid capacity");
        require(_duration > 0, "Invalid duration");
        require(_startTime >= block.timestamp, "Invalid start time");
        
        uint256 estimatedCost = _requiredCapacity * _maxPricePerKWh;
        require(msg.value >= estimatedCost, "Insufficient escrow");
        
        requestCounter++;
        serviceRequests[requestCounter] = ServiceRequest({
            requestId: requestCounter,
            requester: msg.sender,
            serviceType: _serviceType,
            requiredCapacity: _requiredCapacity,
            duration: _duration,
            maxPricePerKWh: _maxPricePerKWh,
            startTime: _startTime,
            status: RequestStatus.Open,
            createdAt: block.timestamp
        });
        
        escrowBalances[msg.sender] += msg.value;
        emit ServiceRequestCreated(requestCounter, msg.sender, _serviceType);
        emit FundsDeposited(msg.sender, msg.value);
        return requestCounter;
    }
    
    function placeBid(
        uint256 _requestId,
        uint256 _serviceId,
        uint256 _pricePerKWh,
        string memory _proposal
    ) external whenNotPaused returns (uint256) {
        ServiceRequest storage request = serviceRequests[_requestId];
        Service storage service = services[_serviceId];
        
        require(request.status == RequestStatus.Open, "Request not open");
        require(service.provider == msg.sender, "Not service provider");
        require(service.serviceType == request.serviceType, "Service type mismatch");
        require(_pricePerKWh <= request.maxPricePerKWh, "Price too high");
        require(service.availableCapacity >= request.requiredCapacity, "Insufficient capacity");
        
        bidCounter++;
        bids[bidCounter] = Bid({
            bidId: bidCounter,
            requestId: _requestId,
            serviceId: _serviceId,
            provider: msg.sender,
            pricePerKWh: _pricePerKWh,
            proposal: _proposal,
            accepted: false,
            createdAt: block.timestamp
        });
        
        requestBids[_requestId].push(bidCounter);
        emit BidPlaced(bidCounter, _requestId, msg.sender);
        return bidCounter;
    }
    
    function acceptBid(uint256 _bidId) external nonReentrant whenNotPaused returns (uint256) {
        Bid storage bid = bids[_bidId];
        ServiceRequest storage request = serviceRequests[bid.requestId];
        
        require(request.requester == msg.sender, "Not requester");
        require(request.status == RequestStatus.Open, "Request not open");
        require(!bid.accepted, "Bid already accepted");
        
        bid.accepted = true;
        request.status = RequestStatus.Accepted;
        
        deliveryCounter++;
        deliveries[deliveryCounter] = ServiceDelivery({
            deliveryId: deliveryCounter,
            requestId: bid.requestId,
            bidId: _bidId,
            provider: bid.provider,
            consumer: msg.sender,
            agreedPrice: bid.pricePerKWh,
            capacity: request.requiredCapacity,
            duration: request.duration,
            startTime: request.startTime,
            endTime: 0,
            paymentReleased: false,
            disputed: false,
            deliveredEnergy: 0
        });
        
        emit BidAccepted(_bidId, bid.requestId);
        emit DeliveryStarted(deliveryCounter, bid.requestId);
        return deliveryCounter;
    }
    
    function completeDelivery(uint256 _deliveryId, uint256 _deliveredEnergy) external nonReentrant whenNotPaused {
        ServiceDelivery storage delivery = deliveries[_deliveryId];
        require(delivery.provider == msg.sender, "Not provider");
        require(!delivery.paymentReleased, "Already completed");
        require(_deliveredEnergy <= delivery.capacity, "Exceeded capacity");
        
        delivery.deliveredEnergy = _deliveredEnergy;
        delivery.endTime = block.timestamp;
        serviceRequests[delivery.requestId].status = RequestStatus.Completed;
        emit DeliveryCompleted(_deliveryId, _deliveredEnergy);
    }
    
    function releasePayment(uint256 _deliveryId) external nonReentrant whenNotPaused {
        ServiceDelivery storage delivery = deliveries[_deliveryId];
        require(delivery.consumer == msg.sender || owner() == msg.sender, "Not authorized");
        require(!delivery.paymentReleased, "Already paid");
        require(delivery.deliveredEnergy > 0, "Service not delivered");
        require(!delivery.disputed, "Delivery disputed");
        
        uint256 totalAmount = delivery.deliveredEnergy * delivery.agreedPrice;
        uint256 platformFee = (totalAmount * platformFeePercent) / 100;
        uint256 providerPayment = totalAmount - platformFee;
        
        require(escrowBalances[delivery.consumer] >= totalAmount, "Insufficient escrow");
        
        delivery.paymentReleased = true;
        escrowBalances[delivery.consumer] -= totalAmount;
        
        payable(delivery.provider).transfer(providerPayment);
        payable(owner()).transfer(platformFee);
        
        emit PaymentReleased(_deliveryId, delivery.provider, providerPayment);
    }
    
    function submitReview(uint256 _serviceId, uint256 _deliveryId, uint256 _rating, string memory _comment) external whenNotPaused {
        require(_rating >= 1 && _rating <= 5, "Rating must be 1-5");
        ServiceDelivery storage delivery = deliveries[_deliveryId];
        require(delivery.consumer == msg.sender, "Not consumer");
        require(delivery.paymentReleased, "Delivery not completed");
        
        Service storage service = services[_serviceId];
        serviceReviews[_serviceId].push(Review({
            reviewer: msg.sender,
            rating: _rating,
            comment: _comment,
            timestamp: block.timestamp
        }));
        
        service.totalRating += _rating;
        service.ratingCount++;
        emit ReviewSubmitted(_serviceId, msg.sender, _rating);
    }
    
    function createDispute(uint256 _deliveryId, string memory _reason) external whenNotPaused returns (uint256) {
        ServiceDelivery storage delivery = deliveries[_deliveryId];
        require(delivery.consumer == msg.sender || delivery.provider == msg.sender, "Not authorized");
        require(!delivery.paymentReleased, "Payment already released");
        require(!delivery.disputed, "Already disputed");
        
        delivery.disputed = true;
        disputeCounter++;
        disputes[disputeCounter] = Dispute({
            disputeId: disputeCounter,
            deliveryId: _deliveryId,
            initiator: msg.sender,
            reason: _reason,
            resolved: false,
            resolver: address(0),
            resolution: "",
            createdAt: block.timestamp,
            resolvedAt: 0
        });
        
        serviceRequests[delivery.requestId].status = RequestStatus.Disputed;
        emit DisputeCreated(disputeCounter, _deliveryId);
        return disputeCounter;
    }
    
    function resolveDispute(uint256 _disputeId, string memory _resolution, uint256 _providerPaymentPercent) external onlyOwner nonReentrant {
        require(_providerPaymentPercent <= 100, "Invalid percentage");
        Dispute storage dispute = disputes[_disputeId];
        require(!dispute.resolved, "Already resolved");
        
        ServiceDelivery storage delivery = deliveries[dispute.deliveryId];
        uint256 totalAmount = delivery.capacity * delivery.agreedPrice;
        uint256 providerAmount = (totalAmount * _providerPaymentPercent) / 100;
        uint256 consumerRefund = totalAmount - providerAmount;
        
        dispute.resolved = true;
        dispute.resolver = msg.sender;
        dispute.resolution = _resolution;
        dispute.resolvedAt = block.timestamp;
        delivery.paymentReleased = true;
        escrowBalances[delivery.consumer] -= totalAmount;
        
        if (providerAmount > 0) payable(delivery.provider).transfer(providerAmount);
        if (consumerRefund > 0) payable(delivery.consumer).transfer(consumerRefund);
        
        serviceRequests[delivery.requestId].status = RequestStatus.Completed;
        emit DisputeResolved(_disputeId, msg.sender);
    }
    
    function getService(uint256 _serviceId) external view returns (Service memory) {
        return services[_serviceId];
    }
    
    function getServiceRequest(uint256 _requestId) external view returns (ServiceRequest memory) {
        return serviceRequests[_requestId];
    }
    
    function getBid(uint256 _bidId) external view returns (Bid memory) {
        return bids[_bidId];
    }
    
    function getDelivery(uint256 _deliveryId) external view returns (ServiceDelivery memory) {
        return deliveries[_deliveryId];
    }
    
    function getRequestBids(uint256 _requestId) external view returns (uint256[] memory) {
        return requestBids[_requestId];
    }
    
    function getServiceReviews(uint256 _serviceId) external view returns (Review[] memory) {
        return serviceReviews[_serviceId];
    }
    
    function getProviderServices(address _provider) external view returns (uint256[] memory) {
        return providerServices[_provider];
    }
    
    function getServiceAverageRating(uint256 _serviceId) external view returns (uint256) {
        Service memory service = services[_serviceId];
        if (service.ratingCount == 0) return 0;
        return service.totalRating / service.ratingCount;
    }
    
    function setPlatformFee(uint256 _feePercent) external onlyOwner {
        require(_feePercent <= MAX_FEE_PERCENT, "Fee too high");
        platformFeePercent = _feePercent;
    }
    
    function pause() external onlyOwner {
        _pause();
    }
    
    function unpause() external onlyOwner {
        _unpause();
    }
    
    function withdrawEscrow() external nonReentrant {
        uint256 balance = escrowBalances[msg.sender];
        require(balance > 0, "No balance");
        escrowBalances[msg.sender] = 0;
        payable(msg.sender).transfer(balance);
        emit FundsWithdrawn(msg.sender, balance);
    }
    
    receive() external payable {
        escrowBalances[msg.sender] += msg.value;
        emit FundsDeposited(msg.sender, msg.value);
    }
}
