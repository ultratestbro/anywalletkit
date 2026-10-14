'use strict'

/**
 * @typedef {Object} MellowVaultPreset
 * @property {string} vault - The Core Vault address (everything else is discovered on-chain).
 * @property {string} registryId - The vault's id in Mellow's registry (APY / TVL decoration).
 * @property {string} name - Display name.
 * @property {string} shareSymbol - The share token's ticker.
 * @property {string} [shareManager] - The TokenizedShareManager, i.e. the ERC-20 share token (read from `vault.shareManager()`).
 * @property {{ deposit: string[], redeem: string[] }} [queues] - Deposit / redeem queues the vault listed when the preset was last verified. Used only to recognize past transactions offline (`describeActivity`); writes always discover queues on-chain.
 * @property {string} [note] - Caveats known at the time the preset was added.
 */

/**
 * Known Core Vaults by chain id and key. Presets are a convenience: any vault
 * on the same contracts works by passing its address as `vault`.
 * Addresses verified against the on-chain vault getters on 2026-09-07;
 * `shareManager` and `queues` read from the same getters on 2026-10-14.
 *
 * @type {Record<number, Record<string, MellowVaultPreset>>}
 */
const MELLOW_ADDRESS_MAP = {
  1: {
    'lido-earn-eth': {
      vault: '0x6a37725ca7f4ce81c004c955f7280d5c704a249e',
      registryId: 'lido-earn-eth',
      shareManager: '0xBBFC8683C8fE8cF73777feDE7ab9574935fea0A4',
      queues: {
        deposit: ['0x1db7094Ef0D994B0b62f6Cd67dB801ad194999A8', '0xb99394f8b95d426Cb2F013B857C74aCC924b20D5', '0x3Fc48660d02e59fBedD0a5Cc18a5580D1f8dD6A4', '0xCe6C2505fEF74d2dE10FCF1d534cB73eCc837976', '0xe39EED9A454C4918F8d0682062777cB251cd513F', '0xECD2Bfe725fa14f5Ed86e9bDcc0eA4b34A4ed522', '0x411172F1E5310d03b38128F2a294F2e33c691B30', '0x2792004b709E3E88b8FCCb06c3C5e1A6dff0EC2B', '0x268ea1cc674cdaE200c4609E7b09d03Dc618E663', '0xA4F23f56442C01a478af20fe06b9F5f8f05aDD96', '0x4bDd2Ea1E20acb13f2758190c92a84175107A86f', '0xA80f247b92C79740b0610b754403D5cb0bf216b5'],
        redeem: ['0x095bFAca9f1c6F2B063Cd67C6d6bfcd0c3aaB7b4', '0xB5984D87d21C4375d18972fd546b688BD4Fc1f0A']
      },
      name: 'Lido EarnETH',
      shareSymbol: 'earnETH'
    },
    'lido-earn-usd': {
      vault: '0x014e6da8f283c4af65b2aa0f201438680a004452',
      registryId: 'lido-earn-usd',
      shareManager: '0x4Ce1ac8F43E0E5BD7A346A98aF777bF8fbeA1981',
      queues: {
        deposit: ['0xC75E7E73B25fEa8bB23EB55CC48BA55067b5be76', '0xf6AFAf6afcAe116dD37A779D50fE6c5fa6f8C8f5', '0xEeC5041c47Cba1e31321AC6941Bf09Ad60645B73', '0x534d0bEb82C47cf703BFb9E959297658b65Ec8E9', '0xeEc37568b01e0C4d5028501A49E024B475E2D7cA'],
        redeem: ['0x9e36A74FE278906a76e7615263e46a83fC40c47F', '0xE0eee7e956A94BD00546d9CA07e5012F11A5059d', '0x95092A7a86715246Be6395b8D514B3d60A270Cd3']
      },
      name: 'Lido EarnUSD',
      shareSymbol: 'earnUSD'
    },
    'lido-strategy': {
      vault: '0x277c6a642564a91ff78b008022d65683cee5ccc5',
      registryId: 'lido-strategy',
      shareManager: '0xcd3c0F51798D1daA92Fb192E57844Ae6cEE8a6c7',
      queues: {
        deposit: ['0xE707321B887b9da133AC5fCc5eDB78Ab177a152D', '0x3b261535055C9Faf248Fe5b23A743184b6d4BeEd', '0x2eA268f1018a4767bF5da42D531Ea9e943942A36', '0x8a89f2c30673520A45839353C32C30bBe59FE616', '0x614cb9E9D13712781DfD15aDC9F3DAde60E4eFAb', '0x6C9aBC05CDb7d1C339dcC359F40e8BDE65C1BD99', '0x18502f78D226a88994E6eC94BD4a7BA341DC1CD5', '0xBCDbf4D3b3b3345f8348C6aA557949DEaa6bC57B'],
        redeem: ['0x1ae8C006b5C97707aa074AaeD42BecAD2CF80Da2', '0x6eCd9fe8cA919CB6DBCdD07D47Ef8548E0c5C481']
      },
      name: 'Lido stRATEGY',
      shareSymbol: 'strETH',
      note: 'Deposits gated by the vault whitelist as of 2026-09-07 (supply refuses); reads and redemptions work.'
    },
    'lido-conservative-earn-usd': {
      vault: '0xdf0fb76df2c21f79798949a4e886cd22d1c085d7',
      registryId: 'lido-conservative-earn-usd',
      shareManager: '0xd9543AfF8A859F6B34f80A9A230B277c89ACdda4',
      queues: {
        deposit: ['0xEdcd9C257719799435B05C28ff9a8a34e6872bE0', '0xeC3EE7F7669b7ce0aC91c4638e4b89c9F40E179F'],
        redeem: ['0x59fC26AFFF725eBb77Db8E1de14572e5eA9e87EB', '0x395d3230B47c8EAd7b4152c670945f6545efe3c9', '0xe04A1c2D63e6964f5629B3c08BF08D2472faaB09', '0xF210B2E34190923afe746b297cD96465D605F33f']
      },
      name: 'Lido Conservative earnUSD',
      shareSymbol: 'earnUSD',
      note: 'Deposits gated by the vault whitelist as of 2026-09-07; sync deposit queues only.'
    },
    'lido-experimental-earn-usd': {
      vault: '0x0cc65147bf7f615a8dd9e78e2c53158f8e01754d',
      registryId: 'lido-experimental-earn-usd',
      shareManager: '0x3D561e1E0204d47b45C23B65356a4536c36d1AF6',
      queues: {
        deposit: ['0xBb647898e0CF0aE81Ac480d04A8a9973763eBD2D', '0xa01aEfeC7A3384C8440e99084458030BDbdD7404', '0xAcb2E510e8FcdaB3808cC5B9d206374cAB527947'],
        redeem: ['0x8B857170F2a6C10Ce64ec8b920428ca977fb7710', '0xaFd38D9a5F48f6953c0d110c4e0ecBA2381f7Fc5', '0x978f41aF86E14901C77ebaB799c307886e7C2c54', '0xfAc01645CA39EcD6C80bd15C052d448ED5069DF0']
      },
      name: 'Lido Experimental earnUSD',
      shareSymbol: 'earnUSD',
      note: 'Deposits gated by the vault whitelist as of 2026-09-07; sync deposit queues only.'
    }
  }
}

export default MELLOW_ADDRESS_MAP
