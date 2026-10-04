// Explicit named re-export: esbuild cannot see through `export *` from an external package when
// a sibling imports a name from here, so the symbol the engine needs is listed by name.
export {omnistonProvider} from "@forgewallet/protocol-swidge-omniston/provider";
export * from "@forgewallet/protocol-swidge-omniston/provider";
