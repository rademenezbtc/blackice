# Security scope

BlackIce is an experimental **Signet-only** sender. Successful simulated and
hardware payments are functional evidence, not a cryptographic audit or a claim
of mainnet readiness.

## Local application boundary

- The HTTP listener binds to `127.0.0.1`. Requests must name the exact loopback
  host and port. Foreign Origin headers and cross-site fetches are rejected.
- Every launch generates a random 256-bit bearer token. Commands and the event
  stream require it; the unauthenticated HTML contains no token or wallet state.
- The launcher opens a URL with the token in its fragment (not its HTTP request).
  The page removes that fragment, keeps the token in tab session storage, and
  authenticates fetch requests with a header. A server restart invalidates old
  tokens. CLI-only users receive the private launch link in their local terminal.
  Do not share that link or terminal output containing it.
- Responses disable caching; the page disallows framing, external connections,
  object embeds and arbitrary scripts. CSP authorizes the exact bundled script
  hash. Requests have a 128-KiB limit. There is no browser file-path proposal API;
  explicit local CLI file proposals remain supported.

These controls target drive-by web requests, DNS rebinding and unauthorized local
HTTP clients without the launch token. They do not protect a compromised OS,
malicious browser extension, same-user process that can read credentials, or a
malicious/modified BlackIce executable. Hardware review remains essential.

## Review and approval

The server stores the reviewed draft and prepared proposal in memory, returns a
random single-use review ID, and expires it after five minutes. Only the latest
completed review remains valid. Starting a payment accepts that ID alone; it
cannot carry replacement inputs or recipients. The ID is consumed before any
asynchronous recheck, including when the attempt subsequently fails.

The server rechecks confirmation and spendability using the saved draft and
requires the resulting proposal and totals to match the stored review exactly.
Only the saved proposal reaches the signing coordinator. Overlapping browser
payment submissions are rejected. A failed or expired review requires another
review. A browser review does not itself prove wallet ownership: the bridge
checks input derivation against the wallet before device approval.

The explorer is an external trust/privacy dependency and sees selected funding
outpoints. A spend can race any unspent check. Neither the explorer nor a browser
summary replaces device verification or Bitcoin consensus checks.

## Remaining work before considering mainnet

- Independent review of the pinned Frostsnap PR #640 cryptography, including the
  upstream signing-randomization workaround and crash/retry/nonce recovery.
- Physical validation that recipient amounts, fees and change shown on-device
  are bound to the signed transaction, including batch review and truncation.
- Resolve and regression-test the earlier serial-decoding crash.
- Replace the explicit desktop development wrapping key with an OS-backed
  keystore; protect and test recovery of Marmot identities and local metadata.
- Improve out-of-band signer pairing and review of membership changes.
- Independent receiver verification for multi-input/multi-recipient hardware
  tests and stress tests before claiming batch-scale support.

No device firmware, private shares, existing wallet state, or signer identities
were migrated as part of the localhost/review hardening.
