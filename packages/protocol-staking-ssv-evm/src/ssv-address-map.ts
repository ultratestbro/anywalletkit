export interface SsvDeployment {
  network: string
  views: string
  ssvToken: string
  cssvToken: string
  endpoints: { apr: string; aprHistory: string }
}

/**
 * SSV Network contract addresses, keyed by chain id.
 *
 * `network` is the SSVNetwork proxy — every staking write (stake,
 * requestUnstake, withdrawUnlocked, claimEthRewards) is a call on it; the
 * staking module behind the proxy is `contracts/modules/SSVStaking.sol` in
 * ssvlabs/ssv-network v2.0.0. `views` is SSVNetworkViews, where every read
 * lives (stakedBalanceOf, previewClaimableEth, pendingUnstake, cooldownDuration…).
 * `ssvToken` is the SSV ERC-20 the account stakes, `cssvToken` the cSSV receipt
 * token minted 1:1 (non-rebasing; rewards accrue through an ETH-per-share index).
 *
 * All four mainnet addresses were verified against the live proxy (getVersion()
 * = "v2.0.0", cooldownDuration() = 604800, cSSV.totalSupply() == totalStaked())
 * before landing here; the ENS names ssvnetwork.eth / views.ssvnetwork.eth /
 * ssv.ssvnetwork.eth / cssv.ssvnetwork.eth resolve to them.
 *
 * Only mainnet ships as a default: other deployments (e.g. the Hoodi testnet —
 * network 0x58410Bef803ECd7E63B23664C586A6DB72DAf59c, views
 * 0x5AdDb3f1529C5ec70D77400499eE4bbF328368fe, SSV
 * 0x9F5d4Ec84fC4785788aB44F9de973cF34F7A038e, cSSV
 * 0x6e1a5d27361c666f681af06535c8Ac773E571d4d) must be passed explicitly
 * through the protocol's `config.addresses` so that nobody stakes against an
 * unverified address that a default quietly supplied.
 */
const SSV_ADDRESS_MAP: Record<number, SsvDeployment> = {
  1: {
    network: '0xDD9BC35aE942eF0cFa76930954a156B3fF30a4E1',
    views: '0xafE830B6Ee262ba11cce5F32fDCd760FFE6a66e4',
    ssvToken: '0x9D65fF81a3c488d585bBfb0Bfe3c7707c7917f54',
    cssvToken: '0xe018D31F120A637828F46aFD6c64EC099d960546',
    endpoints: {
      // The same API stake.ssv.network reads its APR from (CORS *).
      apr: 'https://api.ssv.network/api/v4/mainnet/apr/current',
      aprHistory: 'https://api.ssv.network/api/v4/mainnet/apr/history',
    },
  },
}

export default SSV_ADDRESS_MAP
