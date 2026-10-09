// Deploys the three models to a local Camunda 8 Run and drives scenario instances to completion
// by acting as job workers, task users and external participants (message publishers).
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:8080/v2';
const AUTH = 'Basic ' + Buffer.from('demo:demo').toString('base64');
const REPO = path.join(__dirname, '..');

async function api(method, url, body) {
  const r = await fetch(BASE + url, {
    method, headers: { Authorization: AUTH, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${t}`);
  return t ? JSON.parse(t) : {};
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function deploy(files) {
  const fd = new FormData();
  for (const f of files) fd.append('resources', new Blob([fs.readFileSync(path.join(REPO, f))]), f);
  const r = await fetch(BASE + '/deployments', { method: 'POST', headers: { Authorization: AUTH }, body: fd });
  const t = await r.text();
  if (!r.ok) throw new Error('deploy failed: ' + t);
  return JSON.parse(t);
}

function jobTypes(file) {
  const x = fs.readFileSync(path.join(REPO, file), 'utf8');
  return [...new Set([...x.matchAll(/zeebe:taskDefinition type="([^"]+)"/g)].map(m => m[1]))];
}

async function run(sc) {
  let key;
  if (sc.start.message) {
    await api('POST', '/messages/publication', { name: sc.start.message, correlationKey: '', variables: sc.vars });
    for (let i = 0; i < 40 && !key; i++) {
      await sleep(500);
      const r = await api('POST', '/variables/search', { filter: { name: sc.idVar, value: JSON.stringify(sc.vars[sc.idVar]) } });
      const hit = (r.items || [])[0];
      if (hit) key = hit.processInstanceKey;
    }
  } else {
    const r = await api('POST', '/process-instances', { processDefinitionId: sc.process, variables: sc.vars });
    key = r.processInstanceKey;
  }
  const trail = [];
  const counts = {};
  const published = new Set();
  const doneTasks = new Set();
  const t0 = Date.now();
  for (let tick = 0; tick < 200 && Date.now() - t0 < 150000; tick++) {
    let acted = false;
    for (const type of sc.types) {
      const r = await api('POST', '/jobs/activation', { type, maxJobsToActivate: 5, timeout: 2000, worker: 'test-driver', requestTimeout: 1 });
      for (const job of r.jobs || []) {
        if (job.processInstanceKey !== key) { await api('POST', `/jobs/${job.jobKey}/failure`, { retries: job.retries, retryBackOff: 0 }).catch(() => {}); continue; }
        counts[type] = (counts[type] || 0) + 1;
        const h = sc.jobs[type];
        const res = typeof h === 'function' ? h(counts[type], job.variables) : (h || {});
        if (res.error) {
          await api('POST', `/jobs/${job.jobKey}/error`, { errorCode: res.error, errorMessage: 'simulated' });
          trail.push(`${job.elementId} !${res.error}`);
        } else {
          await api('POST', `/jobs/${job.jobKey}/completion`, { variables: res });
          trail.push(job.elementId);
        }
        acted = true;
      }
    }
    const ut = await api('POST', '/user-tasks/search', { filter: { processInstanceKey: key, state: 'CREATED' } });
    for (const t of ut.items || []) {
      if (doneTasks.has(t.userTaskKey)) continue;
      doneTasks.add(t.userTaskKey);
      counts[t.elementId] = (counts[t.elementId] || 0) + 1;
      const h = sc.users[t.elementId];
      const vars = typeof h === 'function' ? h(counts[t.elementId]) : (h || {});
      try { await api('POST', `/user-tasks/${t.userTaskKey}/completion`, { variables: vars }); }
      catch (e) { if (!String(e).includes('404')) throw e; continue; }
      trail.push(`${t.elementId} (user)`);
      acted = true;
    }
    const ei = await api('POST', '/element-instances/search', { filter: { processInstanceKey: key, state: 'ACTIVE' } });
    if (sc.stopAt && (ei.items || []).some(e => e.elementId === sc.stopAt)) {
      return { key, state: `WAITING at ${sc.stopAt} (timer, as designed)`, trail };
    }
    for (const e of ei.items || []) {
      const m = sc.msgs[e.elementId];
      const tag = e.elementInstanceKey;
      if (m && !published.has(tag)) {
        published.add(tag);
        const spec = typeof m === 'function' ? m() : m;
        await api('POST', '/messages/publication', { name: spec.name, correlationKey: spec.key, variables: spec.vars || {}, timeToLive: 60000 });
        trail.push(`~ msg ${spec.name}`);
        acted = true;
      }
    }
    const inc = await api('POST', '/incidents/search', { filter: { processInstanceKey: key, state: 'ACTIVE' } });
    if ((inc.items || []).length) {
      return { key, state: 'INCIDENT', trail, detail: inc.items.map(i => `${i.elementId}: ${i.errorType} ${i.errorMessage}`) };
    }
    const pi = await api('POST', '/process-instances/search', { filter: { processInstanceKey: key } });
    const st = pi.items && pi.items[0] && pi.items[0].state;
    if (st === 'COMPLETED' || st === 'TERMINATED') {
      const ends = await api('POST', '/element-instances/search', { filter: { processInstanceKey: key, type: 'END_EVENT' } });
      return { key, state: st, trail, ends: (ends.items || []).map(e => e.elementName || e.elementId) };
    }
    if (!acted) await sleep(700);
  }
  const ei = await api('POST', '/element-instances/search', { filter: { processInstanceKey: key, state: 'ACTIVE' } });
  return { key, state: 'STUCK', trail, waitingAt: (ei.items || []).map(e => e.elementId) };
}

module.exports = { api, deploy, run, jobTypes, sleep };
