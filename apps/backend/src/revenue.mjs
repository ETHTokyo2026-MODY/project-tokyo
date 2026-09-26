import {
  encodeAbiParameters,
  getAddress,
  isHex,
  keccak256,
  parseAbi,
  parseEventLogs,
} from 'viem';

const address = (value) => {
  const result = getAddress(value);
  if (result === '0x0000000000000000000000000000000000000000')
    throw new Error('Zero address');
  return result;
};
const bytes32 = (value) => {
  if (typeof value !== 'string' || !isHex(value) || value.length !== 66)
    throw new Error('Invalid bytes32');
  return value.toLowerCase();
};
const uint = (value, bits) => {
  if (!(
    typeof value === 'bigint' ||
    (typeof value === 'number' && Number.isSafeInteger(value)) ||
    (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value))
  ))
    throw new Error('Invalid integer');
  const result = BigInt(value);
  if (result < 0n || result >= 1n << BigInt(bits))
    throw new Error('Invalid integer');
  return result;
};

export const revenueAbi = parseAbi([
  'function aqua() view returns (address)',
  'function usdc() view returns (address)',
  'function createClaim(bytes32 pool,uint32 day,bytes32 terms) returns (uint256 claimId)',
  'function setPrice(uint256 claimId,uint256 price)',
  'function book(uint256 claimId,(address buyer,address app,address token,uint256 claimId,address beneficiary,uint256 price,uint256 expiry,bytes32 salt) m) returns (uint256 reservationId)',
  'function withdrawUnbooked(uint256 claimId)',
  'function claimRevenue(uint256 claimId) returns (uint256 amount)',
  'function safeTransferFrom(address from,address to,uint256 id,uint256 value,bytes data)',
  'function claims(uint256 claimId) view returns (bytes32 pool,uint32 day,bytes32 terms,uint256 price,uint256 reservationId,uint8 state)',
  'event ClaimCreated(uint256 indexed claimId,address indexed holder,bytes32 indexed pool,uint32 day,bytes32 terms)',
  'event PriceSet(uint256 indexed claimId,uint256 price)',
  'event Booked(uint256 indexed claimId,address indexed buyer,address indexed beneficiary,uint256 price,uint256 reservationId,bytes32 mandateHash)',
  'event UnbookedWithdrawn(uint256 indexed claimId,address indexed holder)',
  'event RevenuePaid(uint256 indexed claimId,address indexed holder,uint256 amount)',
  'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
]);
const aquaAbi = parseAbi([
  'function ship(address app,bytes strategy,address[] tokens,uint256[] amounts) returns (bytes32 strategyHash)',
  'event Shipped(address maker,address app,bytes32 strategyHash,bytes strategy)',
]);
const tuple = revenueAbi.find((item) => item.name === 'book').inputs[1];

export function bookingStrategy(m) {
  const mandate = {
    buyer: address(m.buyer),
    app: address(m.app),
    token: address(m.token),
    claimId: uint(m.claimId, 256),
    beneficiary: address(m.beneficiary),
    price: uint(m.price, 256),
    expiry: uint(m.expiry, 256),
    salt: bytes32(m.salt),
  };
  if (mandate.claimId === 0n || mandate.price === 0n)
    throw new Error('Invalid booking mandate');
  const strategy = encodeAbiParameters([tuple], [mandate]);
  return { mandate, strategy, hash: keccak256(strategy) };
}

// Each instance uses the current holder's, buyer's, or relayer's wallet client.
export class RevenueClient {
  constructor(
    publicClient,
    walletClient,
    { chainId, revenue, aqua, usdc, confirmations = 2 },
  ) {
    if (
      !publicClient?.simulateContract ||
      !publicClient?.readContract ||
      !publicClient?.waitForTransactionReceipt ||
      !publicClient?.getBlock ||
      !walletClient?.writeContract ||
      !walletClient?.getChainId ||
      !walletClient?.account
    )
      throw new Error('Chain clients and a signing account required');
    if (
      !Number.isSafeInteger(chainId) ||
      chainId <= 0 ||
      !Number.isSafeInteger(confirmations) ||
      confirmations < 1
    )
      throw new Error('Invalid chain configuration');
    this.publicClient = publicClient;
    this.walletClient = walletClient;
    this.chainId = chainId;
    this.revenue = address(revenue);
    this.aqua = address(aqua);
    this.usdc = address(usdc);
    this.confirmations = confirmations;
  }

