import { expect, test } from "bun:test";
import { startDashboard } from "../src/dashboard/server.ts";

test("review is read-only and payment submission rejects overlapping requests", async () => {
  let proposed = 0;
  let finish!: () => void;
  const blocked = new Promise<void>(r => finish = r);
  const app: any = { onChange() {}, snapshot: () => ({deviceReady:true,canPropose:true}), log() {} };
  const dashboard = startDashboard(app, {port:0,actions:{
    review: async () => ({totals:{fee_sat:300}}),
    proposePayment: async () => { proposed++; await blocked; },
  }});
  const post = (path:string, headers = {'x-vault':'1','content-type':'application/json'}) => fetch(dashboard.url+path,{method:'POST',headers,body:'{}'});
  try {
    expect((await post('/api/review')).status).toBe(200);
    expect(proposed).toBe(0);
    expect((await post('/api/payment', {} as any)).status).toBe(403);
    const first = post('/api/payment');
    while (!proposed) await new Promise(r => setTimeout(r,5));
    expect((await post('/api/payment')).status).toBe(400);
    expect(proposed).toBe(1);
    finish();
    expect((await first).status).toBe(200);
  } finally { finish(); dashboard.close(); }
});

test("signer-only dashboard cannot propose through the new form routes", async () => {
  const app: any = {onChange(){},log(){},snapshot:()=>({})};
  const dashboard = startDashboard(app,{port:0});
  try {
    for (const path of ['/api/review','/api/payment']) {
      const response = await fetch(dashboard.url+path,{method:'POST',headers:{'x-vault':'1','content-type':'application/json'},body:'{}'});
      expect(response.status).toBe(400);
    }
  } finally { dashboard.close(); }
});
