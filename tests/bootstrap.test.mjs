import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

test('fresh installs require a deployment password and never seed a known default', async t => {
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'dinner-bootstrap-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  for(const [index,password] of [null,'short','x'.repeat(257)].entries()){
    const dataDir=path.join(parent,String(index));
    await assert.rejects(createApp({dataDir,initialAdminPassword:password}),/ADMIN_PASSWORD/);
    await assert.rejects(fs.access(path.join(dataDir,'state.json')));
  }
});

test('bootstrap stores only a salted hash, and restart never replaces existing accounts', async t => {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'dinner-bootstrap-existing-'));
  let server;
  t.after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await fs.rm(dataDir,{recursive:true,force:true});});
  async function start(password){server=await createApp({dataDir,initialAdminPassword:password});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));}
  await start('isolated-bootstrap-password');
  const before=JSON.parse(await fs.readFile(path.join(dataDir,'state.json'),'utf8'));
  assert.equal(before.accounts[0].username,'admin');assert.equal(before.accounts[0].role,'admin');
  assert.equal(before.accounts[0].salt.length,32);assert.equal(before.accounts[0].hash.length,128);
  assert.equal(JSON.stringify(before).includes('isolated-bootstrap-password'),false);
  assert.deepEqual(before.members,[]);assert.deepEqual(before.expenses,[]);
  await new Promise(resolve=>server.close(resolve));server=null;
  await start('');
  const after=JSON.parse(await fs.readFile(path.join(dataDir,'state.json'),'utf8'));
  assert.deepEqual(after.accounts,before.accounts);
});
