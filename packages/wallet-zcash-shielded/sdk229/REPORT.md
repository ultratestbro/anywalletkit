# SDK-229 — прототип shielded ZEC (Ironwood) на react-native-zcash: отчёт

Дата прогонов: 2026-11-17 (Android-эмулятор, размеры), 2026-11-18 (iPhone). Ветка AWK: `feat/zcash-shielded-proto` (worktree `~/anywalletkit-zec-shielded`),
ветка Vaulty: `feat/zcash-shielded-proto` (worktree `~/vaulty-zec`). Ничего не запушено и не опубликовано.

## Коротко

| | Статус |
|---|---|
| NU7-ветка react-native-zcash собирается без форка (iOS + Android) | ✅ штатный `update-sources`; нужен NDK ровно 27.0.12077973 |
| Vaulty (Expo 58, RN 0.88, New Architecture) Release с модулем | ✅ iOS и Android; три правки нативных проектов (см. «Интеграция») |
| Пакет `@anywalletkit/wallet-zcash-shielded` | ✅ `getAddress`, `getBalance`, `onSyncProgress`; 84 теста |
| Unified-адрес с Ironwood + transparent | ✅ `p2pkh · sapling · orchard(0x03)`; Ironwood делит Orchard-получатель |
| Синк от birthday, баланс по пулам на mainnet после NU7 | ✅ Android-эмулятор и iPhone 16 Pro |
| Приём ZEC на UA (mainnet, txid) | ⏳ ждёт перевода от владельца |
| Замеры | ✅ размер iOS/Android; синк, CPU, память на эмуляторе и на iPhone 16 Pro |
| **Лицензия** | ⚠️ NU7-путь = ZODL SDK, **AGPL-3.0-only, App Store запрещён без коммерческой лицензии** |

## 1. Сборка обёртки на NU7

