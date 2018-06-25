pragma solidity 0.4.23;

import 'mixbytes-solidity/contracts/security/ArgumentsChecker.sol';
import 'zeppelin-solidity/contracts/ReentrancyGuard.sol';
import './EthPriceDependent.sol';
import './crowdsale/FundsRegistry.sol';
import './IBoomstarterToken.sol';

/// @title Boomstarter ICO contract
contract BoomstarterICO is ArgumentsChecker, ReentrancyGuard, EthPriceDependent {

    enum IcoState { INIT, ACTIVE, PAUSED, FAILED, SUCCEEDED }

    event StateChanged(IcoState _state);
    event FundTransfer(address backer, uint amount, bool isContribution);


    modifier requiresState(IcoState _state) {
        require(m_state == _state);
        _;
    }

    /// @dev triggers some state changes based on current time
    /// @param client optional refund parameter
    /// @param payment optional refund parameter
    /// @param refundable - if false, payment is made off-chain and shouldn't be refunded
    /// note: function body could be skipped!
    modifier timedStateChange(address client, uint payment, bool refundable) {
        if (IcoState.INIT == m_state && getTime() >= getStartTime())
            changeState(IcoState.ACTIVE);

        if (IcoState.ACTIVE == m_state && getTime() >= getFinishTime()) {
            finishICO();

            if (refundable && payment > 0)
                client.transfer(payment);
            // note that execution of further (but not preceding!) modifiers and functions ends here
        } else {
            _;
        }
    }

    /// @dev automatic check for unaccounted withdrawals
    /// @param client optional refund parameter
    /// @param payment optional refund parameter
    /// @param refundable - if false, payment is made off-chain and shouldn't be refunded
    modifier fundsChecker(address client, uint payment, bool refundable) {
        uint atTheBeginning = m_funds.balance;
        if (atTheBeginning < m_lastFundsAmount) {
            changeState(IcoState.PAUSED);
            if (refundable && payment > 0)
                client.transfer(payment);     // we cant throw (have to save state), so refunding this way
            // note that execution of further (but not preceding!) modifiers and functions ends here
        } else {
            _;

            if (m_funds.balance < atTheBeginning) {
                changeState(IcoState.PAUSED);
            } else {
                m_lastFundsAmount = m_funds.balance;
            }
        }
    }


    // PUBLIC interface

    function BoomstarterICO(address[] _owners, address _token, bool _production)
        public
        payable
        EthPriceDependent(_owners, 2, _production)
        validAddress(_token)
    {
        require(3 == _owners.length);

        m_token = IBoomstarterToken(_token);
        m_deployer = msg.sender;
    }

    /// @dev set addresses for ether and token storage
    ///      performed once by deployer
    /// @param _funds FundsRegistry address
    /// @param _tokenDistributor address to send remaining tokens to after ICO
    /// @param _previouslySold how much sold in previous sales in cents
    function init(address _funds, address _tokenDistributor, uint _previouslySold)
        external
        validAddress(_funds)
        validAddress(_tokenDistributor)
        onlymanyowners(keccak256(msg.data))
    {
        // can be set only once
        require(m_funds == address(0));
        m_funds = FundsRegistry(_funds);

        // calculate remaining tokens and leave 25% for manual allocation
        c_maximumTokensSold = m_token.balanceOf(this).sub( m_token.totalSupply().div(4) );

        // manually set how much should be sold taking into account previously collected
        c_softCapUsd = c_softCapUsd.sub(_previouslySold);

        // set account that allocates the rest of tokens after ico succeeds
        m_tokenDistributor = _tokenDistributor;
    }


    // PUBLIC interface: payments

    // fallback function as a shortcut
    function() payable {
        require(0 == msg.data.length);
        buy();  // only internal call here!
    }

    /// @notice ICO participation
    function buy() public payable {     // dont mark as external!
        internalBuy(msg.sender, msg.value, true);
    }

    /// @notice register investments coming in different currencies
    /// @dev can only be called by a special controller account
    /// @param client Account to send tokens to
    /// @param etherEquivalentAmount Amount of ether to use to calculate token amount
    function nonEtherBuy(address client, uint etherEquivalentAmount)
        public
    {
        require(msg.sender == m_nonEtherController);
        internalBuy(client, etherEquivalentAmount, false);
    }

    /// @dev common buy for ether and non-ether
    /// @param client who invests
    /// @param payment how much ether
    /// @param refundable true if invested in ether - using buy()
    function internalBuy(address client, uint payment, bool refundable)
        internal
        nonReentrant
        timedStateChange(client, payment, refundable)
        fundsChecker(client, payment, refundable)
    {
        // don't allow to buy anything if price change was too long ago
        // effectively enforcing a sale pause
        require( !priceExpired() );
        require(m_state == IcoState.ACTIVE || m_state == IcoState.INIT && isOwner(client) /* for final test */);

        require((payment.mul(m_ETHPriceInCents)).div(1 ether) >= c_MinInvestmentInCents);

        uint amount = payment.mul(m_ETHPriceInCents).div(getPrice());

        uint actualPayment = payment;

        if (amount.add(m_currentTokensSold) > c_maximumTokensSold) {
            amount = c_maximumTokensSold.sub( m_currentTokensSold );
            actualPayment = getPrice().mul(amount).div(m_ETHPriceInCents);
        }

        // calculating a 20% bonus if the price of bought tokens is more than $50k
        if (actualPayment.mul(m_ETHPriceInCents).div(1 ether) >= 5000000) {
            amount = amount.add(amount.div(5));
            // for ICO, bonus cannot exceed hard cap
            if (amount.add(m_currentTokensSold) > c_maximumTokensSold) {
                amount = c_maximumTokensSold.sub(m_currentTokensSold);
            }
        }

        // change ICO investment stats
        m_currentUsdAccepted = m_currentUsdAccepted.add( actualPayment.mul(m_ETHPriceInCents).div(1 ether) );
        m_currentTokensSold = m_currentTokensSold.add( amount );

        // send bought tokens to the client
        m_token.transfer(client, amount);

        if (refundable) {
            // record payment if paid in ether
            m_funds.invested.value(actualPayment)(client, amount);
            FundTransfer(client, actualPayment, false);
        } else {
            // don't record if paid in different currency
            FundTransfer(client, actualPayment, true);
        }

        // check if ICO must be closed early
        if (payment.sub(actualPayment) > 0) {
            assert(c_maximumTokensSold == m_currentTokensSold);
            finishICO();

            // send change
            client.transfer(payment.sub(actualPayment));
        } else if (c_maximumTokensSold == m_currentTokensSold) {
            finishICO();
        }
    }


    // PUBLIC interface: misc getters

    /// @notice get token price in cents depending on the current date
    function getPrice() public view returns (uint) {
        // skip finish date, start from the date of maximum price
        for (uint i = c_priceChangeDates.length - 2; i > 0; i--) {
            if (getTime() > c_priceChangeDates[i]) {
              return c_tokenPrices[i];
            }
        }
        // default price is the cheapest, used for the initial test as well
        return c_tokenPrices[0];
    }

    /// @notice start time of the ICO
    function getStartTime() public view returns (uint) {
        return c_priceChangeDates[0];
    }

    /// @notice finish time of the ICO
    function getFinishTime() public view returns (uint) {
        return c_priceChangeDates[c_priceChangeDates.length - 1];
    }


    // PUBLIC interface: owners: maintenance

    /// @notice pauses ICO
    function pause()
        external
        timedStateChange(address(0), 0, true)
        requiresState(IcoState.ACTIVE)
        onlyowner
    {
        changeState(IcoState.PAUSED);
    }

    /// @notice resume paused ICO
    function unpause()
        external
        timedStateChange(address(0), 0, true)
        requiresState(IcoState.PAUSED)
        onlymanyowners(keccak256(msg.data))
    {
        changeState(IcoState.ACTIVE);
        checkTime();
    }

    /// @notice withdraw tokens if ico failed
    /// @param _to address to send tokens to
    /// @param _amount amount of tokens in token-wei
    function withdrawTokens(address _to, uint _amount)
        external
        validAddress(_to)
        requiresState(IcoState.FAILED)
        onlymanyowners(keccak256(msg.data))
    {
        require((_amount > 0) && (m_token.balanceOf(this) >= _amount));
        m_token.transfer(_to, _amount);
    }

    /// @notice In case we need to attach to existent token
    function setToken(address _token)
        external
        validAddress(_token)
        timedStateChange(address(0), 0, true)
        requiresState(IcoState.PAUSED)
        onlymanyowners(keccak256(msg.data))
    {
        m_token = IBoomstarterToken(_token);
    }

    /// @notice In case we need to attach to existent funds
    function setFundsRegistry(address _funds)
        external
        validAddress(_funds)
        timedStateChange(address(0), 0, true)
        requiresState(IcoState.PAUSED)
        onlymanyowners(keccak256(msg.data))
    {
        m_funds = FundsRegistry(_funds);
    }

    /// @notice set non ether investment controller
    function setNonEtherController(address _controller)
        external
        validAddress(_controller)
        timedStateChange(address(0), 0, true)
        onlymanyowners(keccak256(msg.data))
    {
        m_nonEtherController = _controller;
    }

    /// @notice explicit trigger for timed state changes
    function checkTime()
        public
        timedStateChange(address(0), 0, true)
        onlyowner
    {
    }


    // INTERNAL functions

    function finishICO() private {
        if (m_currentUsdAccepted < c_softCapUsd) {
            changeState(IcoState.FAILED);
        } else {
            changeState(IcoState.SUCCEEDED);
        }
    }

    /// @dev performs only allowed state transitions
    function changeState(IcoState _newState) private {
        assert(m_state != _newState);

        if (IcoState.INIT == m_state) {
            assert(IcoState.ACTIVE == _newState);
        } else if (IcoState.ACTIVE == m_state) {
            assert(
                IcoState.PAUSED == _newState ||
                IcoState.FAILED == _newState ||
                IcoState.SUCCEEDED == _newState
            );
        } else if (IcoState.PAUSED == m_state) {
            assert(IcoState.ACTIVE == _newState || IcoState.FAILED == _newState);
        } else {
            assert(false);
        }

        m_state = _newState;
        StateChanged(m_state);

        // this should be tightly linked
        if (IcoState.SUCCEEDED == m_state) {
            onSuccess();
        } else if (IcoState.FAILED == m_state) {
            onFailure();
        }
    }

    function onSuccess() private {
        // allow owners to withdraw collected ether
        m_funds.changeState(FundsRegistry.State.SUCCEEDED);
        m_funds.detachController();

        // send all remaining tokens to the address responsible for dividing them into pools
        m_token.transfer(m_tokenDistributor, m_token.balanceOf(this));
    }

    function onFailure() private {
        // allow clients to get their ether back 
        m_funds.changeState(FundsRegistry.State.REFUNDING);
        m_funds.detachController();
    }


    // FIELDS

    /// @notice points in time when token price grows
    ///         first one is the start time of sale
    ///         last one is the end of sale
    uint[] public c_priceChangeDates = [
        1520000001, // start: $0.8
        1530000000, // $1
        1540000000, // $1.2
        1550000000, // $1.4
        1560000000, // $1.6
        1570000000, // $1.8
        1580000000, // $2.0
        1590000000  // finish
    ];

    /// @notice token prices in cents during different time periods
    ///         starts of the time periods described in c_priceChangeDates
    uint[] public c_tokenPrices = [
        80,  // $0.8
        100, // $1
        120, // $1.2
        140, // $1.4
        160, // $1.6
        180, // $1.8
        200  // $2
    ];

    /// @dev state of the ICO
    IcoState public m_state = IcoState.INIT;

    /// @dev contract responsible for token accounting
    IBoomstarterToken public m_token;

    /// @dev address responsile for allocation of the tokens left if ICO succeeds
    address public m_tokenDistributor;

    /// @dev contract responsible for investments accounting
    FundsRegistry public m_funds;

    /// @dev account handling investments in different currencies
    address public m_nonEtherController;

    /// @dev last recorded funds
    uint public m_lastFundsAmount;

    /// @notice minimum investment in cents
    uint public c_MinInvestmentInCents = 500; // $5

    /// @notice current amount of tokens sold
    uint public m_currentTokensSold;

    /// @dev limit of tokens to be sold during ICO, need to leave 25% for the team
    ///      calculated from the current balance and the total supply
    uint public c_maximumTokensSold;

    /// @dev current usd accepted during ICO, in cents
    uint public m_currentUsdAccepted;

    /// @dev limit of usd to be accepted during ICO, in cents
    uint public c_softCapUsd = 300000000; // $3000000

    /// @dev save deployer for easier initialization
    address public m_deployer;
}