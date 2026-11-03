import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoginLimiter } from '../login-limiter.mjs';
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dinner-limits-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));let time=1000000;const options={now:()=>time};return {dir,options,limiter:await createLoginLimiter(dir,options),advance:delta=>time+=delta};}
test('five reservations persist across restart and expire after the window without sleeping',async t=>{
 const f=await fixture(t);for(let i=0;i<5;i++)assert.equal((await f.limiter.reserve('192.0.2.1','admin')).allowed,true);
 const blocked=await f.limiter.reserve('192.0.2.1','other');assert.equal(blocked.allowed,false);assert.equal(blocked.retryAfter,900);assert.equal(blocked.logBlocked,true);
 const restarted=await createLoginLimiter(f.dir,f.options);assert.equal((await restarted.reserve('192.0.2.1','new-name')).logBlocked,false);
 f.advance(900001);assert.equal((await restarted.reserve('192.0.2.1','admin')).allowed,true);
});
test('success releases only its own reservation and does not erase earlier failed attempts',async t=>{
 const {limiter}=await fixture(t);for(let i=0;i<4;i++)await limiter.reserve('192.0.2.1','admin');
 const good=await limiter.reserve('192.0.2.1','admin');await limiter.succeeded(good.receipt);
 assert.equal((await limiter.reserve('192.0.2.1','admin')).allowed,true);assert.equal((await limiter.reserve('192.0.2.1','admin')).allowed,false);
});
test('account budget survives IP rotation and spelling case rotation',async t=>{
 const {limiter}=await fixture(t);for(let i=0;i<10;i++)assert.equal((await limiter.reserve(`192.0.2.${i}`,i%2?'Admin':'admin')).allowed,true);
 assert.equal((await limiter.reserve('192.0.2.99','ADMIN')).allowed,false);
});
test('global hashing budget prevents unbounded work across different accounts and addresses',async t=>{
 const {limiter}=await fixture(t);for(let i=0;i<60;i++){const r=await limiter.reserve(`192.0.2.${i}`,`user-${i}`);assert.equal(r.allowed,true);await limiter.succeeded(r.receipt);}
 assert.equal((await limiter.reserve('192.0.2.200','fresh')).allowed,false);
});
test('concurrent reservations consume exactly five slots',async t=>{
 const {limiter}=await fixture(t);const burst=await Promise.all(Array.from({length:12},(_,i)=>limiter.reserve('192.0.2.1','user-'+i)));assert.equal(burst.filter(r=>r.allowed).length,5);
});
test('failed limiter persistence does not commit an in-memory reservation, and corrupted files fail closed',async t=>{
 const f=await fixture(t),file=path.join(f.dir,'login-limits.json');await fs.mkdir(file);
 await assert.rejects(f.limiter.reserve('192.0.2.1','admin'));await fs.rmdir(file);
 for(let i=0;i<5;i++)assert.equal((await f.limiter.reserve('192.0.2.1','admin')).allowed,true);
 await fs.writeFile(file,'invalid json');await assert.rejects(createLoginLimiter(f.dir));
});
