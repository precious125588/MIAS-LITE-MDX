'use strict';
const fs   = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const TYPES = ['system','pairing','telegram','error','admin'];
const FILES  = {};
TYPES.forEach(t => { FILES[t] = path.join(LOG_DIR, `${t}.log`); });
const MAX_LINES = 2000;
const _bufs = {};

const emitter = new EventEmitter();
emitter.setMaxListeners(200);

function _getBuf(type) {
    if (!_bufs[type]) {
        try { const r=fs.existsSync(FILES[type])?fs.readFileSync(FILES[type],'utf8').trim():''; _bufs[type]=r?r.split('\n'):[]; }
        catch { _bufs[type]=[]; }
    }
    return _bufs[type];
}
function _write(type, level, message, meta={}) {
    if (!FILES[type]) type='system';
    const buf   = _getBuf(type);
    const entry = { ts: new Date().toISOString(), level, type, message, ...meta };
    const line  = JSON.stringify(entry);
    buf.push(line);
    if (buf.length > MAX_LINES) buf.splice(0, buf.length - MAX_LINES);
    try { fs.writeFileSync(FILES[type], buf.join('\n')+'\n','utf8'); } catch {}
    emitter.emit('entry', entry);
}

function log(type,msg,meta)   { _write(type,'INFO',msg,meta); }
function warn(type,msg,meta)  { _write(type,'WARN',msg,meta); }
function error(type,msg,meta) { _write(type,'ERROR',msg,meta); }
function readLog(type, limit=200) {
    return _getBuf(type).slice(-limit).reverse().map(l=>{ try{return JSON.parse(l);}catch{return{ts:'',level:'RAW',message:l};}});
}
function clearLog(type) { _bufs[type]=[]; try{fs.writeFileSync(FILES[type],'','utf8');}catch{} }
module.exports = { log, warn, error, readLog, clearLog, emitter };
