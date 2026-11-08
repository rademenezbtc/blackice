#!/bin/bash
set -e
cd "$(dirname "$0")/.."
read -r -p 'Local signer name [A]: ' signer_name
signer_name=${signer_name:-A}
if command -v bun >/dev/null 2>&1; then
  bun_bin=$(command -v bun)
elif [ -x "$HOME/.bun/bin/bun" ]; then
  bun_bin="$HOME/.bun/bin/bun"
elif [ -x "../.tools/bun-runtime/node_modules/.bin/bun" ]; then
  bun_bin="../.tools/bun-runtime/node_modules/.bin/bun"
else
  echo 'Bun is required. Install Bun, then open BlackIce again.'
  read -r -p 'Press Enter to close.'
  exit 1
fi
if [ ! -f "$HOME/.marmot-vault/$signer_name/config.json" ]; then
  echo "No BlackIce setup found for $signer_name. Follow the wallet import and signer pairing steps in README.md first."
  read -r -p 'Press Enter to close.'
  exit 1
fi
"$bun_bin" run src/cli.ts run --name "$signer_name" --open || { read -r -p 'BlackIce stopped. Press Enter to close.'; exit 1; }
