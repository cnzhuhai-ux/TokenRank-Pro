import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import worker from '../src/worker.js';
import {requestFixture} from './helpers/request-fixture.mjs';
import {beijingDay} from '../src/lib.js';
import {reserveReminder,reminderStatus,runReminders,nextDaily,cancelReminder} from '../src/reminders.js';
import {createFeishuService} from '../src/feishu.js';
import {deleteAccount} from '../src/account.js';

function setup(t){const f=requestFixture(t,worker,{groups:1,users:2});f.db.exec("UPDATE users SET openid='feishu:ou_test' WHERE id=1; INSERT INTO connect_tokens(token,user_id,created_at,last_report_at) VALUES('connect',1,1,1)");Object.assign(f.env,{FEISHU_REMINDERS_ENABLED:'1',FEISHU_APP_ID:'app',FEISHU_APP_SECRET:'secret'});return f;}
test('calendar snapshot contract whitelists private fields and defaults to no amounts',async t=>{
 const f=setup(t),month=beijingDay().slice(0,7);f.db.exec(`UPDATE daily_totals SET cost_json='{"basis":"reported","currency":"USD","status":"complete","usd_micros":12345,"models":[]}'`);
 const calendar=await f.req('/api/my/calendar?month='+month);assert.match(calendar.data.snapshot,/^[a-f0-9]{64}$/);
 const body={style:'calendar',month,calendar_snapshot:calendar.data.snapshot};
 const share=await f.req('/api/shares',1,body);assert.equal(share.status,200);assert.equal(share.data.style,'calendar');assert.equal(share.data.usage.calendar.show_amount,false);
 assert.doesNotMatch(JSON.stringify(share.data),/cost|usd_micros|top_model|platform|first_day|device|snapshot/);
 assert.equal((await f.req('/api/shares/'+share.data.id,0)).status,200);
 const amount=await f.req('/api/shares',1,{...body,show_amount:true});assert.equal(amount.status,200);assert.ok(amount.data.usage.calendar.heatmap.details.cost);assert.notEqual(amount.data.id,share.data.id);
 assert.equal((await f.req('/api/shares',1,{...body,calendar_snapshot:'stale'})).status,409);
 f.db.exec('UPDATE daily_totals SET tokens=tokens+1');assert.equal((await f.req('/api/shares',1,body)).status,409);
 f.db.exec('UPDATE users SET disabled_at=1 WHERE id=1');assert.equal((await f.req('/api/shares/'+share.data.id,0)).status,404);
 for(const path of ['/api/profile','/api/profile/ranking','/api/connect/token','/api/shares','/api/groups/g1/leave'])assert.equal((await f.req(path,1,{nickname:'自定义',hidden:true})).status,403);
});
test('custom profile persists marker; owner and member leave only themselves',async t=>{
 const f=setup(t);assert.equal((await f.req('/api/profile',1,{nickname:'自定义昵称'})).status,200);assert.equal(f.db.prepare('SELECT nickname_custom FROM user_profile_preferences WHERE user_id=1').get().nickname_custom,1);
 assert.equal((await f.req('/api/groups/g1/leave',0,{})).status,401);
 const before=f.db.prepare('SELECT * FROM daily_totals').all();assert.equal((await f.req('/api/groups/g1/leave',1,{})).status,200);
 assert.equal(f.db.prepare('SELECT owner_user_id FROM rank_groups WHERE id=\'g1\'').get().owner_user_id,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM rank_group_members WHERE group_id=\'g1\'').get().n,1);assert.deepEqual(f.db.prepare('SELECT * FROM daily_totals').all(),before);
 assert.equal((await f.req('/api/groups/g1/leave',2,{})).status,200);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM rank_groups').get().n,1);
});
test('OAuth refresh keeps explicit custom nickname and uploaded avatar; board and PK use OAuth avatar fallback',async t=>{
 const f=setup(t);await f.req('/api/profile',1,{nickname:'自定义昵称'});
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});globalThis.fetch=async url=>Response.json(url.includes('app_access_token')?{code:0,app_access_token:'app-token'}:url.includes('/authen/v1/access_token')?{code:0,data:{access_token:'user-token'}}:{code:0,data:{open_id:'ou_test',name:'OAuth新昵称',avatar_240:'https://img.test/new.png'}});
 assert.equal((await f.req('/api/feishu/session',0,{code:'test-code'})).status,200);assert.equal(f.db.prepare('SELECT nickname,avatar_path FROM users WHERE id=1').get().nickname,'自定义昵称');assert.equal(f.db.prepare('SELECT avatar_path FROM users WHERE id=1').get().avatar_path,'1.png');
 f.db.exec("UPDATE users SET avatar_path=NULL,avatar_url='https://img.test/avatar.png' WHERE id=2");
 const board=await f.req('/api/leaderboard?scope=group&id=g1&period=day');assert.equal(board.status,200);assert.equal(board.data.entries[0].avatar_url,'https://img.test/avatar.png');
 const pk=await f.req('/api/groups/g1/compare',1,{period:'day',rank:1,snapshot:board.data.snapshot});assert.equal(pk.status,200);assert.equal(pk.data.comparison.source.user.avatar_url,'https://img.test/avatar.png');
 f.db.exec('UPDATE users SET disabled_at=1 WHERE id=1');assert.equal((await f.req('/api/feishu/session',0,{code:'test-code'})).status,403);
});
test('Feishu reminders derive identity, isolate legacy wx jobs, send once and reset both channels',async t=>{
 const f=setup(t),at=Date.now(),schedule=nextDaily(at-3600000),runAt=schedule.scheduled_at;
 f.db.prepare('DELETE FROM daily_totals WHERE user_id=1 AND day=?').run(schedule.report_day);f.seed(1,schedule.report_day,123);f.db.exec("INSERT INTO reminder_jobs(user_id,kind,id,request_id,template_id,state,created_at,updated_at) VALUES(1,'daily','legacy','legacy','wx','pending',1,1)");
 assert.equal((await reminderStatus(f.env,1)).channel,'feishu');assert.equal((await reserveReminder(f.env,1,'daily',{request_id:'request_00000001',touser:'other'},at)).status,400);
 await reserveReminder(f.env,1,'daily',{request_id:'request_00000001'},at-3600000);
 const calls=[];const options={now:runAt,send:async()=>{throw Error('wrong channel');},sendFeishu:async(env,payload)=>{calls.push(payload);return{state:'sent',code:null};}};
 await runReminders(f.env,options);await runReminders(f.env,options);assert.equal(calls.length,1);assert.equal(calls[0].touser,'feishu:ou_test');assert.equal(f.db.prepare('SELECT state FROM reminder_jobs').get().state,'pending');
 await reserveReminder(f.env,1,'daily',{request_id:'request_00000002'},at);const job=f.db.prepare('SELECT * FROM feishu_reminder_jobs').get();await cancelReminder(f.env,1,'daily',{id:job.id},at);assert.equal(f.db.prepare('SELECT state FROM feishu_reminder_jobs').get().state,'cancelled');
 await reserveReminder(f.env,1,'daily',{request_id:'request_00000003'},at);assert.equal((await f.req('/api/connect/token',1,{})).status,200);assert.equal(f.db.prepare('SELECT state FROM feishu_reminder_jobs').get().state,'cancelled');assert.equal(f.db.prepare('SELECT state FROM reminder_jobs').get().state,'cancelled');
 await deleteAccount(f.env,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM feishu_reminder_jobs').get().n,0);
});
test('credential reset and deletion during report build prevent a claimed send',async t=>{
 for(const action of ['reset','delete']){
  const f=setup(t),at=Date.now(),schedule=nextDaily(at-3600000);f.db.prepare('DELETE FROM daily_totals WHERE user_id=1 AND day=?').run(schedule.report_day);f.seed(1,schedule.report_day,1);
  await reserveReminder(f.env,1,'daily',{request_id:'request_race_0001'},at-3600000);
  const prepare=f.env.DB.prepare.bind(f.env.DB);let interrupted=false;
  f.env.DB.prepare=sql=>{const statement=prepare(sql);if(sql.startsWith('SELECT * FROM ranked_usage')){const all=statement.all.bind(statement);statement.all=async()=>{const result=await all();if(!interrupted){interrupted=true;if(action==='reset')await f.req('/api/connect/token',1,{});else await deleteAccount(f.env,1);}return result;};}return statement;};
  let sent=0;await runReminders(f.env,{now:schedule.scheduled_at,sendFeishu:async()=>{sent++;return{state:'sent',code:null};}});assert.equal(sent,0);assert.equal(interrupted,true);
 }
});
test('Feishu sync_error uses server-tracked continuous failure and is one-shot',async t=>{
 const f=setup(t),now=Date.now(),start=now-20*60000;
 await reserveReminder(f.env,1,'sync_error',{request_id:'request_error_001'},start);
 f.db.prepare("INSERT INTO sync_agents(user_id,device_id,client_version,platform,state,error_code,event_at,last_seen_at) VALUES(1,'selected','1','win32','error','UPLOAD_FAILED',?,?)").run(now,now);
 f.db.prepare("INSERT INTO feishu_reminder_failure_runs VALUES(1,'selected','error',?,?,?)").run(start,now,now);
 let sent=0;const options={now,sendFeishu:async()=>{sent++;return{state:'sent',code:null};}};await runReminders(f.env,options);await runReminders(f.env,options);assert.equal(sent,1);assert.equal(f.db.prepare('SELECT state FROM feishu_reminder_jobs').get().state,'sent');
});
test('0026 upgrade is repeatable and preserves legacy jobs and custom flags',async t=>{
 const f=setup(t),sql=readFileSync(new URL('../migrations/0026_feishu_reminders_profiles.sql',import.meta.url),'utf8');
 f.db.exec(sql);f.db.exec('UPDATE user_profile_preferences SET nickname_custom=0 WHERE user_id=1');const before=f.db.prepare('SELECT * FROM daily_totals').all();f.db.exec(sql);assert.equal(f.db.prepare('SELECT nickname_custom FROM user_profile_preferences WHERE user_id=1').get().nickname_custom,0);assert.deepEqual(f.db.prepare('SELECT * FROM daily_totals').all(),before);
});
test('Feishu links use safe deployment origin and server reminder metadata, never WeChat page',async()=>{
 const bodies=[],service=createFeishuService({fetcher:async(url,init)=>{if(url.includes('tenant_access_token'))return Response.json({code:0,tenant_access_token:'tenant'});bodies.push(JSON.parse(init.body));return Response.json({code:0});}});
 const env={FEISHU_APP_ID:'links',FEISHU_APP_SECRET:'secret',PUBLIC_BASE_URL:'https://rank.test/nested?secret=hidden#fragment'};
 const payload={touser:'feishu:ou_test',kind:'daily',report_day:'2026-10-18',page:'pages/private?token=do-not-leak',receive_id:'attacker',data:{thing1:{value:'日报'}}};
 await service.sendReminder(env,payload);assert.equal(bodies[0].receive_id,'ou_test');assert.equal(JSON.parse(bodies[0].content).text,'日报\n查看详情：https://rank.test/app/#/me?view=daily&day=2026-10-18');
 await service.sendReminder(env,{...payload,kind:'sync_error'});assert.match(JSON.parse(bodies[1].content).text,/https:\/\/rank\.test\/app\/#\/help$/);
 for(const base of ['javascript:alert(1)','https://user:pass@rank.test','not-a-url','http://rank.test']){await service.sendReminder({...env,PUBLIC_BASE_URL:base},payload);assert.equal(JSON.parse(bodies.at(-1).content).text,'日报');}
 await service.sendReminder(env,{...payload,report_day:'2026-02-30'});assert.equal(JSON.parse(bodies.at(-1).content).text,'日报');assert.doesNotMatch(JSON.stringify(bodies),/do-not-leak|attacker|nested|hidden|fragment|pages\//);
});
test('production Feishu transport caches tenant tokens and never retries ambiguous sends',async()=>{
 let tokens=0,sends=0,mode='ok';const bodies=[];const service=createFeishuService({fetcher:async(url,init)=>{
 if(url.includes('tenant_access_token')){tokens++;return Response.json({code:0,tenant_access_token:'tenant',expire:7200});}
 sends++;bodies.push(JSON.parse(init.body));if(mode==='timeout')throw Error('timeout');if(mode==='denied')return Response.json({code:230002,msg:'denied'});return Response.json({code:0,data:{message_id:'test'}});
 }});const env={FEISHU_APP_ID:'app',FEISHU_APP_SECRET:'secret'},payload={touser:'feishu:ou_test',data:{thing1:{value:'summary'}}};
 assert.equal((await service.sendReminder(env,payload)).state,'sent');await service.sendReminder(env,payload);assert.equal(tokens,1);assert.equal(bodies[0].receive_id,'ou_test');
 mode='denied';assert.deepEqual(await service.sendReminder(env,payload),{state:'failed',code:'FEISHU_230002'});mode='timeout';assert.equal((await service.sendReminder(env,payload)).state,'unknown');assert.equal(sends,4);
 assert.equal((await service.sendReminder(env,{...payload,touser:'wx-user'})).code,'INVALID_CHANNEL');assert.equal(sends,4);
 env.FEISHU_APP_SECRET='changed';await service.sendReminder(env,payload);assert.equal(tokens,2);
});
