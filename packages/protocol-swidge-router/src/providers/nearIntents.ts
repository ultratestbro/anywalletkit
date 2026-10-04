// Explicit named re-export: esbuild cannot see through `export *` from an external package when
// a sibling imports a name from here, so the symbol the engine needs is listed by name.
export {nearIntentsProvider} from "@forgewallet/protocol-swidge-near-intents/provider";
export * from "@forgewallet/protocol-swidge-near-intents/provider";
