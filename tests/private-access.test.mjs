import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server.mjs';

async function fixture(t,options={}) {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'dinner-private-'));
  let server,base;
  async function start(){server=await createApp({dataDir,initialAdminPassword:'private-test-password',...options});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;}
  await start();t.after(async()=>{await new Promise(resolve=>server.close(resolve));await fs.rm(dataDir,{recursive:true,force:true});});
  async function request(route,{method='GET',body,auth,headers={}}={}) {
    const response=await fetch(base+route,{method,headers:{...(method==='POST'?{'Content-Type':'application/json',Origin:base}:{}),...(auth?{Cookie:auth.cookie,'X-CSRF-Token':auth.csrfToken}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    const raw=await response.text();let data;try{data=JSON.parse(raw);}catch{data=raw;}return {status:response.status,data,headers:response.headers};
  }
  async function login(){const r=await request('/api/login',{method:'POST',body:{username:'admin',password:'private-test-password'}});assert.equal(r.status,200);return {...r.data,cookie:r.headers.get('set-cookie').split(';')[0]};}
  async function restart(){await new Promise(resolve=>server.close(resolve));await start();}
  return {request,login,restart,dataDir,get base(){return base;}};
}
test('state, page settings and uploaded media require a valid session; health and release resources contain no ledger',async t=>{
  const f=await fixture(t);const auth=await f.login();
  const imageName='11111111-1111-4111-8111-111111111111.png';
  await fs.mkdir(path.join(f.dataDir,'uploads'),{recursive:true});await fs.writeFile(path.join(f.dataDir,'uploads',imageName),Buffer.from('synthetic private bytes'));
  for(const route of ['/api/state','/api/state?any=1','/api/content','/media/'+imageName]){
    for(const headers of [{},{Cookie:'dinner_session=forged','X-Forwarded-For':'127.0.0.1','X-Dinner-Client-IP':'127.0.0.1'}]){
      const r=await f.request(route,{headers});assert.equal(r.status,401,route);assert.equal(r.data.error,'login_required');assert.equal(r.headers.get('cache-control'),'no-store');
      assert.equal('members' in r.data,false);assert.equal('texts' in r.data,false);
    }
    assert.equal((await f.request(route,{auth})).status,200,route);
  }
  assert.equal((await f.request('/media/'+imageName,{method:'HEAD'})).status,401);
  const media=await f.request('/media/'+imageName,{method:'HEAD',auth});assert.equal(media.status,200);assert.equal(media.headers.get('cache-control'),'private, no-store');
  assert.deepEqual((await f.request('/api/health')).data,{ok:true});
  assert.equal((await f.request('/releases.js')).status,200);
  assert.equal((await f.request('/api/state',{auth})).headers.get('permissions-policy'),'camera=(), microphone=(), geolocation=()');
  assert.equal((await f.request('/')).headers.get('cache-control'),'no-store');
  assert.equal((await f.request('/api/logout',{method:'POST',body:{},auth})).status,200);
  for(const route of ['/api/state','/api/content','/media/'+imageName])assert.equal((await f.request(route,{auth})).status,401);
  await f.restart();assert.equal((await f.request('/api/state',{auth})).status,401);
});
test('five wrong logins exhaust the IP budget, forged forwarded addresses do not bypass it and restart preserves the lock',async t=>{
  const f=await fixture(t);
  for(let i=0;i<5;i++)assert.equal((await f.request('/api/login',{method:'POST',body:{username:'nonexistent-'+i,password:'wrong'},headers:{'X-Forwarded-For':`203.0.113.${i}`,'X-Dinner-Client-IP':`203.0.113.${i}`}})).status,401);
  const before=JSON.parse(await fs.readFile(path.join(f.dataDir,'state.json'),'utf8'));
  const blocked=await f.request('/api/login',{method:'POST',body:{username:'admin',password:'private-test-password'}});assert.equal(blocked.status,429);assert.ok(Number(blocked.headers.get('retry-after'))>0);
  await f.restart();assert.equal((await f.request('/api/login',{method:'POST',body:{username:'another',password:'wrong'}})).status,429);
  const limits=await fs.stat(path.join(f.dataDir,'login-limits.json'));assert.equal(limits.mode&0o777,0o600);
  const saved=JSON.parse(await fs.readFile(path.join(f.dataDir,'state.json'),'utf8'));assert.deepEqual(saved.accounts,before.accounts);assert.deepEqual(saved.members,before.members);assert.equal(saved.version,before.version);
});
test('a burst of concurrent wrong logins cannot exceed five password attempts',async t=>{
  const f=await fixture(t);
  const responses=await Promise.all(Array.from({length:9},(_,i)=>f.request('/api/login',{method:'POST',body:{username:'burst-'+i,password:'wrong'}})));
  assert.equal(responses.filter(r=>r.status===401).length,5);assert.equal(responses.filter(r=>r.status===429).length,4);
});