  async #execute(contract, abi, functionName, args, eventName, check) {
    const [rpcChainId, walletChainId] = await Promise.all([
      this.publicClient.getChainId(),
      this.walletClient.getChainId(),
    ]);
    if (
      Number(rpcChainId) !== this.chainId ||
      Number(walletChainId) !== this.chainId ||
      (this.walletClient.chain && this.walletClient.chain.id !== this.chainId)
    )
      throw new Error('Chain client differs from revenue chain');
    const [deployedAqua, deployedToken] = await Promise.all([
      this.publicClient.readContract({
        address: this.revenue,
        abi: revenueAbi,
        functionName: 'aqua',
      }),
      this.publicClient.readContract({
        address: this.revenue,
        abi: revenueAbi,
        functionName: 'usdc',
      }),
    ]);
    if (
      getAddress(deployedAqua) !== this.aqua ||
      getAddress(deployedToken) !== this.usdc
    )
      throw new Error(
        'Revenue deployment differs from configured Aqua or token',
      );
    const { request } = await this.publicClient.simulateContract({
      address: contract,
      abi,
      functionName,
      args,
      account: this.walletClient.account,
    });
    const transactionHash = await this.walletClient.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: transactionHash,
      confirmations: this.confirmations,
    });
    if (
      receipt.status !== 'success' ||
      receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase()
    )
      throw new Error('Revenue transaction reverted or receipt mismatched');
    const block = await this.publicClient.getBlock({
      blockNumber: receipt.blockNumber,
    });
    if (block.hash.toLowerCase() !== receipt.blockHash.toLowerCase())
      throw new Error('Revenue block is no longer canonical');
    if (!eventName) return { transactionHash, blockHash: receipt.blockHash };
    const events = parseEventLogs({
      abi,
      logs: receipt.logs.filter(
        (log) => log.address.toLowerCase() === contract.toLowerCase(),
      ),
      eventName,
      strict: true,
    });
    const matched = events.filter(({ args: event }) => check(event));
    if (matched.length !== 1 || events.length !== 1)
      throw new Error('Revenue event missing or mismatched');
    return {
      transactionHash,
      blockHash: receipt.blockHash,
      event: matched[0].args,
    };
  }

  async createClaim(pool, day, terms) {
    const p = bytes32(pool),
      d = uint(day, 32),
      t = bytes32(terms);
    const result = await this.#execute(
      this.revenue,
      revenueAbi,
      'createClaim',
      [p, Number(d), t],
      'ClaimCreated',
      (event) =>
        event.holder.toLowerCase() ===
          this.walletClient.account.address.toLowerCase() &&
        event.pool.toLowerCase() === p &&
        BigInt(event.day) === d &&
        event.terms.toLowerCase() === t,
    );
    return {
      claimId: result.event.claimId,
      transactionHash: result.transactionHash,
    };
  }

  async setPrice(claimId, price) {
    const id = uint(claimId, 256),
      amount = uint(price, 256);
    return this.#execute(
      this.revenue,
      revenueAbi,
      'setPrice',
      [id, amount],
      'PriceSet',
      (event) => event.claimId === id && event.price === amount,
    );
  }

  async transferClaim(claimId, to) {
    const id = uint(claimId, 256),
      recipient = address(to);
    return this.#execute(
      this.revenue,
      revenueAbi,
      'safeTransferFrom',
      [this.walletClient.account.address, recipient, id, 1n, '0x'],
      'TransferSingle',
      (event) =>
        event.from.toLowerCase() ===
          this.walletClient.account.address.toLowerCase() &&
        event.to.toLowerCase() === recipient.toLowerCase() &&
        event.id === id &&
        event.value === 1n,
    );
  }

  async shipBooking(m) {
    const { mandate, strategy, hash } = bookingStrategy(m);
    if (
      mandate.buyer.toLowerCase() !==
        this.walletClient.account.address.toLowerCase() ||
      mandate.app !== this.revenue ||
      mandate.token !== this.usdc
    )
      throw new Error('Booking strategy differs from buyer or deployment');
    const result = await this.#execute(
      this.aqua,
      aquaAbi,
      'ship',
      [this.revenue, strategy, [this.usdc], [mandate.price]],
      'Shipped',
      (event) =>
        event.maker.toLowerCase() === mandate.buyer.toLowerCase() &&
        event.app.toLowerCase() === this.revenue.toLowerCase() &&
        event.strategyHash.toLowerCase() === hash.toLowerCase() &&
        event.strategy.toLowerCase() === strategy.toLowerCase(),
    );
    return { ...result, mandateHash: hash };
  }

  async book(claimId, m) {
    const id = uint(claimId, 256);
    const { mandate, hash } = bookingStrategy(m);
    if (
      mandate.claimId !== id ||
      mandate.app !== this.revenue ||
      mandate.token !== this.usdc
    )
      throw new Error('Booking mandate differs from claim or deployment');
    const result = await this.#execute(
      this.revenue,
      revenueAbi,
      'book',
      [id, mandate],
      'Booked',
      (event) =>
        event.claimId === id &&
        event.buyer.toLowerCase() === mandate.buyer.toLowerCase() &&
        event.beneficiary.toLowerCase() === mandate.beneficiary.toLowerCase() &&
        event.price === mandate.price &&
        event.mandateHash.toLowerCase() === hash.toLowerCase(),
    );
    return {
      reservationId: result.event.reservationId,
      transactionHash: result.transactionHash,
    };
  }

  async withdrawUnbooked(claimId) {
    const id = uint(claimId, 256);
    return this.#execute(
      this.revenue,
      revenueAbi,
      'withdrawUnbooked',
      [id],
      'UnbookedWithdrawn',
      (event) =>
        event.claimId === id &&
        event.holder.toLowerCase() ===
          this.walletClient.account.address.toLowerCase(),
    );
  }

  async claimRevenue(claimId) {
    const id = uint(claimId, 256);
    const result = await this.#execute(
      this.revenue,
      revenueAbi,
      'claimRevenue',
      [id],
      'RevenuePaid',
      (event) =>
        event.claimId === id &&
        event.holder.toLowerCase() ===
          this.walletClient.account.address.toLowerCase(),
    );
    return {
      amount: result.event.amount,
      transactionHash: result.transactionHash,
    };
  }
}
