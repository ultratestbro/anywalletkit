import {defineConfig} from "tsup";
export default defineConfig({entry: ["src/index.ts", "src/provider.ts", "src/pins.ts", "src/protocol.ts", "src/tracking.ts", "src/abi.ts", "src/amounts.ts", "src/registry.ts", "src/deployments.ts", "src/quote.ts"], format: ["esm", "cjs"], dts: true, sourcemap: true, clean: true, target: "es2022", platform: "neutral", external: ["viem", /^@anywalletkit\//]});
