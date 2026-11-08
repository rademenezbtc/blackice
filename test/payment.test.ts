import { expect, test } from "bun:test";
import { Transaction } from "@scure/btc-signer";
import { bytesToHex } from "@noble/hashes/utils.js";
import { encodeSpAddress, G } from "../src/sp.ts";
import { reviewPayment, type PaymentDraft } from "../src/payment.ts";
const tx = new Transaction();
tx.addInput({ txid: "00".repeat(32), index: 0 });
tx.addOutput({ script: new Uint8Array([81,32,...G.toBytes(true).slice(1)]), amount: 10000n });
const raw = bytesToHex(tx.toBytes(true, false));
const draft = (): PaymentDraft => ({ inputs:[{txid:tx.id,vout:0,index:0,internal:false}],recipients:[{address:encodeSpAddress(G,G.multiply(2n)),amount_sat:1000}],fee_sat:300,change_index:1 });
const fetcher = (spent = false, confirmed = true) => (async (url: any) => new Response(String(url).endsWith('/hex') ? raw : JSON.stringify(String(url).endsWith('/status') ? {confirmed} : {spent}))) as typeof fetch;
test("review computes change from the fetched transaction and preserves paths", async () => {
  const r = await reviewPayment(draft(),fetcher());
  expect(r.totals).toEqual({input_sat:10000,payment_sat:1000,fee_sat:300,change_sat:8700});
  expect(r.proposal.inputs[0].transaction).toBe(raw);
  expect(r.proposal.change?.index).toBe(1);
});
test("rejects spent, unconfirmed and duplicate coins", async () => {
  await expect(reviewPayment(draft(),fetcher(true))).rejects.toThrow("spent");
  await expect(reviewPayment(draft(),fetcher(false,false))).rejects.toThrow("not confirmed");
  const d=draft(); d.inputs.push({...d.inputs[0]});
  await expect(reviewPayment(d,fetcher())).rejects.toThrow("twice");
});
test("rejects invalid amounts, mainnet addresses, insufficient funds and dust change", async () => {
  for (const amount of [-1, 1.5, 10000, 9500]) {
    const d=draft(); d.recipients[0].amount_sat=amount;
    await expect(reviewPayment(d,fetcher())).rejects.toThrow();
  }
  const d=draft(); d.recipients[0].address=encodeSpAddress(G,G.multiply(2n),'main');
  await expect(reviewPayment(d,fetcher())).rejects.toThrow("Signet");
});
test("does not trust mismatched funding transaction bytes", async () => {
  const d=draft(); d.inputs[0].txid='11'.repeat(32);
  await expect(reviewPayment(d,fetcher())).rejects.toThrow("does not match");
});