- react-native-zcash `jon/zcash-nu7-sdks` @ `ca9c738` (23.10, «Build ZODL's Zcash SDKs on the final NU7 crates»).
  В ветке нет готовых бинарников: `scripts/updateSources.ts` клонирует ZODL Swift SDK @ `03a7799`,
  Android SDK 5.2.2 @ `42ebb78`, `zcash_voting`, `zodl-slipstream`, накатывает патчи на финальные
  NU7-крейты и собирает Rust сам.
- Тулчейн: Rust 1.97.1, таргеты `aarch64-apple-ios(-sim)` + 4 Android ABI, Android NDK
  **27.0.12077973** (с 27.1 падает с «NDK is not installed» после 20 минут сборки), JDK 21 (JBR из
  Android Studio), Xcode 27.0 (27A266a).
- Время на M-серии: первый прогон ≈ 23 мин (iOS ≈ 20), второй ≈ 21 мин (Android Rust + Gradle publish
  8 мин 48 с). Артефакты: `ios/libzcashlc.xcframework` 143 MB, `android/maven` 91 MB, npm-тарбол 139 MB.
- Чекпоинты в ветке старые: до 3 510 000 (iOS) / 3 500 000 (Android). Обновлены штатным
  `npm run update-checkpoints` (часть `prepack` у Edge) до 3 580 000 — без этого «свежий» кошелёк
  сканирует от 3 500 000 (~82 тыс. блоков). Все итоговые замеры — с обновлёнными чекпоинтами.
- master 0.13.6 не собирали: он на ECC SDK 2.7.0-rc.4, у которого NU7 нет (сами мейнтейнеры пишут,
  что ECC SDK закрыт и NU7 не получил).

**Сервер:** `zec.rocks:443` — ECC LightWalletD v0.6.1 (сборка 2026-11-02) на Zebra 7.1.0,
branch id `77190ad9` (NU7). `na.zec.rocks` — то же; `eu.zec.rocks` не ответил.

## 2. Что работает на mainnet

- **Синхронизатор** открывается за 3–8 с, первое событие баланса сразу, синк до `synced`.
- **UA:** получатели `p2pkh(0x00) · sapling(0x02) · orchard(0x03)`. Отдельного Ironwood-типкода нет:
  librustzcash `zcash_keys` 0.17, `Address::can_receive_as` — «Ironwood shares the Orchard receiver».
  В API это поле `canReceiveIronwood` (на устройстве `true`).
- **Баланс по пулам** transparent / Sapling / Orchard / Ironwood (spendable, total, pending) — bigint.
- **Ключи из того же seed:** transparent-получатель UA = `m/44'/133'/0'/0/j`, где j — индекс
  диверсификатора, который выбрал SDK (первый годный для Sapling). Это **не всегда 0**: на трёх
  тестовых фразах эмулятора j = 1, 4, 1; на фразе iPhone j = 0. Ключ тот же, путь тот же, отличается только индекс адреса.
  Проверено в приложении: адрес SDK найден среди `@anywalletkit/wallet-zcash` getAccount(0…63);
  на векторах ZIP-316 (account 0, j = 0) совпадение побайтно — тест в пакете.
  **Следствие для M2:** у одного кошелька два «основных» t-адреса (AWK #0 и UA #j). Нужно
  решить: показывать в transparent-части Vaulty адрес #j, либо проверить, что SDK видит средства
  на #0 (gap limit transparent-сканирования в librustzcash) — проверить переводом.
- **Приём на UA:** _ждёт перевода (txid — сюда)._

## 3. Замеры

Все цифры — реальные прогоны (эмулятор 2026-11-17, iPhone 2026-11-18), n = 1 на точку.

### Размер (Release, arm64)

| | без модуля | с модулем | прирост |
|---|---|---|---|
| iOS: исполняемый файл (symbols stripped, как в archive) | 9.66 MB | 65.70 MB | **+56.0 MB** |
| iOS: `.app` (stripped) | 67.9 MB | 128.2 MB | +60.3 MB |
| iOS: IPA (zip, stripped) | 24.1 MB | 47.4 MB | **+23.3 MB** |
| Android: APK arm64-v8a | 61.8 MB | 117.9 MB | **+56.1 MB** |
| Android: `libzcashwalletsdk.so` | — | 53.6 MB (19.6 MB gzip -9) | |
| JS-бандл | 22.79 MB | 22.95 MB | +0.16 MB |

Почти весь прирост — Rust-библиотека; в ней Tor (arti), coinholder voting и Keystone, хотя Tor в
обёртке выключен. Плюс ≈ 1 300 JSON-чекпоинтов на Android.

### Синк, CPU, память

| Устройство | Прогон | Скан от → до | Блоков | До `synced` | CPU ср. / p95 | Память медиана / макс |
|---|---|---|---|---|---|---|
| Android-эмулятор* | 2026-10-16 | 3 520 000 → 3 582 650 | 62 650 | **1 135 с (18.9 мин)** | 104 % / 141 % (из 200) | RSS 249 / 275 MB |
| Android-эмулятор* | fresh | 3 580 000 → 3 582 580 | ≈ 2 580 | **298 с** | 73 % / 103 % | RSS 242 / 249 MB |
| iPhone 16 Pro, iOS 27.0.1** | 2026-10-16 | 3 520 000 → 3 585 957 | 65 957 | **308 с (5.1 мин)** | 124 % / 227 % (из 600) | footprint 165 / 178 MB; resident 259 / 306 MB |
| iPhone 16 Pro, iOS 27.0.1** | fresh | 3 580 000 → 3 585 962 | ≈ 5 960 | **32 с** | 157 % / 190 % (из 600) | footprint 174 / 175 MB; resident 292 / 293 MB |

\* Эмулятор Android 16 (API 36, Google Play arm64), 2 ядра, 2 GB RAM, на Mac с Apple Silicon.
**Не физическое low-end устройство** — его нет. CPU — доля одного ядра по тикам `/proc/<pid>/stat`,
каждые 10 с; память — VmRSS. Первые прогоны со старыми чекпоинтами (1 366 с и 854 с) в таблицу
не вошли. Первая попытка сэмплить через `dumpsys meminfo` выбросила: он вызывает GC в приложении
(паузы до 8 с) и искажает замер.

\*\* iPhone 16 Pro (iPhone17,1, 6 ядер: 2 P + 4 E), iOS 27.0.1 (24A446), Release-сборка, по кабелю
(заряжался). Время — от «open» до статуса `synced` по журналу самого экрана (AsyncStorage `zec-bench`,
снят с устройства через `devicectl`). CPU и память — Instruments, шаблон Activity Monitor, все процессы,
сэмпл ≈ 1 с: CPU = прирост CPU time процесса / время (% одного ядра), p95 — по окнам 5 с; footprint —
physical footprint (по нему iOS выгружает приложение), resident — real memory. До прогона (экран
открыт, синка нет): CPU 8 %, footprint 144 MB.
**Нагрев:** по Instruments телефон перешёл в Fair через 3.5 мин записи и в **Serious** через 7.7 мин —
прогон «2026-10-16» шёл первые 1.5 мин в Fair, остальное в Serious, «fresh» — целиком в Serious.
Возможен термотроттлинг, т. е. цифры iPhone скорее консервативные.
Первая попытка на iPhone не вошла в таблицу: прогоны «2026-10-16» и «fresh» запустили с разницей 13 с
(второй останавливает первый), затем «fresh» переоткрыли. Повтор — с новыми alias, без вмешательства.

iPhone 16 Pro — high-end; mid-range iPhone нет.

**Находка (iOS):** первый `StatusEvent` `SYNCING` на iOS не доходит до JS (на Android доходит) — пока
синк идёт, статус оставался `disconnected`. Исправлено в нашем слое: прогресс < 100 % от живого
сервера при статусе `disconnected` считается `syncing` (тест в пакете). Черновик для Edge — UPSTREAM U12.

## 4. Интеграция в Expo-приложение (правки, которые пришлось сделать)

1. **iOS, Podfile:** `:modular_headers => true` для `sqlite3`, `CGRPCZlib`, `CNIOAtomics`,
   `CNIOBoringSSL`, `CNIOBoringSSLShims`, `CNIODarwin`, `CNIOHTTPParser`, `CNIOLinux`, `CNIOWindows` —
   иначе `pod install` падает (Swift-поды в статических библиотеках).
2. **Android, app/build.gradle:** `coreLibraryDesugaringEnabled true` + `desugar_jdk_libs:2.1.5`.
3. **Android, gradle.properties:** `android.minSdkVersion=27` (у Vaulty было 24).
4. Для pnpm: `NODE_PATH` при сборке (известная особенность Vaulty, не Zcash). Android R8:
   `-dontwarn java.awt.Component` (тоже не Zcash).
5. Однажды инкрементальная iOS-сборка после переустановки зависимостей упала в `expo-sqlite`
   (`cannot find 'exsqlite3_*'`); чистая сборка прошла. Риск: в приложении два модуля `sqlite3`
   (`SQLite.swift` → pod `sqlite3` и собственный sqlite у `expo-sqlite`).

Пункты 1–3 — кандидат на Expo config plugin в upstream (UPSTREAM.md U1).

## 5. Лицензия — нужно решение владельца

- react-native-zcash сам — MIT. Но NU7-ветка **вендорит исходники ZODL Swift SDK** в
  `ios/ZCashLightClientKit` и кладёт ZODL Android SDK в `android/maven`.
- ZODL Swift SDK и ZODL Android SDK — **AGPL-3.0-only** (Znewco, Inc. d/b/a ZODL). Их
  `LICENSE-EXCEPTIONS.md` §3b: исключения для App Store **нет**; для App Store и подобных каналов
  нужна коммерческая лицензия (`licensing@zodl.com`). `COMMERCIAL-LICENSE.md`: при AGPL весь код
  приложения должен быть доступен пользователям под AGPL.
- MIT-путь (master 0.13.6 на ECC SDK) — без NU7, на mainnet после 6.11 не годится для отправки.
- librustzcash (Rust-крейты) — MIT/Apache, к ним вопросов нет.
- Наш TS-слой — MIT OR Apache-2.0 и кода ZODL не содержит.

**Что это значит:** выпустить Vaulty с этим модулем в App Store без договорённости с ZODL нельзя.
Эту dev-сборку нельзя отдавать в TestFlight / App Store. Для заявки ZCG варианты:
(а) запросить у ZODL App Store exception для RN-обёртки или лицензию для пользователей AWK — указать
в заявке как зависимость M1; (б) строить напрямую на librustzcash (MIT/Apache) — противоречит
«свой стек не пишем»; (в) форк MIT-SDK ECC с NU7-патчами — противоречит «без форка».
Рекомендую (а) и вопрос в issue Edge (UPSTREAM.md U8).

## 6. Upstream

Черновики — `UPSTREAM.md` (U1–U12), ничего не отправлено. Главное: Expo config plugin, проверка
NDK в `update-sources`, `try!` → reject в `initialize`, init по UFVK без фразы, размер Rust-библиотеки
(Tor/voting/Keystone как Cargo-фичи), лицензия, устаревшие чекпоинты и 75-секундные блоки в
`updateCheckpoints.ts`, `removeListeners` в Android-модуле, первый `SYNCING` на iOS теряется.

## 7. Открытые вопросы

1. Лицензия ZODL (раздел 5) — решение владельца до подачи.
2. Транспарентный индекс j ≠ 0 (раздел 2) — выбрать поведение для M2.
3. Физический low-end Android — нет устройства; эмулятор не заменяет.
4. Mid-range iPhone — нет; есть только iPhone 16 Pro.
5. Ответ Edge в issue #80 — нет.

## Где что лежит

- Пакет: `packages/wallet-zcash-shielded/` (AWK, ветка `feat/zcash-shielded-proto`).
- Экран Vaulty: `mobile/app/zec-shielded.tsx` (ветка `feat/zcash-shielded-proto`), ссылка в
  Settings только при `EXPO_PUBLIC_ZEC_SHIELDED_PROTO=1`. Тестовый seed — отдельный namespace
  Keychain `vaulty-zec-proto` (на эмуляторе — только в памяти сессии).
- Сырые замеры: `~/zcash-proto/traces/*.tsv`, `*.bench.log`; логи сборок `~/zcash-proto/*.log`;
  размеры `~/zcash-proto/size/`.
