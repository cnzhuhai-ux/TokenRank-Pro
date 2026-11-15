import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TOKEN_DETAIL_LIMITS } from './details.js';

const fields = ['tokens', 'input_tokens', 'output_tokens', 'cache_read', 'cache_write', 'requests'];
const count = (n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;

export function mergeCodebuddyDays(base = [], extra = []) {
  const days = new Map();
  for (const row of [...base, ...extra]) {
    let day = days.get(row.day);
    if (!day) {
      day = { ...row, ...Object.fromEntries(fields.map(k => [k, 0])), models: new Map(), tools: new Map(), tool_models: new Map() };
      days.set(row.day, day);
    }
    for (const k of fields) day[k] += count(row[k]);
    for (const k of ['models', 'tools', 'tool_models']) for (const entry of row[k] || []) {
      const key = JSON.stringify(entry.slice(0, -1));
      day[k].set(key, (day[k].get(key) || 0) + count(entry.at(-1)));
    }
  }
  return [...days.values()].sort((a,b) => a.day.localeCompare(b.day)).map(day => ({ ...day,
    ...Object.fromEntries(['models', 'tools', 'tool_models'].map(k => [k, [...day[k]].sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,TOKEN_DETAIL_LIMITS[k]).map(([key,n]) => [...JSON.parse(key),n])])) }));
}

// Only final per-step usage is counted. AgentReporter repeats the same usage;
// agent completion summaries are cumulative and must never be added to it.
export function collectCodebuddyDays({ home = homedir(), env = process.env, platform = process.platform, roots, log = () => {} } = {}) {
  const bases = platform === 'win32' ? [env.APPDATA || join(home,'AppData','Roaming')]
    : [platform === 'darwin' ? join(home,'Library','Application Support') : env.XDG_CONFIG_HOME || join(home,'.config')];
  roots ||= bases.flatMap(base => ['CodeBuddy CN','CodeBuddy','CodeBuddy International'].map(name => join(base,name,'logs')));
  const files = new Set();
  function walk(path, depth = 0) {
    if (depth > 10) return;
    let entries; try { entries = readdirSync(path,{withFileTypes:true}); } catch { return; }
    for (const entry of entries) {
      const p = join(path,entry.name);
      if (entry.isDirectory()) walk(p,depth+1);
      else if (entry.isFile() && /\.log(?:\.\d+)?$/i.test(entry.name)) files.add(p);
    }
  }
  roots.forEach(root => walk(root));
  const rows = [], seen = new Set();
  for (const file of [...files].sort()) {
    let lines; try { lines = readFileSync(file,'utf8').split(/\r?\n/); } catch { log('CodeBuddy 日志读取失败，已跳过'); continue; }
    const models = new Map(), candidates = new Map();
    // Initialization lines have no request id. Mixed models for one agent
    // cannot be attributed safely when requests overlap.
    for (const line of lines) {
      const agent = line.match(/\[BaseAgent:([^\]]+)\]/)?.[1];
      const model = line.match(/ModelProvider initialized, modelId: ([^,\s]+)/)?.[1];
      if (agent && model) {
        if (!candidates.has(agent)) candidates.set(agent, new Set());
        candidates.get(agent).add(model);
      }
    }
    for (const line of lines) {
      const agent = line.match(/\[BaseAgent:([^\]]+)\]/)?.[1];
      if (!agent) continue;
      const model = line.match(/ModelProvider initialized, modelId: ([^,\s]+)/)?.[1];
      if (model) { models.set(agent,model); continue; }
      if (!line.includes('notifyStepEnd,')) continue;
      const match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+) .*requestId: ([^,]+), messageId: ([^,]+), usage: (\{.*?\})/);
      if (!match) continue;
      const [,time,request,message,json] = match;
      const key = request + ':' + message;
      if (seen.has(key)) continue;
      let usage; try { usage = JSON.parse(json); } catch { continue; }
      const input = count(usage.inputTokens), output = count(usage.outputTokens);
      if (!input && !output) continue;
      const date = new Date(time.replace(' ','T'));
      if (!Number.isFinite(date.getTime())) continue;
      const cache = Math.min(input,count(usage.cacheTokens));
      const write = Math.min(input-cache,count(usage.cachedWriteTokens));
      const tokens = input + output, name = candidates.get(agent)?.size === 1 ? models.get(agent) || 'unknown' : 'unknown';
      seen.add(key);
      rows.push({ day: new Date(date.getTime()+8*3600000).toISOString().slice(0,10), tokens,
        input_tokens: input-cache-write, output_tokens: output, cache_read: cache, cache_write: write, requests: 1,
        models: [[name,tokens]], tools: [['CodeBuddy',tokens]], tool_models: [['CodeBuddy',name,tokens]] });
    }
  }
  return mergeCodebuddyDays([],rows);
}
