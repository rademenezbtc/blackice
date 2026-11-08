import { Transaction } from "@scure/btc-signer";
import { hexToBytes } from "@noble/hashes/utils.js";
import { decodeSpAddress } from "./sp.ts";

export const EXPLORER = "https://blockstream.info/signet/api";
export interface PaymentDraft {
  inputs: { txid: string; vout: number; index: number; internal: boolean }[];
  recipients: { address: string; amount_sat: number }[];
  fee_sat: number;
  change_index: number;
}
const integer = (n: unknown, label: string, min = 0, max = 2100000000000000): number => {
  if (!Number.isSafeInteger(n) || Number(n) < min || Number(n) > max) throw new Error(`${label} must be a whole number between ${min} and ${max}`);
  return Number(n);
};
export async function reviewPayment(draft: PaymentDraft, fetcher: typeof fetch = fetch) {
  if (!Array.isArray(draft?.inputs) || !draft.inputs.length || draft.inputs.length > 100) throw new Error("Select 1–100 wallet inputs");
  if (!Array.isArray(draft.recipients) || !draft.recipients.length || draft.recipients.length > 100) throw new Error("Add 1–100 recipients");
  const fee = integer(draft.fee_sat, "Fee", 1);
  const changeIndex = integer(draft.change_index, "Change address index", 0, 0x7fffffff);
  const recipients = draft.recipients.map(r => {
    if (typeof r.address !== "string" || decodeSpAddress(r.address).network !== "test") throw new Error("Use a Signet silent-payment address (tsp1)");
    return { address: r.address, amount_sat: integer(r.amount_sat, "Recipient amount", 330) };
  });
  const seen = new Set<string>();
  const selected = draft.inputs.map(i => {
    if (!/^[0-9a-f]{64}$/i.test(i.txid)) throw new Error("Enter a 64-character funding transaction ID");
    const txid = i.txid.toLowerCase();
    const vout = integer(i.vout, "Output number", 0, 0xffffffff);
    const index = integer(i.index, "Wallet address index", 0, 0x7fffffff);
    if (typeof i.internal !== "boolean") throw new Error("Select receive or change for each input");
    const outpoint = `${txid}:${vout}`;
    if (seen.has(outpoint)) throw new Error("The same coin was selected twice");
    seen.add(outpoint);
    return { txid, vout, index, internal: i.internal };
  });
  const read = async (path: string, json = true) => {
    const r = await fetcher(`${EXPLORER}/${path}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Signet explorer returned ${r.status}; please retry`);
    return json ? r.json() : r.text();
  };
  let total = 0;
  const inputs = [];
  for (const i of selected) {
    const [raw, status, spent] = await Promise.all([read(`tx/${i.txid}/hex`, false), read(`tx/${i.txid}/status`), read(`tx/${i.txid}/outspend/${i.vout}`)]);
    if (!status.confirmed) throw new Error(`Input ${i.txid}:${i.vout} is not confirmed yet`);
    if (spent.spent !== false) throw new Error(`Input ${i.txid}:${i.vout} is spent or unavailable`);
    const transaction = String(raw).trim();
    const tx = Transaction.fromRaw(hexToBytes(transaction));
    if (tx.id !== i.txid) throw new Error("Funding transaction ID does not match explorer data");
    if (i.vout >= tx.outputsLength) throw new Error("Funding output does not exist");
    total += Number(tx.getOutput(i.vout).amount);
    integer(total, "Input total");
    inputs.push({ ...i, transaction });
  }
  const payment = recipients.reduce((sum, r) => sum + r.amount_sat, 0);
  integer(payment, "Payment total");
  const change = total - payment - fee;
  if (change < 0) throw new Error("Selected coins do not cover the payment and fee");
  if (change > 0 && change < 330) throw new Error("Change is below 330 sats; adjust the payment or fee");
  return {
    proposal: { inputs, recipients, ...(change ? { change: { index: changeIndex, amount_sat: change } } : {}) },
    totals: { input_sat: total, payment_sat: payment, fee_sat: fee, change_sat: change },
  };
}
