---
"@anywalletkit/kit": patch
---

The TON body reader no longer guesses at layouts it does not model: a BoC with more than one root, or with a cell that stores its hashes (`with_hashes`) or has a level mask, is `destinationUnknown`, and so is a non-string `body` without the methods of a real `Cell` (`toBoc`, `hash`, `refs`). A with_hashes BoC let a dApp hide a jetton transfer behind a zero hash area that this reader took for an empty comment.
