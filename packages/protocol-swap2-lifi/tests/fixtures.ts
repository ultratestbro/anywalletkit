// Recorded-shape LI.FI /quote responses shared by the provider and behaviour tests.
export const DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
export const FROM_TOKEN = "0xdAC17F958D2ee523A2206206994597C13D831ec7";
export const TO_TOKEN = "0xFd086bC7CD5C481DCC9C85EBE478A1C0b69FCbb9";
export const SENDER = "0x4444444444444444444444444444444444444444";
export const RECIPIENT = "0x3333333333333333333333333333333333333333";
export const PARAMS = {
  sourceChain: "eip155:1",
  sourceToken: "USDT",
  destChain: "eip155:42161",
  destToken: TO_TOKEN,
  amountIn: "1000000",
  destAddress: RECIPIENT,
  refundAddress: SENDER,
  slippageBps: 50,
};

export function response(overrides: Record<string, unknown> = {}) {
  return {
    type: "lifi",
    id: "quote-1",
    action: {
      fromToken: {address: FROM_TOKEN, chainId: 1},
      toToken: {address: TO_TOKEN, chainId: 42161},
      fromAmount: "1000000",
      fromChainId: 1,
      toChainId: 42161,
      slippage: 0.005,
      fromAddress: SENDER,
      toAddress: RECIPIENT,
    },
    estimate: {
      fromAmount: "1000000",
      toAmount: "990000",
      toAmountMin: "985050",
      approvalAddress: DIAMOND,
      executionDuration: 20,
    },
    transactionRequest: {
      from: SENDER,
      to: DIAMOND,
      data: "0xdeadbeef",
      value: "0x0",
      chainId: 1,
      gasLimit: "0x5208",
    },
    ...overrides,
  };
}
