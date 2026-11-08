import { expect, test } from "bun:test";
import { startDashboard } from "../src/dashboard/server.ts";
const result = () => ({proposal:{inputs:[],recipients:[{address:'tsp1test',amount_sat:1000}]},totals:{input_sat:1300,payment_sat:1000,fee_sat:300,change_sat:0}});
function setup(actions:any = {}, ttl=300000) {
  const app:any={onChange(){}, snapshot:()=>({deviceReady:true,canPropose:true}),log(){},logLines:[],cfg:{pin:{}}};
  const d=startDashboard(app,{port:0,actions,reviewTtlMs:ttl});
  const post=(path:string,body:any={},extra:Record<string,string>={})=>fetch(d.url+path,{method:'POST',headers:{'x-vault':'1','content-type':'application/json',authorization:`Bearer ${d.token}`,...extra},body:JSON.stringify(body)});
  const review=async()=> (await (await post('/api/review',{recipients:[{amount_sat:1000}]})).json()).reviewId;
  return {...d,post,review};
}
test("all commands and event streams require a valid per-launch token",async()=>{
  const d=setup();
  try {
    for(const path of ['/api/review','/api/payment','/api/sign','/api/cancel','/api/broadcast','/events']) {
      expect((await fetch(d.url+path)).status).toBe(401);
    }
    expect((await d.post('/api/sign',{}, {authorization:'Bearer '+'é'.repeat(64)})).status).toBe(401);
    expect((await d.post('/api/sign',{}, {origin:'https://attacker.example'})).status).toBe(403);
    expect((await d.post('/api/sign',{}, {host:'attacker.example'})).status).toBe(403);
    expect((await d.post('/api/sign',{}, {'sec-fetch-site':'cross-site'})).status).toBe(403);
    const root=await fetch(d.url);
    expect(root.headers.get('x-frame-options')).toBe('DENY');
    expect((await root.text()).includes(d.token)).toBe(false);
    const other=setup();
    try { expect((await other.post('/api/sign',{}, {authorization:`Bearer ${d.token}`})).status).toBe(401); } finally {other.close();}
  }finally{d.close();}
});
test("review is read-only; approval uses exact stored proposal and rejects body edits and reuse",async()=>{
  let proposed:any;
  const d=setup({review:async()=>result(),proposeReviewed:async(p:any)=>{proposed=p;}});
  try{
    const id=await d.review(); expect(proposed).toBeUndefined();
    expect((await d.post('/api/payment',{reviewId:id,recipients:[]})).status).toBe(400);
    expect((await d.post('/api/payment',{reviewId:id})).status).toBe(200);
    expect(proposed).toEqual(result().proposal);
    expect((await d.post('/api/payment',{reviewId:id})).status).toBe(400);
  }finally{d.close();}
});
test("expired, superseded and changed reviews cannot start signing",async()=>{
  let changed=false, proposed=0;
  const d=setup({review:async()=>{const r=result();if(changed)r.totals.fee_sat++;return r;},proposeReviewed:async()=>{proposed++;}});
  try{
    const old=await d.review(); const id=await d.review();
    expect((await d.post('/api/payment',{reviewId:old})).status).toBe(400);
    changed=true;
    expect((await d.post('/api/payment',{reviewId:id})).status).toBe(400);
    expect(proposed).toBe(0);
  }finally{d.close();}
  const expired=setup({review:async()=>result(),proposeReviewed:async()=>{proposed++;}},1);
  try{const id=await expired.review();await new Promise(r=>setTimeout(r,10));expect((await expired.post('/api/payment',{reviewId:id})).status).toBe(400);expect(proposed).toBe(0);}finally{expired.close();}
});
test("overlapping approvals submit only once, even while the bridge is waiting",async()=>{
  let count=0;let release!:()=>void;
  const wait=new Promise<void>(r=>release=r);
  const d=setup({review:async()=>result(),proposeReviewed:async()=>{count++;await wait;}});
  try{
    const id=await d.review();const first=d.post('/api/payment',{reviewId:id});
    while(!count)await new Promise(r=>setTimeout(r,5));
    expect((await d.post('/api/payment',{reviewId:id})).status).toBe(400);
    release();expect((await first).status).toBe(200);expect(count).toBe(1);
  }finally{release();d.close();}
});
test("signer-only dashboard has no payment creation capability and no file proposal endpoint",async()=>{
  const d=setup();try{
    expect((await d.post('/api/review')).status).toBe(400);
    expect((await d.post('/api/payment')).status).toBe(400);
    expect((await d.post('/api/propose',{file:'/tmp/arbitrary'})).status).toBe(404);
  }finally{d.close();}
});
