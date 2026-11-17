# react-native-zcash — upstream drafts (SDK-229)

Drafts only. **Nothing here has been filed.** Each item needs the owner's "yes" before it becomes an
issue or a PR on [EdgeApp/react-native-zcash](https://github.com/EdgeApp/react-native-zcash)
(or on the ZODL SDKs where noted). Our open issue there: #80 (no answer as of 2026-11-17).

Tested: branch `jon/zcash-nu7-sdks` @ `ca9c738` ("Build ZODL's Zcash SDKs on the final NU7 crates"),
built with its own `npm run update-sources` on macOS (Apple Silicon), Rust 1.97.1, Android NDK
27.0.12077973, Xcode 27 / iOS 27 SDK. App: Expo SDK 58, React Native 0.88 (New Architecture), pnpm.

| # | Where | What | Kind |
|---|---|---|---|
| U1 | react-native-zcash | Expo config plugin (iOS modular headers, Android desugaring + minSdk 27) | PR |
| U2 | react-native-zcash | iOS `pod install` fails in apps that link pods statically | issue (folded into U1) |
| U3 | react-native-zcash | Android needs core library desugaring and minSdk 27 in the app | issue (folded into U1) |
| U4 | react-native-zcash | `update-sources` needs NDK 27.0.12077973 exactly; the error says "NDK is not installed" | PR (docs + check) |
| U5 | react-native-zcash | `initialize` crashes (`try!`) instead of rejecting when a storage path fails | PR |
| U6 | react-native-zcash | Seed handling: the BIP-39 phrase crosses the bridge as a JS string on every init / spend | issue (design) |
| U7 | ZODL SDKs | Binary size: libzcashlc / libzcashwalletsdk carry Tor (arti), voting, Keystone even with Tor off | issue to ZODL |
| U8 | react-native-zcash / ZODL | Licence: NU7 path is AGPL-3.0-only, with no App Store permission | question |
| U9 | react-native-zcash | `AndroidManifest.xml` still sets `package=` (AGP warns it is ignored) | PR (one line) |
| U10 | react-native-zcash | Android module lacks `addListener` / `removeListeners` (RN warns on `new NativeEventEmitter`) | PR |
| U11 | react-native-zcash | NU7 branch ships stale checkpoints; `updateCheckpoints.ts` still assumes 75 s blocks | PR |

---

## U1 — PR: Expo config plugin

**Title:** Add an Expo config plugin (iOS modular headers, Android desugaring and minSdk)

**Body:**

> Expo apps (and any app whose Podfile links pods as static libraries, which is the Expo default)
> cannot install react-native-zcash today without hand-editing generated native projects:
>
> - iOS: `pod install` stops with *"The following Swift pods cannot yet be integrated as static
>   libraries"* — `SQLite.swift` → `sqlite3`, `gRPC-Swift` → `CGRPCZlib`, and SwiftNIO →
>   `CNIOAtomics`, `CNIOBoringSSL`, `CNIOBoringSSLShims`, `CNIODarwin`, `CNIOHTTPParser`,
>   `CNIOLinux`, `CNIOWindows` do not define modules.
> - Android (NU7 branch): `checkReleaseAarMetadata` fails — every `com.zodl.android:*` AAR
>   *"requires core library desugaring to be enabled for :app"*; then the manifest merger fails —
>   *"minSdkVersion 24 cannot be smaller than version 27 declared in library
>   [com.zodl.android:zcash-android-sdk-incubator]"*.
>
> This PR adds `app.plugin.js` that, during `expo prebuild`:
>
> 1. iOS: adds `pod '<name>', :modular_headers => true` for the nine C pods above to the app target;
> 2. Android: sets `compileOptions.coreLibraryDesugaringEnabled true`, adds
>    `coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:<version the SDK uses>'`, and raises
>    `android.minSdkVersion` to 27 when it is lower.
>
> Bare React Native apps can apply the same three edits by hand; the README gets a section for them.

**Minimal reproduction:**

```sh
npx create-expo-app@latest rnz-repro && cd rnz-repro
npm i react-native-zcash@<NU7 build>     # or a packed tarball of jon/zcash-nu7-sdks
npx expo prebuild
(cd ios && pod install)                  # → static-library module-map error
(cd android && ./gradlew assembleRelease) # → desugaring, then minSdk errors
```

What we applied locally (works, verified by a Release build on both platforms):

```ruby
# ios/Podfile, inside the app target
%w[sqlite3 CGRPCZlib CNIOAtomics CNIOBoringSSL CNIOBoringSSLShims CNIODarwin CNIOHTTPParser CNIOLinux CNIOWindows].each do |c_pod|
  pod c_pod, :modular_headers => true
end
```

```groovy
// android/app/build.gradle
android { compileOptions { coreLibraryDesugaringEnabled true } }
dependencies { coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.1.5' }
// android/gradle.properties
android.minSdkVersion=27
```

## U4 — PR: say which NDK `update-sources` needs

**Title:** update-sources: check the NDK version before building the Android SDK

> `buildAndroidSdk()` builds `zodl-android-wallet-sdk`, whose `gradle.properties` pins
> `ANDROID_NDK_VERSION=27.0.12077973`. With only another 27.x installed (27.1.12297006 here) the
> build fails after ~20 min of Rust work with *"NDK is not installed"* and *"Task with name
> 'cargoBuild' not found in project ':backend-lib'"*, which does not say which NDK is missing.
>
> This PR reads the pinned version from the checkout before any compilation and fails fast with the
> exact version and the `sdkmanager "ndk;27.0.12077973"` command. It also lists the full toolchain in
> the README: Rust 1.97.1 (the patches pin it), the four Android Rust targets, NDK 27.0.12077973,
> JDK 17+ (Android Studio's JBR works), Xcode with the iOS SDK.

Timing for reference (Apple M-series, 2026-11-17): first full run ≈ 23 min (iOS libzcashlc ≈ 20 min
of it), second run ≈ 21 min (Android Rust for four ABIs + Gradle publish 8 m 48 s).

## U5 — PR: reject instead of crash on storage-path errors

**Title:** iOS: initialize rejects when a wallet path cannot be created

> `RNZcash.initialize` builds the `Initializer` with seven `try!` calls (`cacheDbURLHelper`,
> `fsBlockDbRootURLHelper`, `generalStorageURLHelper`, `dataDbURLHelper`, `torDirURLHelper`,
> `spendParamsURLHelper`, `outputParamsURLHelper`, `ios/RNZcash.swift` lines 101–109). Any of them
> throwing (Documents directory unavailable, disk full) terminates the app instead of rejecting the
> promise. This PR moves the construction inside the existing `do/catch` and rejects with
> `InitializeError`.

## U6 — issue: keep the phrase out of the JS bridge where the SDK does not need it

**Title:** Initialize from a viewing key; take seed bytes, not the phrase, for spends

> `initialize`, `createTransfer` and `shieldFunds` take the BIP-39 phrase as a JS string, so the
> phrase sits in the JS heap (immutable, not wipeable) and crosses the bridge on every app start and
> every spend. Syncing only needs the UFVK: the SDK creates the account from the seed once and then
> scans with the viewing key.
>
> Proposal (backwards compatible):
> 1. `initialize({ ..., ufvk })` — when the account already exists, open it by UFVK
>    (`listAccounts().first { $0.ufvk == ufvk }`, which the module already does) without the phrase;
>    import by UFVK (`importAccount(ufvk:…)`) for a watch-only start.
> 2. Accept `seedBytesHex` as an alternative to `mnemonicSeed` / `seed` (like `deriveViewingKey`
>    already does), so apps that keep only the 64-byte seed can zero their copy.
> 3. Document that the phrase is not stored by the module.
>
> We are happy to send the PR if this direction is welcome.

## U7 — issue to ZODL: size of the native library

**Title:** Make Tor / voting / Keystone optional features of the FFI library

> Measured in an Expo 58 app, Release, arm64 (2026-11-17):
>
> | | without the SDK | with the SDK | delta |
> |---|---|---|---|
> | iOS executable (symbols stripped) | 9.66 MB | 65.70 MB | +56.0 MB |
> | iOS IPA (zip, stripped) | 24.1 MB | 47.4 MB | +23.3 MB |
> | Android APK arm64-v8a | 61.8 MB | 117.9 MB | +56.1 MB |
>
> `libzcashwalletsdk.so` alone is 53.6 MB (19.6 MB gzip -9); the iOS static library is 75 MB.
> `Cargo.toml` pulls `arti-client` / `tor-*`, the coinholder voting stack and Keystone UR in
> unconditionally, even though wallets that pass `isTorEnabled: false` never use Tor. Cargo features
> (`tor`, `voting`, `keystone`, default on) would let light wallets ship a much smaller library.

## U8 — question: licence of the NU7 path

**Title:** Licensing of react-native-zcash on the ZODL SDKs (AGPL-3.0-only) and App Store apps

> `master` (0.13.6) builds on ECC's MIT-licensed SDKs 2.7.0-rc.4, which never gained NU7.
> `jon/zcash-nu7-sdks` vendors the ZODL Swift SDK sources into `ios/ZCashLightClientKit` and ships the
> ZODL Android SDK in `android/maven`; both are AGPL-3.0-only, and their `LICENSE-EXCEPTIONS.md`
> grants no App Store permission (section 3b) — a commercial licence from ZODL is required for that
> channel.
>
> Questions: (1) Will the published package state AGPL-3.0-only for the NU7 releases (package.json
> says MIT)? (2) Is Edge's App Store build covered by a ZODL commercial licence, and could ZODL offer
> an App Store exception for the React Native wrapper so third-party RN wallets can ship Ironwood?

## U9 — PR: drop `package=` from the manifest

> AGP 8+ prints *"Setting the namespace via the package attribute in the source AndroidManifest.xml
> is no longer supported"*; `namespace 'app.edge.rnzcash'` is already in `build.gradle`.
> One-line removal in `android/src/main/AndroidManifest.xml`.

## U10 — PR: event-emitter stubs on Android

> On RN 0.88 every app start logs *"`new NativeEventEmitter()` was called with a non-null argument
> without the required `removeListeners` method"*. The iOS module subclasses `RCTEventEmitter`; the
> Android module needs the two no-op `@ReactMethod`s `addListener(eventName: String)` and
> `removeListeners(count: Int)`.

## U11 — PR: refresh checkpoints on the NU7 branch; 25-second blocks

> `jon/zcash-nu7-sdks` carries checkpoints up to 3,510,000 (iOS) / 3,500,000 (Android). The SDK
> starts a new wallet at the nearest checkpoint at or below its birthday, so a wallet created on
> 2026-11-17 (tip ≈ 3,582,500) scanned ≈ 82k blocks: 854 s on a 2-core emulator, against 298 s after
> `npm run update-checkpoints` (checkpoint 3,580,000). `prepack` runs it, so a published package is
> fine — this matters for anyone building the branch directly.
>
> `scripts/updateCheckpoints.ts` still has `blockTimeSeconds: 75` and the comment "75 second blocks";
> since NU7 (block 3,543,405) blocks are 25 s, so the "days to next checkpoint" estimate is 3× too
> long. Make the block time height-aware or just say blocks.
