# Shielded ZEC (Ironwood) for React Native wallets — method note

*Any Wallet Kit (AWK) · supporting document for the ZCG application · prototype measured 2026-11-17/18*

## What we build

A reusable module, `@anywalletkit/wallet-zcash-shielded`, that gives any React Native wallet
shielded ZEC on the Ironwood pool: a unified address, sync from a birthday height, balance per pool,
and (milestone 2) sending, shielding and the Orchard → Ironwood migration. We do not write a Zcash
stack and do not fork one. All Zcash cryptography — ZIP-32 keys, note scanning, proving, the wallet
database — stays in librustzcash, reached through the ZODL Zcash mobile SDKs and Edge's
react-native-zcash.

## Architecture

```
React Native app (Hermes, New Architecture)
 └─ @anywalletkit/wallet-zcash-shielded  TypeScript, MIT OR Apache-2.0
     │   config checks, bigint balances, ZIP-316 address checks, AWK policies (M2)
     └─ react-native-zcash                Edge, RN native module (Swift / Kotlin)
         └─ ZODL Zcash SDK                zodl-swift-wallet-sdk / zodl-android-wallet-sdk
             └─ librustzcash              Rust, compiled per ABI (libzcashlc / libzcashwalletsdk)
                 └─ lightwalletd (gRPC/TLS)  compact blocks; tested: zec.rocks, ECC lightwalletd v0.6.1 on Zebra 7.1.0
```

**Keys.** The wallet's BIP-39 seed stays where AWK keeps it: the iOS Keychain behind a Secure
Enclave–checked access control, or an Android Keystore key in StrongBox / TEE
(`@anywalletkit/secure-storage-react-native`). The module reads it right before opening the
synchronizer, hands it to the SDK once, and drops it; the SDK derives the ZIP-32 unified spending key
(account 0), creates the account and keeps only the viewing key in its database. Spends (M2) read the
seed again for the one call. The transparent receiver of the unified address is the BIP-44 key at
`m/44'/133'/0'/0/0`, the same address AWK's transparent package (`@anywalletkit/wallet-zcash`) uses
— one seed, one wallet, transparent and shielded.

**What the TypeScript layer adds.** It does not trust strings from the native side: every unified
address is decoded here (ZIP-316 + F4Jumble, tested against `zcash-test-vectors`), must carry a
shielded receiver, and its transparent receiver must equal the account's t-address. Amounts are
`bigint` zatoshi; a malformed amount is reported as an error, never shown as a balance.

## What works today (prototype)

- react-native-zcash branch `jon/zcash-nu7-sdks` (final NU7 crates) builds from source on both
  platforms with its own script, no fork; mainnet after NU7 (block 3,543,405, branch `0x77190ad9`).
- Vaulty (Expo 58, React Native 0.88) Release builds on iOS and Android with the module.
- Unified address with transparent, Sapling and Orchard-format receivers; Ironwood has no typecode
  of its own and shares the Orchard receiver (librustzcash `zcash_keys` 0.17), so the address
  receives into Ironwood after NU6.3.
- Sync from a birthday and per-pool balance on mainnet after NU7, on an iPhone 16 Pro and an Android
  emulator (mainnet receive: see the report).
- One seed for both worlds: the address's transparent receiver is `m/44'/133'/0'/0/j`, j being the
  diversifier index the SDK picked (0, 1 or 4 on our test seeds) — checked on the device
  against AWK's transparent package.
- 84 unit tests (ZIP-316 vectors, balance mapping, address checks, sync state).

## Measurements

| | iOS | Android |
|---|---|---|
| Device | iPhone 16 Pro, iOS 27.0.1 (high-end; no mid-range iPhone available) | Emulator, Android 16 (API 36), 2 cores, 2 GB RAM, arm64 on Apple Silicon (no physical low-end device) |
| App size, without → with module | IPA (zip, stripped) 24.1 → 47.4 MB (+23.3); executable 9.7 → 65.7 MB | APK arm64-v8a 61.8 → 117.9 MB (+56.1); native lib 53.6 MB (19.6 MB gzip) |
| First sync, birthday 3,520,000 (2026-10-16; 66.0k blocks iOS, 62.7k Android) | 308 s (5.1 min) | 1,135 s (18.9 min) |
| First sync, new wallet (checkpoint 3,580,000; ≈6.0k blocks iOS, ≈2.6k Android) | 32 s | 298 s |
| Memory during sync, median / max | footprint 165 / 178 MB, resident 259 / 306 MB | RSS 249 / 275 MB |
| CPU during sync (mean / p95, % of one core) | 124 % / 227 % of 600 % | 104 % / 141 % of 200 % |

Server: zec.rocks:443 (ECC lightwalletd v0.6.1, Zebra 7.1.0, NU7). Wrapper: react-native-zcash
`jon/zcash-nu7-sdks` @ ca9c738 (ZODL Swift SDK @ 03a7799, Android SDK 5.2.2 @ 42ebb78, rebuilt on the
final NU7 crates). Every number comes from one real run on the stated device (emulator 2026-11-17,
iPhone 2026-11-18, Release builds). iPhone CPU/memory: Instruments Activity Monitor; the phone reached
the "Serious" thermal state during the 2026-10-16 run, so its figures may include throttling.

## Limits and risks

1. **Licence (decision needed).** The NU7-capable path runs on the ZODL SDKs, which are
   AGPL-3.0-only and grant no App Store permission; distribution through the App Store needs a ZODL
   commercial licence. The only MIT path (ECC SDKs, react-native-zcash 0.13.6) has no NU7. Our plan:
   ask ZODL for an App Store exception for the React Native wrapper (or a licence for AWK users), and
   keep our TypeScript layer MIT OR Apache-2.0 either way.
2. **App size.** The native library adds ≈ 56 MB uncompressed per ABI, mostly Tor, coinholder voting
   and Keystone code the light wallet does not use. We propose Cargo features upstream.
3. **Toolchain.** Until ZODL tags an NU7 release, the wrapper builds the SDKs from source (Rust
   1.97.1, NDK 27.0.12077973, ≈ 20 min). We will consume a tagged release as soon as one exists.
4. **Integration gaps** for Expo / static-pod apps (modular headers on iOS, desugaring and minSdk 27
   on Android) — we contribute a config plugin upstream.
5. **Emulator, not phone, for Android numbers.** The low-end Android figures above are from an
   emulator; a real low-end device is part of M1.

## What goes upstream

To react-native-zcash: an Expo config plugin; a toolchain check in `update-sources`; rejecting
instead of crashing on storage errors; a viewing-key init so the seed does not cross the bridge on
every start. To ZODL: optional Tor / voting / Keystone features. To both: the licence question for
React Native wallets in the App Store.
