'use strict';
const fs   = require('fs');
const path = require('path');

const REGISTRY_FILE = path.join(require('../sessionPaths').nexstoreRoot(), 'session_registry.json');
let _cache = null, _dirty = false, _saveTimer = null;
const _dbWrites = new Map();
function persist(row, remove = false) {
    const key = typeof row === 'string' ? row : row.jid;
    const snapshot = typeof row === 'object' ? { ...row } : row;
    const pending = (_dbWrites.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
        const store = require('../mias/sessionPersistence.cjs');
        if (remove) await store.deleteRegistryEntry(key);
        else await store.saveRegistryEntry(snapshot);
    }).catch(e => console.warn('[session-registry] DB sync pending:', e?.code || 'FAILED'));
    _dbWrites.set(key, pending);
    pending.finally(() => { if (_dbWrites.get(key) === pending) _dbWrites.delete(key); });
}


function _load() {
    if (_cache) return _cache;
    try { _cache = fs.existsSync(REGISTRY_FILE) ? JSON.parse(fs.readFileSync(REGISTRY_FILE,'utf8')) : {}; }
    catch { _cache = {}; }
    return _cache;
}
function _scheduleSave() {
    if (_saveTimer) return;
    _saveTimer = setTimeout(() => { _saveTimer = null; _flush(); }, 300);
}
function _flush() {
    if (!_dirty || !_cache) return;
    try {
        fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
        const tmp = `${REGISTRY_FILE}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(_cache,null,2), 'utf8');
        fs.renameSync(tmp, REGISTRY_FILE);
        _dirty = false;
    } catch {}
}

function register(jid, source, extra={}) {
    const d=_load(), now=new Date().toISOString();
    d[jid]={jid, number:jid.replace('@s.whatsapp.net',''), source:source||'web',
             pairedAt:d[jid]?.pairedAt||now, lastActivity:now, status:'connecting',
             telegramUserId:extra.telegramUserId||d[jid]?.telegramUserId||null, ...extra};
    _dirty=true; _scheduleSave(); persist(d[jid]); return d[jid];
}
function updateStatus(jid, status) {
    const d=_load(); if (!d[jid]) return false;
    d[jid].status=status; d[jid].lastActivity=new Date().toISOString();
    _dirty=true; _scheduleSave(); persist(d[jid]); return true;
}
function unregister(jid) { const d=_load(); if(!d[jid])return false; delete d[jid]; _dirty=true; _scheduleSave(); persist(jid, true); return true; }
function get(jid)        { return _load()[jid]||null; }
function getAll()        { return Object.values(_load()); }
function getBySource(s)  { return Object.values(_load()).filter(x=>x.source===s); }
function has(jid)        { return !!_load()[jid]; }
function count()         { return Object.keys(_load()).length; }
function getAnalytics() {
    const all=Object.values(_load()), now=Date.now(), ts=t=>t?new Date(t).getTime():0;
    return { total:all.length, web:all.filter(s=>s.source==='web').length,
             telegram:all.filter(s=>s.source==='telegram').length,
             today:all.filter(s=>ts(s.pairedAt)>=now-86400000).length,
             week:all.filter(s=>ts(s.pairedAt)>=now-7*86400000).length,
             connected:all.filter(s=>s.status==='connected').length };
}
function flush() { _flush(); }
process.on('exit', _flush); process.on('SIGTERM', _flush);
module.exports = { register, updateStatus, unregister, get, getAll, getBySource, has, count, getAnalytics, flush };
