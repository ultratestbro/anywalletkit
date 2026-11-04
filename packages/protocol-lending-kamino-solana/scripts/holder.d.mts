export declare const TOKEN_PROGRAM: string
export declare const TOKEN_2022_PROGRAM: string
export type TokenAccountState = 'missing' | 'uninitialized' | 'initialized' | 'frozen'
export interface HolderTokenAccount { state: TokenAccountState; amount: bigint }
export declare function decodeTokenAccount(programOwner: string, data: Uint8Array, mint: string, owner: string): HolderTokenAccount
export declare function readTokenAccount(rpcUrl: string, account: string, mint: string, owner: string, fetchImpl?: typeof fetch): Promise<HolderTokenAccount>
export declare function holderProblem(account: HolderTokenAccount, at: { address: string; tokenAccount: string; symbol: string }): string | null
