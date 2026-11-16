import {defineConfig} from "tsup";
export default defineConfig({entry: ["src/abi.ts", "src/amounts.ts", "src/registry.ts", "src/deployments.ts"], format: ["esm", "cjs"], dts: true, sourcemap: true, clean: true, target: "es2022", platform: "neutral", external: ["viem"]});
