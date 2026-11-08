'use strict';
// =====================================================================
//  بوت ماين كرافت (MineBot) v2 - ملف واحد: سيرفر + أسطول بوتات + واجهة
//  التشغيل:  cd ~/minebot && node بوت_ماين_كرافت.js
//  ثم افتح:  http://127.0.0.1:3000
//  متغيرات اختيارية: MC_HOST MC_PORT MC_USER MC_VERSION MC_OWNER MC_AUTH
//                     WEB_PORT WEB_HOST
//  الإعدادات تحفظ تلقائياً في:  ~/.minebot_data.json
// =====================================================================

const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const armorManager = require('mineflayer-armor-manager');
const { Vec3 } = require('vec3');

// مكتبات اختيارية: إن لم تكن مثبتة تعمل البقية بدونها
let viewerLib = null;
try { viewerLib = require('prismarine-viewer').mineflayer; } catch (e) { console.log('prismarine-viewer غير مثبتة: الكاميرا الحية 3D معطلة'); }
let collectPlugin = null;
try { collectPlugin = require('mineflayer-collectblock').plugin; } catch (e) { console.log('mineflayer-collectblock غير مثبتة: سيُستخدم جمع الخشب البسيط'); }
let viewerPortSeq = 3100;

const WEB = {
  port: parseInt(process.env.WEB_PORT || '3000', 10),
  host: process.env.WEB_HOST || '127.0.0.1'
};
const AUTH = process.env.MC_AUTH || 'offline';
const DATA_FILE = path.join(os.homedir(), '.minebot_data.json');
const RADAR_DIST = 24;

const DEFAULTS = {
  autoReconnect: true, autoDefense: true, autoEat: true, kiting: true,
  creeper: true, mlg: true, autoBridge: true, radar: true, autoSort: true, autoArmor: true
};

// ---------------------------- تحميل الواجهة ----------------------------
function loadHtml() {
  const src = fs.readFileSync(__filename, 'utf8');
  const startMark = '/*HTML' + '_START';
  const endMark = 'HTML' + '_END*' + '/';
  const a = src.indexOf(startMark);
  if (a === -1) throw new Error('لم يتم العثور على بداية كود الواجهة');
  const b = src.indexOf(endMark, a);
  if (b === -1) throw new Error('لم يتم العثور على نهاية كود الواجهة');
  return src.slice(a + startMark.length, b).trim();
}
let HTML;
try { HTML = loadHtml(); } catch (e) { console.error('خطأ في تحميل الواجهة:', e.message); process.exit(1); }

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.get('/', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML);
});

// ---------------------------- أدوات ----------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (t) => String(t == null ? '' : t).replace(/§[0-9a-fk-or]/gi, '');
const r1 = (n) => Math.round(n * 10) / 10;

function reasonText(r) {
  try {
    let o = r;
    if (typeof r === 'string') { try { o = JSON.parse(r); } catch (_) { return r; } }
    const out = [];
    (function walk(n) {
      if (n === null || n === undefined) return;
      if (typeof n === 'string') { out.push(n); return; }
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (typeof n === 'object') {
        if (n.text !== undefined) walk(n.text);
        if (n.translate !== undefined) walk(n.translate);
        if (n.value !== undefined) walk(n.value);
        if (n.extra !== undefined) walk(n.extra);
        if (n.with !== undefined) walk(n.with);
      }
    })(o);
    return out.join('') || JSON.stringify(r);
  } catch (e) { return String(r); }
}

// ---------------------------- الأسطول ----------------------------
const fleet = new Map();
let idSeq = 0;

function createCtl(x) {
  x = x || {};
  const id = x.id || ('b' + (++idSeq));
  if (x.id) { const n = parseInt(String(x.id).slice(1), 10); if (n > idSeq) idSeq = n; }
  const k = fleet.size + 1;
  const c = {
    id: id,
    label: x.label || ('Bot_' + k),
    cfg: Object.assign({ host: 'localhost', port: 25565, username: 'MineBot' + k, version: '', owner: '' }, x.cfg || {}),
    settings: Object.assign({}, DEFAULTS, x.settings || {}),
    chest: x.chest || null,
    chests: x.chests || [],
    home: x.home || null,
    schedule: x.schedule || [],
    bot: null, status: 'disconnected', mode: 'idle', task: '',
    manualStop: true, reconnectTimer: null, attempts: 0, eating: false,
    token: 0, logs: [], path: [], shelter: null, fighting: false, fleeing: false,
    lastHit: 0, backUntil: 0, lastHurt: 0, bridging: false, mlgBusy: false,
    radarSeen: {}, ctlTimers: {}, ctlActive: {}, manualUntil: 0, mapCache: null,
    lastSort: 0, noFoodWarned: false, swordEquipped: false, lastEmergency: 0
  };
  fleet.set(id, c);
  return c;
}

function saveData() {
  try {
    const d = {
      bots: Array.from(fleet.values()).map((c) => ({
        id: c.id, label: c.label, cfg: c.cfg, settings: c.settings, chest: c.chest, chests: c.chests, home: c.home, schedule: c.schedule
      }))
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(d));
  } catch (e) { console.error('تعذر حفظ الإعدادات:', e.message); }
}

function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    (d.bots || []).forEach((x) => createCtl(x));
  } catch (e) { /* لا يوجد ملف بعد */ }
}

function logC(c, type, text) {
  const e = { id: c.id, t: Date.now(), type: type, text: clean(text).slice(0, 400) };
  c.logs.push(e);
  if (c.logs.length > 200) c.logs.shift();
  io.emit('log', e);
  console.log('[' + c.label + '] ' + e.text);
}

function isFleetName(n) {
  for (const c of fleet.values()) if (c.cfg.username === n) return true;
  return false;
}

function setStatus(c, s) { c.status = s; }

// ---------------------------- دورة حياة البوت ----------------------------
function scheduleReconnect(c) {
  if (c.reconnectTimer || c.manualStop || !c.settings.autoReconnect) return;
  c.attempts++;
  const delay = Math.min(5000 * c.attempts, 30000) + Math.floor(Math.random() * 3000);
  setStatus(c, 'reconnecting');
  logC(c, 'sys', 'إعادة اتصال تلقائي بعد ' + Math.round(delay / 1000) + ' ثانية (محاولة ' + c.attempts + ')');
  c.reconnectTimer = setTimeout(() => { c.reconnectTimer = null; queueStart(c); }, delay);
}

function discardBot(c) {
  if (!c.bot) return;
  const old = c.bot;
  c.bot = null;
  try { old.quit(); } catch (_) { /* تجاهل */ }
}

function stopBot(c) {
  c.manualStop = true;
  const qi = startQueue.indexOf(c);
  if (qi !== -1) startQueue.splice(qi, 1);
  c.attempts = 0;
  if (c.reconnectTimer) { clearTimeout(c.reconnectTimer); c.reconnectTimer = null; }
  c.token++;
  discardBot(c);
  c.mode = 'idle'; c.task = ''; c.eating = false; c.shelter = null; c.fighting = false; c.fleeing = false;
  setStatus(c, 'disconnected');
  logC(c, 'sys', 'تم فصل البوت يدوياً');
}

function startBot(c) {
  if (c.reconnectTimer) { clearTimeout(c.reconnectTimer); c.reconnectTimer = null; }
  c.token++;
  discardBot(c);
  c.manualStop = false;
  c.mode = 'idle'; c.task = ''; c.eating = false; c.shelter = null; c.fighting = false; c.fleeing = false;
  c.noFoodWarned = false;
  setStatus(c, c.attempts > 0 ? 'reconnecting' : 'connecting');
  logC(c, 'sys', 'جاري الاتصال بـ ' + c.cfg.host + ':' + c.cfg.port + ' باسم ' + c.cfg.username + ' ...');

  let b;
  try {
    const opts = { host: c.cfg.host, port: c.cfg.port, username: c.cfg.username, auth: AUTH };
    if (c.cfg.version) opts.version = c.cfg.version;
    b = mineflayer.createBot(opts);
  } catch (e) {
    logC(c, 'err', 'فشل إنشاء البوت: ' + e.message);
    setStatus(c, 'disconnected');
    scheduleReconnect(c);
    return;
  }
  c.bot = b;

  try {
    b.loadPlugin(pathfinder);
    b.loadPlugin(armorManager);
    if (collectPlugin) b.loadPlugin(collectPlugin);
  } catch (e) { logC(c, 'err', 'خطأ في تحميل الإضافات: ' + e.message); }

  b.on('login', () => { if (c.bot === b) logC(c, 'sys', 'تم تسجيل الدخول إلى السيرفر'); });

  b.on('spawn', () => {
    if (c.bot !== b) return;
    c.attempts = 0;
    try {
      const mv = new Movements(b);
      mv.allowSprinting = true;
      b.pathfinder.setMovements(mv);
    } catch (e) { logC(c, 'err', 'تعذر ضبط الحركة: ' + e.message); }
    c.mode = 'idle'; c.task = ''; c.shelter = null; c.fighting = false; c.fleeing = false;
    setStatus(c, 'connected');
    logC(c, 'sys', 'البوت متصل وجاهز');
    if (!c.cfg.owner) logC(c, 'err', 'تنبيه: لم يتم تحديد اسم المشرف، أوامر الشات وتنبيهات الرادار معطلة');
  });

  b.on('messagestr', (msg) => { if (c.bot === b && msg) logC(c, 'chat', msg); });

  b.on('chat', (username, message) => {
    if (c.bot !== b || username === b.username) return;
    if (!isOwnerName(c, username)) return;
    if (typeof message !== 'string' || message.charAt(0) !== '!') return;
    const parts = message.slice(1).trim().split(/\s+/);
    if (parts[0]) runCmd(c, parts[0].toLowerCase(), parts.slice(1), 'chat');
  });

  b.on('death', () => { if (c.bot === b) { c.mode = 'idle'; c.task = ''; c.shelter = null; c.token++; logC(c, 'err', 'مات البوت'); } });
  b.on('health', () => { if (c.bot === b) autoEat(c); });
  b.on('entityHurt', (entity) => { if (c.bot === b && entity === b.entity) c.lastHurt = Date.now(); });
  b.on('physicsTick', () => { if (c.bot === b) mlgCheck(c); });

  b.on('kicked', (reason) => { logC(c, 'err', 'تم طرد البوت: ' + reasonText(reason)); });

  b.on('error', (err) => {
    logC(c, 'err', 'خطأ: ' + (err && err.message ? err.message : err));
    setTimeout(() => {
      if (c.bot === b && c.status !== 'connected') {
        discardBot(c);
        setStatus(c, 'disconnected');
        scheduleReconnect(c);
      }
    }, 3000);
  });

  b.on('end', (reason) => {
    if (c.bot !== b) return;
    c.bot = null;
    c.token++;
    c.mode = 'idle'; c.task = ''; c.eating = false; c.shelter = null; c.fighting = false; c.fleeing = false;
    setStatus(c, 'disconnected');
    logC(c, 'sys', 'انقطع الاتصال' + (reason ? ': ' + reason : ''));
    scheduleReconnect(c);
  });
}

// ---------------------------- مهام عامة ----------------------------
function clearControls(b) {
  try { b.clearControlStates(); } catch (_) { /* تجاهل */ }
}

function stopAll(c) {
  c.token++;
  const b = c.bot;
  if (b) {
    try { b.pathfinder.setGoal(null); } catch (_) { /* تجاهل */ }
    clearControls(b);
    try { b.stopDigging(); } catch (_) { /* تجاهل */ }
  }
  c.mode = 'idle'; c.task = ''; c.bridging = false; c.fighting = false; c.fleeing = false;
}

function startTask(c, mode, label) {
  stopAll(c);
  c.mode = mode;
  c.task = label;
  return c.token;
}

function endTask(c, my) {
  if (c.token === my) {
    c.mode = 'idle'; c.task = '';
    if (c.bot) clearControls(c.bot);
  }
}

async function calm(c, my) {
  while (c.token === my && c.bot && (c.fighting || c.shelter || c.fleeing)) await sleep(300);
  return c.token === my && !!c.bot;
}

function goTo(c, my, goal, timeout) {
  return new Promise((resolve) => {
    const b = c.bot;
    if (!b) { resolve(false); return; }
    let done = false;
    let tm = null;
    let iv = null;
    const fin = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(tm);
      clearInterval(iv);
      b.removeListener('goal_reached', onReached);
      b.removeListener('path_update', onPath);
      resolve(ok);
    };
    const onReached = () => fin(true);
    const onPath = (r) => { if (r && r.status === 'noPath') fin(false); };
    b.on('goal_reached', onReached);
    b.on('path_update', onPath);
    tm = setTimeout(() => fin(false), timeout || 30000);
    iv = setInterval(() => { if (c.token !== my || c.bot !== b) fin(false); }, 300);
    try { b.pathfinder.setGoal(goal); } catch (e) { fin(false); }
  });
}

async function walkStep(c, my, tx, tz) {
  const b = c.bot;
  const t0 = Date.now();
  b.setControlState('forward', true);
  try {
    while (Date.now() - t0 < 1800 && c.token === my && b.entity) {
      const p = b.entity.position;
      if (Math.hypot(p.x - tx, p.z - tz) < 0.3) break;
      await b.lookAt(new Vec3(tx, p.y + 1.6, tz), true);
      await sleep(60);
    }
  } finally {
    try { b.setControlState('forward', false); } catch (_) { /* تجاهل */ }
  }
}

function snapDir(b) {
  const yaw = b.entity.yaw;
  const sx = -Math.sin(yaw);
  const sz = -Math.cos(yaw);
  if (Math.abs(sx) > Math.abs(sz)) return { dx: sx > 0 ? 1 : -1, dz: 0 };
  return { dx: 0, dz: sz > 0 ? 1 : -1 };
}

const isSolid = (bl) => !!bl && bl.boundingBox === 'block';

// ---------------------------- الأكل التلقائي ----------------------------
const BAD_FOODS = [
  'rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish',
  'golden_apple', 'enchanted_golden_apple', 'chorus_fruit', 'suspicious_stew'
];

async function autoEat(c) {
  const b = c.bot;
  if (!b || c.eating || !c.settings.autoEat || c.status !== 'connected') return;
  if (typeof b.food !== 'number' || b.food > 14 || c.fighting) return;
  const foods = (b.registry && b.registry.foodsByName) || {};
  const cand = b.inventory.items().filter((i) => foods[i.name] && BAD_FOODS.indexOf(i.name) === -1);
  if (!cand.length) {
    if (!c.noFoodWarned) { c.noFoodWarned = true; logC(c, 'err', 'الجوع منخفض ولا يوجد طعام في الحقيبة'); }
    return;
  }
  c.noFoodWarned = false;
  cand.sort((x, y) => foods[y.name].foodPoints - foods[x.name].foodPoints);
  c.eating = true;
  try {
    await b.equip(cand[0], 'hand');
    await b.consume();
    logC(c, 'sys', 'أكل تلقائي: ' + cand[0].name);
  } catch (e) { logC(c, 'err', 'تعذر الأكل: ' + e.message); } finally { c.eating = false; }
}

// ---------------------------- الأسلحة والأدوات ----------------------------
const SWORD_BASE = { netherite_sword: 8, diamond_sword: 7, iron_sword: 6, stone_sword: 5, golden_sword: 4, wooden_sword: 4 };

function enchList(it) {
  try {
    if (Array.isArray(it.enchants) && it.enchants.length) {
      return it.enchants.map((e) => ({ name: String(e.name || '').replace('minecraft:', ''), lvl: e.lvl || 0 }));
    }
    const list = it.nbt && it.nbt.value && it.nbt.value.Enchantments && it.nbt.value.Enchantments.value
      && it.nbt.value.Enchantments.value.value;
    if (Array.isArray(list)) {
      return list.map((e) => ({ name: String(e.id.value).replace('minecraft:', ''), lvl: Number(e.lvl.value) || 0 }));
    }
  } catch (_) { /* تجاهل */ }
  return [];
}

function enchLevel(it, name) {
  for (const e of enchList(it)) if (e.name === name) return e.lvl || 0;
  return 0;
}

function swordScore(it) {
  const base = SWORD_BASE[it.name];
  if (!base) return -1;
  const sharp = enchLevel(it, 'sharpness');
  return base + (sharp > 0 ? 0.5 * sharp + 0.5 : 0) + enchLevel(it, 'fire_aspect') * 0.3 +
    enchLevel(it, 'knockback') * 0.1 + enchLevel(it, 'unbreaking') * 0.1 + enchLevel(it, 'mending') * 0.1;
}

async function equipBestSword(c) {
  const b = c.bot;
  let best = null;
  let bs = -1;
  for (const it of b.inventory.items()) {
    const s = swordScore(it);
    if (s > bs) { bs = s; best = it; }
  }
  if (best && (!b.heldItem || b.heldItem.name !== best.name || swordScore(b.heldItem) < bs)) {
    try {
      await b.equip(best, 'hand');
      logC(c, 'sys', 'أمسك أقوى سيف: ' + best.name + (enchList(best).length ? ' (مسحور)' : ''));
    } catch (_) { /* تجاهل */ }
  }
  return !!best;
}

const PICKS = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'golden_pickaxe', 'wooden_pickaxe'];

function remaining(b, it) {
  try {
    const max = b.registry.items[it.type].maxDurability;
    let used = 0;
    if (it.durabilityUsed !== undefined) used = it.durabilityUsed;
    else if (it.nbt && it.nbt.value && it.nbt.value.Damage) used = it.nbt.value.Damage.value;
    return max ? max - used : 999;
  } catch (e) { return 999; }
}

async function ensurePickaxe(c) {
  const b = c.bot;
  for (const n of PICKS) {
    const list = b.inventory.items().filter((i) => i.name === n);
    for (const it of list) {
      if (remaining(b, it) > 4) {
        if (b.heldItem && b.heldItem.type === it.type && remaining(b, b.heldItem) > 4) return true;
        const wasPick = b.heldItem && PICKS.indexOf(b.heldItem.name) !== -1;
        try { await b.equip(it, 'hand'); } catch (_) { return false; }
        if (wasPick) logC(c, 'sys', 'تبديل البيكاكس تلقائياً: ' + it.name);
        return true;
      }
    }
  }
  for (const n of PICKS) {
    const it = b.inventory.items().find((i) => i.name === n);
    if (it) {
      try { await b.equip(it, 'hand'); } catch (_) { return false; }
      logC(c, 'err', 'بيكاكس قريب من الانكسار، أستخدمه حتى ينكسر');
      return true;
    }
  }
  return false;
}

function lavaNear(b, pos) {
  const offs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (const o of offs) {
    const bl = b.blockAt(pos.offset(o[0], o[1], o[2]));
    if (bl && bl.name === 'lava') return true;
  }
  return false;
}

async function digIfSolid(c, my, pos) {
  const b = c.bot;
  for (let k = 0; k < 4; k++) {
    const bl = b.blockAt(pos);
    if (!isSolid(bl) || bl.name === 'bedrock') return true;
    if (lavaNear(b, pos)) { logC(c, 'err', 'لافا بجانب الكتلة، توقف للسلامة'); return false; }
    if (!(await ensurePickaxe(c))) { logC(c, 'err', 'لا يوجد بيكاكس صالح في الحقيبة'); return false; }
    if (!b.canDigBlock(bl)) return false;
    try { await b.dig(bl); } catch (e) { return false; }
    await sleep(60);
    if (c.token !== my) return false;
  }
  return true;
}

const BRIDGE_BLOCKS = ['cobblestone', 'dirt', 'cobbled_deepslate', 'stone', 'netherrack', 'andesite', 'diorite', 'granite', 'oak_planks', 'spruce_planks'];

function pickBlockItem(b) {
  for (const n of BRIDGE_BLOCKS) {
    const it = b.inventory.items().find((i) => i.name === n);
    if (it) return it;
  }
  return null;
}

// ---------------------------- القتال والمراوغة ----------------------------
function isHostile(c, e) {
  if (!e || e === c.bot.entity || !e.position) return false;
  if (e.type === 'hostile') return true;
  if (e.type === 'mob' && /hostile/i.test(e.kind || '')) return true;
  return false;
}

function threatsNear(c, range) {
  const b = c.bot;
  const me = b.entity.position;
  const out = [];
  const hurtRecently = Date.now() - c.lastHurt < 3000;
  for (const id of Object.keys(b.entities)) {
    const e = b.entities[id];
    if (!e || e === b.entity || !e.position) continue;
    let ok = isHostile(c, e);
    if (!ok && hurtRecently && e.type === 'player' && e.username && e.username !== b.username) {
      const isOwner = isOwnerName(c, e.username);
      ok = !isOwner && !isFleetName(e.username) && e.position.distanceTo(me) <= 6;
    }
    if (!ok) continue;
    const d = e.position.distanceTo(me);
    if (d <= range) out.push({ e: e, d: d });
  }
  out.sort((x, y) => x.d - y.d);
  return out;
}

function awayYaw(from, to) {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

function runAway(c, fromPos) {
  const b = c.bot;
  const me = b.entity.position;
  const yaw = awayYaw(fromPos, me);
  b.look(yaw, 0, true);
  b.setControlState('back', false);
  b.setControlState('forward', true);
  b.setControlState('sprint', true);
  b.setControlState('jump', !!b.entity.isCollidedHorizontally);
}

// ---------------------------- الهروب والمراوغة ----------------------------
// المراوغة: يتبادل يمين ويسار أثناء الهروب عشان الأعداء ما يلحقونه بسهولة
function ensureDodge(c) {
  if (c.dodgeIv) return;
  c.dodgeIv = setInterval(() => {
    const b = c.bot;
    const fleeing = c.mode === 'retreat' || c.fleeing;
    if (!b || !fleeing) {
      clearInterval(c.dodgeIv);
      c.dodgeIv = null;
      if (b) { try { b.setControlState('left', false); b.setControlState('right', false); } catch (_) { /* تجاهل */ } }
      return;
    }
    c.dodgeSide = !c.dodgeSide;
    try {
      b.setControlState('left', c.dodgeSide);
      b.setControlState('right', !c.dodgeSide);
    } catch (_) { /* تجاهل */ }
  }, 650);
}

// الاتجاهات المفتوحة حوالين البوت (الرجلين والراس فاضيين)
function openDirs(b) {
  const p = b.entity.position.floored();
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => {
    const f = b.blockAt(p.offset(dx, 0, dz));
    const h = b.blockAt(p.offset(dx, 1, dz));
    return !isSolid(f) && !isSolid(h);
  });
}

// محصور: يكسر الجدار اللي يبعد عن العدو (الرجل والراس)
async function escapeTrap(c, threatPos) {
  const b = c.bot;
  if (!b || !b.entity) return false;
  const p = b.entity.position.floored();
  const cands = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    .map(([dx, dz]) => ({ pos: p.offset(dx, 0, dz), score: Math.hypot(p.x + dx - threatPos.x, p.z + dz - threatPos.z) }))
    .sort((a, b2) => b2.score - a.score);
  for (const cd of cands) {
    const bl = b.blockAt(cd.pos);
    if (!bl || !isSolid(bl) || bl.name === 'bedrock' || lavaNear(b, cd.pos)) continue;
    logC(c, 'err', 'محصور! أكسر الجدار للهروب');
    const my = c.token;
    const ok1 = await digIfSolid(c, my, cd.pos);
    const ok2 = ok1 && await digIfSolid(c, my, cd.pos.offset(0, 1, 0));
    if (ok2) return true;
  }
  return false;
}

async function combatTick(c) {
  const b = c.bot;
  if (!b || c.status !== 'connected' || !b.entity || b.health <= 0) return;
  if (c.shelter) { shelterTick(c); return; }
  if (Date.now() < c.manualUntil) return;
  if (!c.settings.autoDefense && !c.settings.creeper) return;

  const near = threatsNear(c, 16);
  const hp = b.health;

  // رادار الكريبر
  if (c.settings.creeper) {
    const cr = near.find((t) => t.e.name === 'creeper' && t.d < 7);
    if (cr) {
      if (!c.fleeing) logC(c, 'err', 'كريبر قريب! الابتعاد فوراً');
      c.fleeing = true;
      try { b.pathfinder.setGoal(null); } catch (_) { /* تجاهل */ }
      runAway(c, cr.e.position);
      return;
    }
  }
  if (c.fleeing) {
    c.fleeing = false;
    clearControls(b);
  }
  if (!c.settings.autoDefense) return;

  const mobs = near.filter((t) => t.e.name !== 'creeper' && t.d <= 8);

  // طوارئ: دم منخفض
  if (hp < 8 && mobs.length && Date.now() - c.lastEmergency > 15000) {
    emergency(c, mobs[0].e);
    return;
  }

  if (!mobs.length) {
    if (c.fighting) {
      c.fighting = false;
      c.swordEquipped = false;
      clearControls(b);
      try { b.pathfinder.setGoal(null); } catch (_) { /* تجاهل */ }
      if (c.mode === 'fighting' || c.mode === 'retreat') { c.mode = 'idle'; c.task = ''; }
    }
    return;
  }

  const n = mobs.length;
  // كل ما زاد عدد الأعداء، يبكّر بالانسحاب
  const retreatAt = n >= 4 ? 16 : n >= 2 ? 13 : 10;
  if (hp < retreatAt) {
    c.fighting = true;
    c.mode = 'retreat';
    c.task = 'انسحاب (' + n + ' أعداء، دم ' + Math.round(hp) + ')';
    try { b.pathfinder.setGoal(null); } catch (_) { /* تجاهل */ }
    let cx = 0, cy = 0, cz = 0;
    for (const t of mobs) { cx += t.e.position.x; cy += t.e.position.y; cz += t.e.position.z; }
    const center = new Vec3(cx / n, cy / n, cz / n);
    if (openDirs(b).length === 0) {
      if (!c.escaping) {
        c.escaping = true;
        escapeTrap(c, center).finally(() => { c.escaping = false; });
      }
      return;
    }
    ensureDodge(c);
    runAway(c, center);
    return;
  }

  c.fighting = true;
  if (c.mode !== 'fighting') { c.mode = 'fighting'; c.task = 'قتال ضد ' + n + ' هدف'; clearControls(b); }
  if (!c.swordEquipped) { c.swordEquipped = true; try { b.armorManager.equipAll(); } catch (_) { /* تجاهل */ } }
  if (!c.swordBusy && Date.now() - (c.lastSwordCheck || 0) > 1500) {
    c.lastSwordCheck = Date.now();
    c.swordBusy = true;
    equipBestSword(c).catch(() => { /* تجاهل */ }).finally(() => { c.swordBusy = false; });
  }

  // اختيار الهدف: اللي في مدى الضرب، والأضعف دماً أولاً، وإلا الأقرب
  const inReach = mobs.filter((t) => t.d <= 3.3);
  if (!inReach.length) {
    try { b.pathfinder.setGoal(new goals.GoalFollow(mobs[0].e, 2), true); } catch (_) { /* تجاهل */ }
    return;
  }
  const t = inReach.reduce((best, cur) => {
    const hb = best.e.health ?? 20, hc = cur.e.health ?? 20;
    if (hc !== hb) return hc < hb ? cur : best;
    return cur.d < best.d ? cur : best;
  });

  try { b.pathfinder.setGoal(null); } catch (_) { /* تجاهل */ }
  try { await b.lookAt(t.e.position.offset(0, t.e.height ? t.e.height * 0.8 : 1, 0), true); } catch (_) { /* تجاهل */ }
  const now = Date.now();
  // المراوغة للخلف فقط ضد عدو واحد، مع أكثر من واحد ممكن يتحاصر
  const kite = c.settings.kiting && n === 1;
  if (kite && now < c.backUntil) {
    b.setControlState('back', true);
  } else {
    b.setControlState('back', false);
    if (now - c.lastHit >= 650) {
      try { b.attack(t.e); } catch (_) { /* تجاهل */ }
      c.lastHit = now;
      if (kite) c.backUntil = now + 380;
      if (c.settings.wtap !== false && !kite) {
        // W-tap: نوقف الحركة للأمام لحظة ونرجعها، وهذا يخلي الضربة الجاية أقوى
        try {
          b.setControlState('forward', false);
          setTimeout(() => { if (c.bot === b && c.fighting) b.setControlState('forward', true); }, 100);
        } catch (_) { /* تجاهل */ }
      }
    }
  }
}

// ---------------------------- الاحتماء بالبلوكات ----------------------------
async function emergency(c, threat) {
  const b = c.bot;
  c.lastEmergency = Date.now();
  c.shelter = { start: Date.now(), building: true };
  c.token++;
  c.mode = 'shelter'; c.task = 'طوارئ: الاحتماء';
  logC(c, 'err', 'الصحة منخفضة جداً (' + Math.round(b.health) + ')! الهرب والاحتماء ببلوكات');
  try { b.pathfinder.setGoal(null); } catch (_) { /* تجاهل */ }
  const t0 = Date.now();
  while (Date.now() - t0 < 1500 && c.bot === b && b.entity) {
    runAway(c, threat.position);
    await sleep(100);
  }
  clearControls(b);
  await buildShelter(c);
  if (c.shelter) c.shelter.building = false;
}

async function buildShelter(c) {
  const b = c.bot;
  if (!b || !b.entity) return;
  const place = async (ref, face) => {
    const it = pickBlockItem(b);
    if (!it) return false;
    try {
      if (!b.heldItem || b.heldItem.name !== it.name) await b.equip(it, 'hand');
      await b.placeBlock(ref, face);
    } catch (_) { /* تجاهل */ }
    await sleep(120);
    return true;
  };
  if (!pickBlockItem(b)) {
    logC(c, 'err', 'لا توجد بلوكات للاحتماء');
    c.shelter = null; c.mode = 'idle'; c.task = '';
    return;
  }
  const base = b.entity.position.floored();
  const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let lvl = 0; lvl < 2; lvl++) {
    for (const s of sides) {
      const pos = base.offset(s[0], lvl, s[1]);
      if (isSolid(b.blockAt(pos))) continue;
      const ref = b.blockAt(pos.offset(0, -1, 0));
      if (isSolid(ref)) await place(ref, new Vec3(0, 1, 0));
    }
  }
  const eastHead = b.blockAt(base.offset(1, 1, 0));
  if (isSolid(eastHead)) {
    await place(eastHead, new Vec3(0, 1, 0));
    const roofE = b.blockAt(base.offset(1, 2, 0));
    if (isSolid(roofE)) await place(roofE, new Vec3(-1, 0, 0));
  }
  logC(c, 'sys', 'تم إغلاق المكان، انتظار تعافي الصحة');
}

function shelterTick(c) {
  const b = c.bot;
  const s = c.shelter;
  if (!b || !s || s.building) return;
  const waited = Date.now() - s.start;
  const healed = b.health >= 18;
  if ((healed && waited > 5000) || waited > 120000) {
    c.shelter = null;
    c.mode = 'idle'; c.task = '';
    logC(c, 'sys', 'تعافى البوت، فتح الحماية');
    const base = b.entity.position.floored();
    const blk = b.blockAt(base.offset(0, 2, 0));
    (async () => {
      try {
        if (isSolid(blk)) await b.dig(blk);
        const side = b.blockAt(base.offset(1, 1, 0));
        if (isSolid(side)) await b.dig(side);
      } catch (_) { /* تجاهل */ }
    })();
  }
}

// ---------------------------- الهبوط الآمن MLG ----------------------------
function groundGap(b) {
  const p = b.entity.position;
  for (let i = 0; i <= 12; i++) {
    const bl = b.blockAt(p.offset(0, -i, 0));
    if (!bl) return null;
    if (bl.name === 'water') return -1;
    if (isSolid(bl) || bl.name === 'lava') return p.y - (bl.position.y + 1);
  }
  return null;
}

function mlgCheck(c) {
  const b = c.bot;
  if (!c.settings.mlg || c.mlgBusy || !b || !b.entity || b.entity.onGround) return;
  if (b.entity.velocity.y > -0.6) return;
  const bucket = b.inventory.items().find((i) => i.name === 'water_bucket');
  if (!bucket) return;
  const g = groundGap(b);
  if (g === null || g < 0) return;
  if (g <= 5.5) { c.mlgBusy = true; mlgDrop(c, bucket); }
}

async function mlgDrop(c, bucket) {
  const b = c.bot;
  try {
    await b.equip(bucket, 'hand');
    let placed = false;
    for (let t = 0; t < 40 && b.entity && !b.entity.onGround; t++) {
      b.look(b.entity.yaw, -Math.PI / 2, true);
      const g = groundGap(b);
      if (!placed && g !== null && g >= 0 && g <= 3.8) {
        b.activateItem();
        placed = true;
        logC(c, 'sys', 'MLG: تم وضع الماء تحت البوت');
      }
      if (b.entity.isInWater) break;
      await sleep(50);
    }
    if (placed) {
      await sleep(350);
      b.look(b.entity.yaw, -Math.PI / 2, true);
      await sleep(100);
      const empty = b.inventory.items().find((i) => i.name === 'bucket');
      if (empty) await b.equip(empty, 'hand');
      b.activateItem();
    }
  } catch (e) { logC(c, 'err', 'MLG: ' + e.message); } finally { c.mlgBusy = false; }
}

// ---------------------------- بناء الجسور ----------------------------
function holeAhead(c) {
  const b = c.bot;
  const d = snapDir(b);
  const feet = b.entity.position.floored();
  const a = b.blockAt(feet.offset(d.dx, -1, d.dz));
  const a2 = b.blockAt(feet.offset(d.dx, -2, d.dz));
  if (a && (a.name === 'lava')) return true;
  return !isSolid(a) && !isSolid(a2) && !!a;
}

async function bridgeTask(c, len, silent) {
  const b = c.bot;
  const my = silent ? c.token : startTask(c, 'bridge', 'بناء جسر');
  c.bridging = true;
  const d = snapDir(b);
  let placedAny = false;
  let solidRun = 0;
  try {
    for (let i = 0; i < len; i++) {
      if (c.token !== my || !b.entity) break;
      const feet = b.entity.position.floored();
      const body = b.blockAt(feet.offset(d.dx, 0, d.dz));
      if (isSolid(body)) { logC(c, 'sys', 'عائق أمام الجسر'); break; }
      const floorAhead = b.blockAt(feet.offset(d.dx, -1, d.dz));
      if (!isSolid(floorAhead)) {
        solidRun = 0;
        const ref = b.blockAt(feet.offset(0, -1, 0));
        if (!isSolid(ref)) break;
        const it = pickBlockItem(b);
        if (!it) { logC(c, 'err', 'لا توجد بلوكات لبناء الجسر'); break; }
        await b.equip(it, 'hand');
        b.setControlState('sneak', true);
        try { await b.placeBlock(ref, new Vec3(d.dx, 0, d.dz)); placedAny = true; } catch (e) { logC(c, 'err', 'تعذر وضع البلوك: ' + e.message); break; }
      } else {
        solidRun++;
        if (placedAny && solidRun >= 3) break;
      }
      b.setControlState('sneak', true);
      await walkStep(c, c.token, feet.x + d.dx + 0.5, feet.z + d.dz + 0.5);
    }
  } finally {
    try { b.setControlState('sneak', false); } catch (_) { /* تجاهل */ }
    c.bridging = false;
    if (!silent) endTask(c, my);
  }
  logC(c, 'sys', 'انتهى بناء الجسر');
}

// ---------------------------- الحقيبة ----------------------------
const JUNK = ['dirt', 'gravel', 'cobblestone', 'granite', 'diorite', 'andesite', 'netherrack', 'cobbled_deepslate', 'tuff', 'cobbled_deepslate', 'rotten_flesh', 'spider_eye', 'poisonous_potato'];
const KEEP = { cobblestone: 64, dirt: 64, cobbled_deepslate: 0 };
const DEPOSIT_AR = { 'حجر': 'stone', 'كوبل': 'cobblestone', 'تراب': 'dirt', 'رمل': 'sand', 'ماس': 'diamond', 'حديد': 'raw_iron' };

function isEssential(it) {
  const n = it.name;
  if (/_(pickaxe|sword|axe|shovel|hoe|helmet|chestplate|leggings|boots)$/.test(n)) return true;
  if (n === 'torch' || n === 'water_bucket' || n === 'shield' || n === 'bucket') return true;
  return false;
}

async function tossJunk(c) {
  const b = c.bot;
  let n = 0;
  const names = Array.from(new Set(JUNK));
  for (const name of names) {
    const items = b.inventory.items().filter((i) => i.name === name);
    if (!items.length) continue;
    const total = items.reduce((s, i) => s + i.count, 0);
    const keep = KEEP[name] || 0;
    const extra = total - keep;
    if (extra > 0) {
      try { await b.toss(items[0].type, null, extra); n += extra; } catch (_) { /* تجاهل */ }
      await sleep(150);
    }
  }
  return n;
}

// ---------------------------- الصناديق المسماة ----------------------------
function allChests(c) {
  const list = (c.chests || []).slice();
  if (c.chest && !list.some((h) => h.x === c.chest.x && h.y === c.chest.y && h.z === c.chest.z)) {
    list.push({ name: 'افتراضي', x: c.chest.x, y: c.chest.y, z: c.chest.z });
  }
  return list;
}

function nearestChest(c) {
  const list = allChests(c);
  if (!list.length || !c.bot || !c.bot.entity) return null;
  const here = c.bot.entity.position;
  list.sort((a, b) => new Vec3(a.x, a.y, a.z).distanceTo(here) - new Vec3(b.x, b.y, b.z).distanceTo(here));
  return list[0];
}

// يقرأ الاسم اللي على الصندوق في اللعبة (من الأنفل) من عنوان النافذة
function titleText(t) {
  try {
    if (typeof t === 'string' && t.trim().startsWith('{')) {
      const walk = (o) => (typeof o === 'string' ? o : (o && typeof o === 'object'
        ? (o.text || '') + (Array.isArray(o.extra) ? o.extra.map(walk).join('') : '') : ''));
      return walk(JSON.parse(t)).trim();
    }
  } catch (_) { /* تجاهل */ }
  return String(t || '').trim();
}

async function chestDump(c, my, opts = {}) {
  const b = c.bot;
  const tgt = nearestChest(c);
  if (!tgt) return false;
  const pos = new Vec3(tgt.x, tgt.y, tgt.z);
  const ok = await goTo(c, my, new goals.GoalNear(pos.x, pos.y, pos.z, 2), 30000);
  if (!ok) { logC(c, 'err', 'تعذر الوصول إلى الصندوق'); return false; }
  const blk = b.blockAt(pos);
  if (!blk || !/chest|barrel/.test(blk.name)) { logC(c, 'err', 'لا يوجد صندوق في الموقع المحدد'); return false; }
  let moved = 0;
  try {
    const ch = await b.openContainer(blk);
    for (const it of b.inventory.items()) {
      if (isEssential(it)) continue;
      if (c.settings.eatKeep !== false && b.registry.foodsByName && b.registry.foodsByName[it.name]) continue;
      let cnt = it.count;
      const forced = (c.settings.depositList || []).indexOf(it.name) !== -1;
      if (!opts.all && !forced && KEEP[it.name]) cnt = Math.max(0, it.count - KEEP[it.name]);
      if (cnt <= 0) continue;
      try { await ch.deposit(it.type, null, cnt); moved += cnt; } catch (_) { break; }
    }
    ch.close();
  } catch (e) { logC(c, 'err', 'تعذر فتح الصندوق: ' + e.message); return false; }
  logC(c, 'sys', 'تم إيداع ' + moved + ' عنصر في الصندوق');
  return true;
}

// بعد التعدين: يفرّغ كل المواد (حتى الحجر والتراب) في أقرب صندوق ويرجع لمكانه
async function depositAfterMining(c, my) {
  const b = c.bot;
  if (!b || !b.entity) return false;
  if (!allChests(c).length) { logC(c, 'err', 'ما فيه صندوق محفوظ لتفريغ المواد بعد التعدين'); return false; }
  const home = b.entity.position.clone();
  const ok = await chestDump(c, my, { all: true });
  if (ok && c.token === my) {
    await goTo(c, my, new goals.GoalNear(home.x, home.y, home.z, 2), 20000);
  }
  return ok;
}

async function manageInventory(c, my, force) {
  const b = c.bot;
  if (!b || !b.inventory) return;
  const free = b.inventory.emptySlotCount();
  if (!force && free > 3) return;
  c.lastSort = Date.now();
  const home = b.entity.position.clone();
  if (nearestChest(c)) {
    const ok = await chestDump(c, my);
    if (ok) {
      if (c.token === my && c.mode !== 'idle') {
        await goTo(c, my, new goals.GoalNear(home.x, home.y, home.z, 2), 20000);
      }
      return;
    }
  }
  const n = await tossJunk(c);
  if (n > 0) logC(c, 'sys', 'تم رمي ' + n + ' من العناصر الزائدة');
}

// ---------------------------- التعدين الآمن ----------------------------
function torchSpacing(b) {
  try { if (b.registry.isNewerOrEqualTo('1.18')) return 24; } catch (_) { /* تجاهل */ }
  return 12;
}

async function placeTorchAt(c, pos) {
  const b = c.bot;
  const t = b.inventory.items().find((i) => i.name === 'torch' || i.name === 'soul_torch');
  if (!t) return false;
  const ref = b.blockAt(pos.offset(0, -1, 0));
  const at = b.blockAt(pos);
  if (!isSolid(ref) || !at || at.name !== 'air') return false;
  try {
    await b.equip(t, 'hand');
    await b.placeBlock(ref, new Vec3(0, 1, 0));
    return true;
  } catch (_) { return false; }
}

async function mineNearbyOres(c, my) {
  const b = c.bot;
  for (let k = 0; k < 3; k++) {
    if (c.token !== my) return;
    const ore = b.findBlock({
      matching: (bl) => !!bl && (/_ore$/.test(bl.name) || bl.name === 'ancient_debris'),
      maxDistance: 4
    });
    if (!ore || lavaNear(b, ore.position)) return;
    await goTo(c, my, new goals.GoalNear(ore.position.x, ore.position.y, ore.position.z, 2), 8000);
    const okDig = await digIfSolid(c, my, ore.position);
    if (!okDig) return;
    logC(c, 'sys', 'تم تعدين: ' + ore.name);
    await sleep(300);
  }
}

async function stripMine(c, targetY, len) {
  const b = c.bot;
  const my = startTask(c, 'mining', 'تعدين Y=' + targetY);
  const d = snapDir(b);
  const spacing = torchSpacing(b);
  let sinceTorch = 0;
  let dug = 0;
  let reason = 'انتهى النفق';
  try {
    const p0 = b.entity.position.floored();
    if (Math.abs(p0.y - targetY) > 1) {
      logC(c, 'sys', 'النزول إلى الطبقة Y=' + targetY);
      const ok = await goTo(c, my, new goals.GoalBlock(p0.x + d.dx * 2, targetY, p0.z + d.dz * 2), 180000);
      if (!ok) { reason = 'تعذر الوصول إلى الطبقة المطلوبة'; return; }
    }
    logC(c, 'sys', 'بدء حفر النفق (' + len + ' بلوك)');
    for (let i = 0; i < len; i++) {
      if (!(await calm(c, my))) {
        reason = c.token !== my ? 'أمر جديد أو حالة طوارئ أوقف التعدين' : 'انفصل البوت';
        break;
      }
      const cur = b.entity.position.floored();
      const next = cur.offset(d.dx, 0, d.dz);
      const nf = b.blockAt(next);
      if (nf && (nf.name === 'lava' || nf.name === 'water')) { reason = 'سائل أمام النفق، توقف للسلامة'; break; }
      if (!(await digIfSolid(c, my, next))) { reason = 'تعذر كسر البلوك (تأكد من وجود بيكاكس بمتانة كافية)'; break; }
      if (!(await digIfSolid(c, my, next.offset(0, 1, 0)))) { reason = 'تعذر كسر البلوك العلوي'; break; }
      dug += 2;
      const fl = b.blockAt(next.offset(0, -1, 0));
      if (fl && fl.name === 'lava') { reason = 'لافا تحت النفق، توقف للسلامة'; break; }
      if (!isSolid(fl)) {
        const ref = b.blockAt(cur.offset(0, -1, 0));
        const it = pickBlockItem(b);
        if (isSolid(ref) && it) {
          try { await b.equip(it, 'hand'); await b.placeBlock(ref, new Vec3(d.dx, 0, d.dz)); } catch (_) { /* تجاهل */ }
        } else { reason = 'فجوة أمام النفق ولا توجد بلوكات'; break; }
      }
      // مشي سريع بالمسار بدل الانتظار الثابت، والمشي اليدوي احتياط
      const arrived = await goTo(c, my, new goals.GoalBlock(next.x, next.y, next.z), 4000);
      if (!arrived && c.token === my) await walkStep(c, my, next.x + 0.5, next.z + 0.5);
      await mineNearbyOres(c, my);
      sinceTorch++;
      if (sinceTorch >= spacing) {
        if (await placeTorchAt(c, cur)) sinceTorch = 0;
        else sinceTorch = spacing - 3;
      }
      if (i % 8 === 7) {
        await manageInventory(c, my, false);
        if (c.token === my) logC(c, 'sys', 'تقدّم النفق: ' + (i + 1) + ' / ' + len);
      }
    }
  } catch (e) {
    reason = 'خطأ أثناء التعدين: ' + e.message;
  } finally {
    logC(c, c.token === my ? 'sys' : 'err', 'توقف التعدين: ' + reason + ' (حُفر ' + dug + ' بلوك)');
    if (c.token === my && dug > 0 && c.settings.depositMine !== false) {
      await depositAfterMining(c, my).catch((e) => logC(c, 'err', 'فشل التفريغ: ' + e.message));
    }
    endTask(c, my);
  }
}

// ---------------------------- جمع الخشب ----------------------------
async function woodTask(c, count) {
  const b = c.bot;
  const my = startTask(c, 'wood', 'جمع خشب');
  const isLog = (bl) => !!bl && /_log$/.test(bl.name);
  let got = 0;
  try {
    if (b.collectBlock) {
      const spots = b.findBlocks({ matching: isLog, maxDistance: 48, count: count });
      if (!spots.length) { logC(c, 'err', 'لا توجد أشجار قريبة'); return; }
      for (const sp of spots) {
        if (!(await calm(c, my))) return;
        const bl = b.blockAt(sp);
        if (!isLog(bl)) continue;
        try { await b.collectBlock.collect(bl); got++; } catch (e) { logC(c, 'err', 'تعذر جمع الجذع: ' + e.message); }
        if (b.inventory.emptySlotCount() <= 2) await manageInventory(c, my, false);
      }
      logC(c, 'sys', 'انتهى جمع الخشب (' + got + ' جذع)');
      return;
    }
    for (let n = 0; n < count; n++) {
      if (!(await calm(c, my))) return;
      const lg = b.findBlock({ matching: isLog, maxDistance: 48 });
      if (!lg) { logC(c, 'err', 'لا توجد أشجار قريبة'); break; }
      await goTo(c, my, new goals.GoalNear(lg.position.x, lg.position.y, lg.position.z, 2), 20000);
      let pos = lg.position.clone();
      for (let k = 0; k < 8; k++) {
        const bl = b.blockAt(pos);
        if (!isLog(bl)) break;
        try { await b.dig(bl); got++; } catch (_) { break; }
        pos = pos.offset(0, 1, 0);
      }
      await sleep(500);
      await goTo(c, my, new goals.GoalNear(lg.position.x, lg.position.y, lg.position.z, 1), 4000);
      if (b.inventory.emptySlotCount() <= 2) await manageInventory(c, my, false);
    }
    logC(c, 'sys', 'انتهى جمع الخشب (' + got + ' قطعة)');
  } finally { endTask(c, my); }
}

// ---------------------------- الأوامر ----------------------------
const ALIASES = {
  'اتبعني': 'follow', 'توقف': 'stop', 'قف': 'stop', 'تعال': 'come', 'القي': 'drop',
  'ألقِ': 'drop', 'احداثيات': 'coords', 'احفر': 'dig', 'مساعدة': 'help',
  'عدن': 'mine', 'خشب': 'wood', 'جسر': 'bridge', 'رتب': 'sort',
  'كل': 'eat', 'حالة': 'status', 'حقيبة': 'inv', 'بيت': 'home', 'ارجع': 'return', 'مشرف': 'owner'
};

function ownerList(c) {
  const list = [];
  if (c.cfg.owner) list.push(c.cfg.owner);
  for (const n of (c.cfg.owners || [])) {
    if (n && list.every((x) => x.toLowerCase() !== n.toLowerCase())) list.push(n);
  }
  return list;
}

function isOwnerName(c, name) {
  const n = String(name || '').toLowerCase();
  return !!n && ownerList(c).some((x) => x.toLowerCase() === n);
}

function parseOwners(str) {
  return String(str || '').split(/[,،]/).map((x) => x.trim()).filter(Boolean).slice(0, 20);
}

function getOwnerEntity(c) {
  const b = c.bot;
  for (const name of ownerList(c)) {
    const key = Object.keys(b.players).find((n) => n.toLowerCase() === name.toLowerCase());
    const p = key ? b.players[key] : null;
    if (p && p.entity) return p.entity;
  }
  return null;
}

// قائمة المساعدة اللي تنرسل في الشات (كل سطر أقل من 250 حرف)
const HELP_LINES = [
  'أوامر البوت (اكتبها بالشات بعد !):',
  '!follow / !اتبعني: يتبعك | !come / !تعال: يجيك | !stop / !توقف: يوقف كل شي',
  '!mine ي طول: حفر نفق بمستوى Y | !xray خامة [رقم]: فحص خامات | !xray تعدين خامة [رقم]',
  '!wood [عدد]: يقطع أشجار | !bridge [طول]: يبني جسر | !dig: يحفر اللي قدامه',
  '!drop / !القي: يرمي الأغراض | !sort: يرتب الحقيبة | !armor: يلبس الدروع',
  '!coords / !احداثيات: مكاني | !eat / !كل: يأكل | !status / !حالة: الدم والجوع',
  '!inv / !حقيبة: محتويات الحقيبة | !home / !بيت: يحفظ البيت | !return / !ارجع: يرجع للبيت',
  '!chest [اسم]: يحفظ صندوق | !chest قائمة / حذف / اختر | !chest فلتر اضف/احذف',
  '!owner add/remove/list اسم: إدارة المشرفين | !help / !مساعدة: هذي القائمة'
];

async function runCmd(c, raw, args, src) {
  const name = ALIASES[raw] || raw;
  const b = c.bot;
  args = args || [];
  const say = (m) => {
    logC(c, 'sys', m);
    if (src === 'chat' && b) { try { b.chat(m); } catch (_) { /* تجاهل */ } }
  };
  if (!b || c.status !== 'connected' || !b.entity) { logC(c, 'err', 'البوت غير متصل'); return; }
  if (c.mode === 'mining' && ['coords', 'help', 'armor', 'stop'].indexOf(name) === -1) logC(c, 'sys', 'الأمر "' + raw + '" سيوقف التعدين الحالي');
  try {
    switch (name) {
      case 'follow': {
        const e = getOwnerEntity(c);
        if (!e) { say('لا أستطيع رؤية المشرف'); return; }
        const my = startTask(c, 'follow', 'يتبع المشرف');
        b.pathfinder.setGoal(new goals.GoalFollow(e, 2), true);
        say('سأتبعك');
        void my;
        break;
      }
      case 'come': {
        const e = getOwnerEntity(c);
        if (!e) { say('لا أستطيع رؤية المشرف'); return; }
        startTask(c, 'come', 'يتجه للمشرف');
        const p = e.position;
        b.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 1), false);
        say('قادم إليك');
        break;
      }
      case 'stop': { stopAll(c); say('تم التوقف'); break; }
      case 'forward': {
        startTask(c, 'forward', 'تحرك للأمام');
        b.setControlState('forward', true);
        const tk = c.token;
        setTimeout(() => { if (c.token === tk && c.bot === b) { clearControls(b); c.mode = 'idle'; c.task = ''; } }, 1500);
        break;
      }
      case 'dig': {
        const blk = b.blockAtCursor(5);
        if (!blk || blk.name === 'air') { say('لا توجد كتلة أمامي لأحفرها'); return; }
        const my = startTask(c, 'digging', 'يحفر');
        say('أحفر: ' + blk.name);
        try { await digIfSolid(c, my, blk.position); } finally { endTask(c, my); }
        break;
      }
      case 'drop': {
        const items = b.inventory.items();
        if (!items.length) { say('الحقيبة فارغة'); return; }
        say('ألقي ' + items.length + ' صنف');
        for (const it of items) {
          if (c.bot !== b) return;
          try { await b.tossStack(it); } catch (_) { /* تجاهل */ }
          await sleep(200);
        }
        break;
      }
      case 'coords': {
        const p = b.entity.position;
        say('الإحداثيات: X=' + Math.floor(p.x) + ' Y=' + Math.floor(p.y) + ' Z=' + Math.floor(p.z));
        break;
      }
      case 'armor': { await b.armorManager.equipAll(); say('تم ارتداء أفضل درع متوفر'); break; }
      case 'mine': {
        const y = parseInt(args[0], 10);
        const len = Math.max(1, Math.min(200, parseInt(args[1], 10) || 40));
        const ty = isNaN(y) ? -58 : y;
        stripMine(c, ty, len).catch((e) => logC(c, 'err', 'فشل التعدين: ' + e.message));
        break;
      }
      case 'wood': { woodTask(c, Math.max(1, Math.min(64, parseInt(args[0], 10) || 8))).catch((e) => logC(c, 'err', 'فشل جمع الخشب: ' + e.message)); break; }
      case 'bridge': { bridgeTask(c, Math.max(1, Math.min(60, parseInt(args[0], 10) || 20)), false).catch((e) => logC(c, 'err', 'فشل الجسر: ' + e.message)); break; }
      case 'sort': {
        const my = c.token;
        await manageInventory(c, my, true);
        say('تم ترتيب الحقيبة');
        break;
      }
      case 'chest': {
        const sub = args[0] || '';
        if (sub === 'فلتر') {
          const act = args[1] || '';
          const list = c.settings.depositList || [];
          if (act === 'اضف' || act === 'احذف') {
            const raw = args.slice(2).join(' ').trim().toLowerCase().replace(/\s+/g, '_');
            const name = DEPOSIT_AR[raw] || raw;
            if (!name) { logC(c, 'err', 'الصيغة: !chest فلتر اضف stone'); break; }
            c.settings.depositList = act === 'اضف'
              ? Array.from(new Set(list.concat([name])))
              : list.filter((x) => x !== name);
            saveData();
            logC(c, 'sys', (act === 'اضف' ? 'أضفت ' : 'حذفت ') + name + ' من فلتر التفريغ');
            break;
          }
          logC(c, 'sys', 'فلتر التفريغ (يتفرّغ دايماً): ' + (list.length ? list.join(', ') : 'فاضي'));
          break;
        }
        if (sub === 'قائمة') {
          const L = allChests(c);
          logC(c, 'sys', L.length ? 'الصناديق: ' + L.map((h) => h.name + ' (' + h.x + ' ' + h.y + ' ' + h.z + ')').join(' | ') : 'ما فيه صناديق محفوظة');
          break;
        }
        if (sub === 'حذف') {
          const nm = args.slice(1).join(' ');
          c.chests = (c.chests || []).filter((h) => h.name !== nm);
          saveData();
          logC(c, 'sys', 'تم حذف الصندوق: ' + nm);
          break;
        }
        if (sub === 'اختر') {
          const nm = args.slice(1).join(' ');
          const h = allChests(c).find((x) => x.name === nm);
          if (!h) { logC(c, 'err', 'ما فيه صندوق بهذا الاسم'); break; }
          c.chest = { x: h.x, y: h.y, z: h.z };
          saveData();
          logC(c, 'sys', 'الصندوق الافتراضي الآن: ' + nm);
          break;
        }
        const ch = b.findBlock({ matching: (bl) => !!bl && /(^|_)chest$|barrel/.test(bl.name), maxDistance: 8 });
        if (!ch) { logC(c, 'err', 'لا يوجد صندوق قريب (8 بلوك)'); break; }
        const pos = { x: ch.position.x, y: ch.position.y, z: ch.position.z };
        // نقرأ الاسم اللي على الصندوق في اللعبة إذا سميته بالأنفل
        let ingame = '';
        try {
          const w = await b.openContainer(ch);
          ingame = titleText(w.title);
          w.close();
        } catch (_) { /* تجاهل */ }
        if (/^(chest|large chest|barrel|صندوق|برميل|صندوق كبير)$/i.test(ingame)) ingame = '';
        const typed = args.join(' ').trim().replace(/\s+/g, ' ');
        if (typed) {
          const real = String(ingame || '').trim().replace(/\s+/g, ' ');
          if (!real) { logC(c, 'err', 'سمّي الصندوق بالأنفل باسم "' + typed + '" أول، وبعدين اكتب نفس الاسم بالأمر'); break; }
          if (real !== typed) { logC(c, 'err', 'الاسم اللي على الصندوق ("' + real + '") ما يطابق الأمر ("' + typed + '")'); break; }
        }
        const name = typed || ingame;
        if (!name) {
          c.chest = pos;
          saveData();
          logC(c, 'sys', 'تم تحديد الصندوق الافتراضي: ' + pos.x + ' ' + pos.y + ' ' + pos.z);
          break;
        }
        c.chests = (c.chests || []).filter((h) => h.name !== name);
        c.chests.push(Object.assign({ name: name }, pos));
        c.chest = pos;
        saveData();
        logC(c, 'sys', 'تم حفظ الصندوق باسم: ' + name + ' عند ' + pos.x + ' ' + pos.y + ' ' + pos.z);
        break;
      }
      case 'xray': {
        const mineMode = args[0] === 'تعدين' || args[0] === 'mine';
        const word = mineMode ? args[1] : args[0];
        const rr = Math.max(4, Math.min(32, parseInt(mineMode ? args[2] : args[1], 10) || 16));
        const re = oreRegex(word || '');
        if (!re) { logC(c, 'sys', 'الصيغة: !xray الماس [نصف_القطر] أو !xray تعدين الماس [نصف_القطر]'); return; }
        const found = await queueScan(() => findOres(c, re, rr));
        if (!found.length) { logC(c, 'sys', 'ما لقيت ' + word + ' ضمن ' + rr + ' بلوك'); return; }
        const near = found[0];
        logC(c, 'sys', 'لقيت ' + found.length + ' من ' + word + ' — أقرب واحد X=' + near.x + ' Y=' + near.y + ' Z=' + near.z);
        if (!mineMode) break;
        const my = startTask(c, 'xray', 'تعدين ' + word);
        try {
          let done = 0;
          const list = found.slice(0, 16);
          for (const p of list) {
            if (c.token !== my || !c.bot) break;
            const bl = b.blockAt(p);
            if (!bl || !re.test(bl.name)) continue;
            if (!canMine(b, bl.name)) { logC(c, 'sys', 'ما عندي بيكاكس يكفي لـ ' + bl.name + '، توقفت'); break; }
            const ok = await goTo(c, my, new goals.GoalNear(p.x, p.y, p.z, 2), 15000);
            if (!ok || c.token !== my) continue;
            if (await digIfSolid(c, my, p)) done++;
          }
          if (c.token === my) logC(c, 'sys', 'خلصت التعدين: ' + done + ' من ' + list.length);
          if (c.token === my && done > 0 && c.settings.depositMine !== false) {
            await depositAfterMining(c, my).catch((e) => logC(c, 'err', 'فشل التفريغ: ' + e.message));
          }
        } finally {
          endTask(c, my);
        }
        break;
      }
      case 'help': {
        for (const l of HELP_LINES) {
          if (c.bot !== b) break;
          say(l);
          await sleep(1200);
        }
        break;
      }
      case 'eat': {
        const food = b.inventory.items().find((i) => b.registry.foodsByName && b.registry.foodsByName[i.name]);
        if (!food) { say('ما عندي أكل'); break; }
        try { await b.equip(food, 'hand'); await b.consume(); say('أكلت 🍗'); }
        catch (e) { say('ما قدرت آكل: ' + e.message); }
        break;
      }
      case 'status': {
        const t = c.task ? ' - ' + c.task : '';
        say('❤️ ' + Math.round(b.health) + '/20 🍗 ' + Math.round(b.food) + '/20 | ' + c.mode + t);
        break;
      }
      case 'inv': {
        const map = {};
        for (const i of b.inventory.items()) map[i.name] = (map[i.name] || 0) + i.count;
        const list = Object.entries(map).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([n, k]) => n + ' ×' + k);
        say(list.length ? 'الحقيبة: ' + list.join(' | ') : 'الحقيبة فاضية');
        break;
      }
      case 'home': {
        const p = b.entity.position;
        c.home = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
        saveData();
        say('حفظت البيت: ' + c.home.x + ' ' + c.home.y + ' ' + c.home.z);
        break;
      }
      case 'return': {
        if (!c.home) { say('ما حفظت بيت، اكتب !home أول'); break; }
        const my = startTask(c, 'return', 'رجوع للبيت');
        say('أرجع للبيت');
        try {
          const ok = await goTo(c, my, new goals.GoalNear(c.home.x, c.home.y, c.home.z, 2), 90000);
          if (ok) say('وصلت البيت');
        } finally {
          endTask(c, my);
        }
        break;
      }
      case 'owner': {
        const sub = (args[0] || '').toLowerCase();
        const who = args.slice(1).join(' ').trim();
        if (sub === 'add' || sub === 'اضف') {
          if (!who) { say('الصيغة: !owner add اسم'); break; }
          if (!isOwnerName(c, who)) c.cfg.owners = (c.cfg.owners || []).concat([who]);
          saveData();
          say('أضفت المشرف: ' + who);
          break;
        }
        if (sub === 'remove' || sub === 'احذف') {
          if (!who) { say('الصيغة: !owner remove اسم'); break; }
          if (c.cfg.owner && who.toLowerCase() === c.cfg.owner.toLowerCase()) { say('ما أقدر أحذف المشرف الأساسي من الشات'); break; }
          c.cfg.owners = (c.cfg.owners || []).filter((x) => x.toLowerCase() !== who.toLowerCase());
          saveData();
          say('حذفت المشرف: ' + who);
          break;
        }
        say('المشرفين: ' + ownerList(c).join(', '));
        break;
      }
      default:
        logC(c, 'err', 'أمر غير معروف: ' + raw);
    }
  } catch (e) { logC(c, 'err', 'فشل تنفيذ الأمر ' + name + ': ' + e.message); }
}

// ---------------------------- التحكم اليدوي (جويستيك) ----------------------------
const CTL_DIRS = ['forward', 'back', 'left', 'right', 'jump'];

function ctlInput(c, dir, on) {
  const b = c.bot;
  if (!b || c.status !== 'connected' || CTL_DIRS.indexOf(dir) === -1) return;
  if (on) {
    if (c.mode !== 'manual') { stopAll(c); c.mode = 'manual'; c.task = 'تحكم يدوي'; }
    c.manualUntil = Date.now() + 1200;
    c.ctlActive[dir] = true;
    b.setControlState(dir, true);
    if (dir === 'forward') b.setControlState('sprint', true);
    clearTimeout(c.ctlTimers[dir]);
    c.ctlTimers[dir] = setTimeout(() => releaseCtl(c, dir), 900);
  } else {
    releaseCtl(c, dir);
  }
}

function releaseCtl(c, dir) {
  const b = c.bot;
  clearTimeout(c.ctlTimers[dir]);
  c.ctlActive[dir] = false;
  if (b) {
    try { b.setControlState(dir, false); if (dir === 'forward') b.setControlState('sprint', false); } catch (_) { /* تجاهل */ }
  }
  const any = CTL_DIRS.some((k) => c.ctlActive[k]);
  if (!any && c.mode === 'manual') { c.mode = 'idle'; c.task = ''; }
}

function manualBridgeCheck(c) {
  const b = c.bot;
  if (!b || !b.entity || c.mode !== 'manual' || !c.ctlActive.forward || c.bridging || !c.settings.autoBridge) return;
  if (holeAhead(c) && pickBlockItem(b)) {
    logC(c, 'sys', 'فجوة/لافا أمام البوت: بناء جسر تلقائي');
    CTL_DIRS.forEach((k) => releaseCtl(c, k));
    bridgeTask(c, 20, false);
  }
}

// ---------------------------- الرادار ----------------------------
function radarTick(c) {
  const b = c.bot;
  if (!c.settings.radar || !b || !b.entity) return;
  const me = b.entity.position;
  for (const n of Object.keys(b.players)) {
    const pl = b.players[n];
    if (!pl || !pl.entity || n === b.username) continue;
    if (isOwnerName(c, n)) continue;
    if (isFleetName(n)) continue;
    const d = pl.entity.position.distanceTo(me);
    if (d > RADAR_DIST) continue;
    const last = c.radarSeen[n] || 0;
    if (Date.now() - last < 60000) continue;
    c.radarSeen[n] = Date.now();
    const msg = '⚠️ انتبه، اللاعب ' + n + ' يقترب مني ويراقبني! (' + Math.round(d) + ' بلوك)';
    logC(c, 'alert', msg);
    io.emit('alert', { id: c.id, text: '[' + c.label + '] ' + msg });
    for (const o of ownerList(c)) { try { b.chat('/msg ' + o + ' ' + msg); } catch (_) { /* تجاهل */ } }
  }
}

// ---------------------------- الخريطة ثنائية الأبعاد ----------------------------
function baseColor(name) {
  if (name === 'water') return [58, 111, 216];
  if (name === 'lava') return [232, 96, 10];
  if (/grass|moss|fern/.test(name)) return [95, 168, 74];
  if (/leaves|azalea/.test(name)) return [47, 122, 58];
  if (/log|wood|stem/.test(name)) return [122, 90, 52];
  if (/planks|door|fence|slab|stair/.test(name)) return [176, 141, 87];
  if (/sand/.test(name)) return [220, 207, 143];
  if (/snow/.test(name)) return [242, 246, 250];
  if (/ice/.test(name)) return [165, 200, 240];
  if (/dirt|mud|podzol|farmland|path/.test(name)) return [138, 98, 64];
  if (/gravel/.test(name)) return [141, 138, 137];
  if (/ore|debris/.test(name)) return [214, 178, 90];
  if (/deepslate/.test(name)) return [70, 70, 78];
  if (/stone|cobble|andesite|diorite|granite|tuff|basalt|blackstone/.test(name)) return [125, 125, 125];
  if (/netherrack|nether_brick/.test(name)) return [122, 48, 48];
  if (/torch|lantern|glowstone/.test(name)) return [255, 210, 74];
  if (/bedrock/.test(name)) return [40, 40, 40];
  if (/chest|barrel|crafting|furnace/.test(name)) return [166, 110, 50];
  return [107, 114, 128];
}

function shade(col, f) {
  const cl = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  const h = (v) => ('0' + cl(v).toString(16)).slice(-2);
  return '#' + h(col[0]) + h(col[1]) + h(col[2]);
}

function buildMap(c, R) {
  const b = c.bot;
  const p = b.entity.position.floored();
  const pal = [];
  const idx = {};
  const cells = [];
  for (let dz = -R; dz <= R; dz++) {
    for (let dx = -R; dx <= R; dx++) {
      let color = '#0b0f13';
      for (let dy = 4; dy >= -14; dy--) {
        const bl = b.blockAt(new Vec3(p.x + dx, p.y + dy, p.z + dz));
        if (bl && bl.name !== 'air' && bl.name !== 'cave_air' && bl.name !== 'void_air') {
          const key = bl.name + '|' + dy;
          if (idx[key] === undefined) {
            idx[key] = pal.length;
            pal.push(shade(baseColor(bl.name), 1 + dy * 0.035));
          }
          color = idx[key];
          break;
        }
      }
      if (typeof color === 'string') {
        if (idx[color] === undefined) { idx[color] = pal.length; pal.push(color); }
        color = idx[color];
      }
      cells.push(color);
    }
  }
  return { r: R, cells: cells, pal: pal, cx: p.x, cy: p.y, cz: p.z };
}

function getMap(c, R) {
  const now = Date.now();
  if (c.mapCache && now - c.mapCache.t < 1800 && c.mapCache.r === R) return null;
  const data = buildMap(c, R);
  c.mapCache = { t: now, r: R };
  return data;
}

function entitiesRel(b) {
  const me = b.entity.position;
  const out = [];
  for (const id of Object.keys(b.entities)) {
    const e = b.entities[id];
    if (!e || e === b.entity || !e.position) continue;
    const dx = e.position.x - me.x;
    const dz = e.position.z - me.z;
    if (Math.abs(dx) > 40 || Math.abs(dz) > 40) continue;
    let t = 'm';
    if (e.type === 'player') t = 'p';
    else if (e.type === 'hostile' || (e.type === 'mob' && /hostile/i.test(e.kind || ''))) t = 'h';
    else if (e.type === 'object' || e.name === 'item') t = 'i';
    out.push({ x: r1(dx), z: r1(dz), t: t, n: e.username || e.name || '' });
    if (out.length > 80) break;
  }
  return out;
}

// ---------------------------- ملخصات وإرسال الحالة ----------------------------
function summary(c) {
  const s = {
    id: c.id, label: c.label, status: c.status, mode: c.mode, task: c.task,
    attempts: c.attempts, cfg: c.cfg, settings: c.settings, chest: c.chest, chests: c.chests || []
  };
  const b = c.bot;
  if (b && b.entity && c.status === 'connected') {
    try {
      const p = b.entity.position;
      s.health = b.health; s.food = b.food;
      s.pos = { x: r1(p.x), y: r1(p.y), z: r1(p.z) };
      s.dim = b.game ? b.game.dimension : '';
      s.players = Object.keys(b.players || {}).length;
    } catch (_) { /* تجاهل */ }
  }
  return s;
}

function detail(c, withMap) {
  const d = { id: c.id, sched: c.schedule };
  const b = c.bot;
  if (b && b.entity && c.status === 'connected') {
    try {
      d.inv = b.inventory.items().map((i) => ({ n: i.name, d: i.displayName, c: i.count }));
      d.held = b.heldItem ? b.heldItem.name : null;
      d.armor = [5, 6, 7, 8].map((s) => { const it = b.inventory.slots[s]; return it ? it.name : null; });
      d.free = b.inventory.emptySlotCount();
      d.yaw = b.entity.yaw;
      d.ents = entitiesRel(b);
      try {
        const blk = b.blockAt(b.entity.position);
        if (blk && blk.biome && blk.biome.name) d.biome = blk.biome.name;
      } catch (_) { /* تجاهل */ }
      const m = withMap === false ? null : getMap(c, 20);
      if (m) d.map = m;
    } catch (_) { /* تجاهل */ }
  }
  return d;
}

function recordPath(c) {
  const b = c.bot;
  if (!b || !b.entity) return;
  const p = b.entity.position;
  const now = Date.now();
  const last = c.path[c.path.length - 1];
  if (!last || now - last.t >= 2000) {
    c.path.push({ t: now, x: r1(p.x), y: r1(p.y), z: r1(p.z) });
    const cut = now - 3600000;
    while (c.path.length && c.path[0].t < cut) c.path.shift();
  }
}

function schedTick(c) {
  if (c.status !== 'connected' || !c.schedule.length) return;
  const now = Date.now();
  for (const s of c.schedule) {
    if (now >= s.next) {
      s.next = now + s.every * 60000;
      if (c.mode === 'idle') {
        logC(c, 'sys', 'تشغيل مجدول: ' + s.cmd + ' ' + (s.args || []).join(' '));
        runCmd(c, s.cmd, s.args || [], 'web');
      } else {
        logC(c, 'sys', 'تم تأجيل المهمة المجدولة لأن البوت مشغول');
      }
    }
  }
}

// ---------------------------- حلقات التشغيل ----------------------------
setInterval(() => {
  for (const c of fleet.values()) {
    if (c.status !== 'connected' || !c.bot) continue;
    combatTick(c).catch(() => { /* تجاهل */ });
    manualBridgeCheck(c);
  }
}, 250);

let slowCount = 0;
setInterval(() => {
  slowCount++;
  for (const c of fleet.values()) {
    if (c.status === 'connected' && c.bot && c.bot.entity) {
      try {
        recordPath(c);
        autoEat(c);
        radarTick(c);
        schedTick(c);
        if (c.settings.autoArmor && slowCount % 5 === 0 && !c.fighting) { try { c.bot.armorManager.equipAll(); } catch (_) { /* تجاهل */ } }
        const fl = c.settings.depositList || [];
        const forcedHas = fl.length > 0 && c.bot.inventory.items().some((i) => fl.indexOf(i.name) !== -1);
        if (c.settings.autoSort && c.mode === 'idle' && !c.fighting && Date.now() - c.lastSort > 30000
          && (c.bot.inventory.emptySlotCount() <= 2 || forcedHas)) {
          manageInventory(c, c.token, forcedHas).catch(() => { /* تجاهل */ });
        }
      } catch (_) { /* تجاهل */ }
    }
  }
  io.emit('fleet', Array.from(fleet.values()).map(summary));
  for (const s of io.sockets.sockets.values()) {
    const c = s._sel ? fleet.get(s._sel) : null;
    if (c) s.emit('detail', detail(c, slowCount % 3 === 0));
  }
}, 1000);

// ---------------------------- جدولة الاتصال والمسح ----------------------------
// قائمة انتظار للاتصال: البوتات تدخل واحد ورا الثاني بفاصل، فما تضغط السيرفر ولا المعالج
const startQueue = [];
let startBusy = false;
function queueStart(c) {
  if (!startQueue.includes(c)) startQueue.push(c);
  pumpStart();
}
function pumpStart() {
  if (startBusy || !startQueue.length) return;
  startBusy = true;
  const c = startQueue.shift();
  if (!c.manualStop && !c.bot) startBot(c);
  setTimeout(() => { startBusy = false; pumpStart(); }, 2500);
}

// قائمة انتظار للمسح (findBlocks ثقيل)، مسح واحد في كل مرة
let scanChain = Promise.resolve();
function queueScan(fn) {
  const p = scanChain.then(() => sleep(120)).then(fn);
  scanChain = p.catch(() => {});
  return p;
}

// ---------------------------- X-Ray ----------------------------
const ORE_AR = {
  'الماس': 'diamond', 'ذهب': 'gold', 'حديد': 'iron', 'فحم': 'coal', 'نحاس': 'copper',
  'ريدستون': 'redstone', 'ليبس': 'lapis', 'قديم': 'ancient_debris'
};
function oreRegex(word) {
  const w = String(word || '').trim();
  const base = (ORE_AR[w] || w.toLowerCase()).replace(/[^a-z_]/g, '');
  if (!base) return null;
  return new RegExp('^(deepslate_)?' + base + '(_ore)?$');
}

// أقل أداة مطلوبة لكل خامة
const ORE_NEED = [
  [/diamond|gold|ancient_debris/, ['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']],
  [/iron|redstone|lapis|copper/, ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']]
];
function canMine(b, name) {
  const e = ORE_NEED.find((x) => x[0].test(name));
  if (!e) return true;
  return b.inventory.items().some((i) => e[1].indexOf(i.name) !== -1);
}

function findOres(c, re, radius) {
  const b = c.bot;
  const here = b.entity.position;
  return b.findBlocks({ matching: (bl) => !!bl && re.test(bl.name), maxDistance: radius, count: 150 })
    .sort((p, q) => p.distanceTo(here) - q.distanceTo(here));
}

// ---------------------------- قارئ NBT (لملفات Litematica) ----------------------------
function readNBT(buf) {
  let p = 0;
  const u8 = () => buf[p++];
  const i16 = () => { const v = buf.readInt16BE(p); p += 2; return v; };
  const u16 = () => { const v = buf.readUInt16BE(p); p += 2; return v; };
  const i32 = () => { const v = buf.readInt32BE(p); p += 4; return v; };
  const i64 = () => { const v = buf.readBigInt64BE(p); p += 8; return v; };
  const f32 = () => { const v = buf.readFloatBE(p); p += 4; return v; };
  const f64 = () => { const v = buf.readDoubleBE(p); p += 8; return v; };
  const str = () => { const n = u16(); const s = buf.toString('utf8', p, p + n); p += n; return s; };
  function payload(t) {
    switch (t) {
      case 1: return buf.readInt8(p++);
      case 2: return i16();
      case 3: return i32();
      case 4: return i64();
      case 5: return f32();
      case 6: return f64();
      case 7: { const n = i32(); const a = []; for (let k = 0; k < n; k++) a.push(buf.readInt8(p++)); return a; }
      case 8: return str();
      case 9: { const et = u8(); const n = i32(); const a = []; for (let k = 0; k < n; k++) a.push(payload(et)); return a; }
      case 10: {
        const o = {};
        for (;;) { const tt = u8(); if (tt === 0) break; const name = str(); o[name] = payload(tt); }
        return o;
      }
      case 11: { const n = i32(); const a = []; for (let k = 0; k < n; k++) a.push(i32()); return a; }
      case 12: { const n = i32(); const a = []; for (let k = 0; k < n; k++) a.push(i64()); return a; }
      default: throw new Error('نوع NBT غير معروف: ' + t);
    }
  }
  const rootType = u8();
  str();
  return payload(rootType);
}

// يحوّل ملف Litematica إلى قائمة بلوكات مرتبة من الأسفل للأعلى
function parseLitematic(gzBuf) {
  const raw = zlib.gunzipSync(gzBuf);
  const root = readNBT(raw);
  const regions = root.Regions || {};
  const names = Object.keys(regions);
  if (!names.length) throw new Error('الملف ما فيه مناطق بناء');

  const entries = [];
  for (const rn of names) {
    const R = regions[rn];
    const sx = Math.abs(R.Size.x), sy = Math.abs(R.Size.y), sz = Math.abs(R.Size.z);
    const gx = Math.sign(R.Size.x) || 1, gy = Math.sign(R.Size.y) || 1, gz = Math.sign(R.Size.z) || 1;
    const pal = R.BlockStatePalette || [];
    if (!pal.length) throw new Error('جدول البلوكات فاضي');
    const bits = Math.max(2, Math.ceil(Math.log2(Math.max(2, pal.length))));
    const perLong = Math.floor(64 / bits);
    const vol = sx * sy * sz;
    const longs = R.BlockStates;
    if (!longs) throw new Error('بيانات البلوكات ناقصة');
    // Litematica الحديثة تكتب القيم متلاصقة عبر الـ long (spanning)، والقديمة بحشو لكل long
    const spanning = longs.length === Math.ceil((vol * bits) / 64);
    const padded = longs.length === Math.ceil(vol / perLong);
    if (!spanning && !padded) throw new Error('بيانات البلوكات ناقصة أو صيغة غير مدعومة');
    const mask = (1n << BigInt(bits)) - 1n;
    const B = BigInt(bits);
    const bx = R.Position.x, by = R.Position.y, bz = R.Position.z;

    for (let y = 0; y < sy; y++) {
      for (let z = 0; z < sz; z++) {
        for (let x = 0; x < sx; x++) {
          const i = (y * sz + z) * sx + x;
          let raw;
          if (spanning) {
            const o = BigInt(i) * B;
            const li = Number(o >> 6n);
            const sh = o & 63n;
            let v = BigInt.asUintN(64, longs[li]) >> sh;
            if (sh + B > 64n) v |= BigInt.asUintN(64, longs[li + 1]) << (64n - sh);
            raw = v;
          } else {
            const li = Math.floor(i / perLong);
            raw = BigInt.asUintN(64, longs[li]) >> BigInt((i % perLong) * bits);
          }
          const idx = Number(raw & mask);
          if (idx >= pal.length) throw new Error('فهرس بلوك خارج الجدول، صيغة غير مدعومة');
          const name = String(pal[idx].Name).replace('minecraft:', '');
          if (name === 'air' || name === 'cave_air' || name === 'void_air') continue;
          entries.push({ x: bx + x * gx, y: by + y * gy, z: bz + z * gz, name: name, props: pal[idx].Properties || null });
        }
      }
    }
  }
  if (!entries.length) throw new Error('ما فيه بلوكات في الملف');

  let mx = Infinity, my = Infinity, mz = Infinity;
  for (const e of entries) { if (e.x < mx) mx = e.x; if (e.y < my) my = e.y; if (e.z < mz) mz = e.z; }
  for (const e of entries) { e.x -= mx; e.y -= my; e.z -= mz; }
  entries.sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
  return { name: names.join(', '), entries: entries };
}

// ---------------------------- الموارد والبناء ----------------------------
function inventoryCount(b, name) {
  return b.inventory.items().filter((i) => i.name === name).reduce((a, i) => a + i.count, 0);
}

function needFrom(entries, from) {
  const need = {};
  for (let i = from; i < entries.length; i++) need[entries[i].name] = (need[entries[i].name] || 0) + 1;
  return need;
}

function missingFrom(b, need) {
  const out = [];
  for (const n of Object.keys(need)) {
    const have = inventoryCount(b, n);
    if (have < need[n]) out.push({ name: n, missing: need[n] - have });
  }
  return out;
}

// ---------------------------- تدوير المخطط ----------------------------
// k خطوات 90° مع عقارب الساعة (من فوق): شرق ← جنوب ← غرب ← شمال
const ROT_NEXT = { north: 'east', east: 'south', south: 'west', west: 'north' };
const AXIS_SWAP = { x: 'z', z: 'x', y: 'y' };
function rotateEntries(entries, k) {
  k = ((k % 4) + 4) % 4;
  if (!k) return entries;
  const out = entries.map((e) => {
    let x = e.x, z = e.z;
    for (let i = 0; i < k; i++) { const nx = -z; z = x; x = nx; }
    let p = e.props;
    if (p) {
      p = Object.assign({}, p);
      for (let i = 0; i < k; i++) {
        if (p.facing && ROT_NEXT[p.facing]) p.facing = ROT_NEXT[p.facing];
        if (p.axis && AXIS_SWAP[p.axis]) p.axis = AXIS_SWAP[p.axis];
      }
    }
    return { x: x, y: e.y, z: z, name: e.name, props: p };
  });
  let mx = Infinity, mz = Infinity;
  for (const e of out) { if (e.x < mx) mx = e.x; if (e.z < mz) mz = e.z; }
  for (const e of out) { e.x -= mx; e.z -= mz; }
  out.sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
  return out;
}

function liteInfo(c) {
  const L = c.lite;
  if (!L) return { id: c.id, loaded: false };
  return {
    id: c.id, loaded: true, name: L.name, total: L.entries.length, cursor: L.cursor,
    done: L.done, skipped: L.skipped, wrong: L.wrong || 0, building: !!L.building, paused: !!L.paused,
    origin: L.origin, missing: L.missing || []
  };
}

function emitLite(c) { io.emit('lite', liteInfo(c)); }

const FACES = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];

async function placeAt(c, my, target, name) {
  const b = c.bot;
  const item = b.inventory.items().find((i) => i.name === name);
  if (!item) return false;
  let ref = null, face = null;
  for (const f of FACES) {
    const r = b.blockAt(target.offset(f[0], f[1], f[2]));
    if (r && isSolid(r)) { ref = r; face = new Vec3(-f[0], -f[1], -f[2]); break; }
  }
  if (!ref) return false;
  if (b.entity.position.distanceTo(target) > 4) {
    await goTo(c, my, new goals.GoalNear(target.x, target.y, target.z, 3), 15000);
    if (c.token !== my || !c.bot) return false;
  }
  try {
    await b.equip(item, 'hand');
    await b.placeBlock(ref, face);
    return true;
  } catch (e) {
    return false;
  }
}


// ---------------------------- اتجاه البلوكات (المرحلة الأولى) ----------------------------
// yaw فانيلا: الجنوب 0، الغرب π/2، الشمال π، الشرق -π/2
const FACING_YAW = { south: 0, west: Math.PI / 2, north: Math.PI, east: -Math.PI / 2 };
const AXIS_FACES = { x: [[1, 0, 0], [-1, 0, 0]], y: [[0, 1, 0], [0, -1, 0]], z: [[0, 0, 1], [0, 0, -1]] };

function blockProps(bl) {
  try {
    if (bl && typeof bl.getProperties === 'function') return bl.getProperties() || {};
  } catch (_) { /* تجاهل */ }
  return {};
}

// نتحقق بس من الخصائص اللي نقدر نتحكم فيها: الاتجاه والمحور
function propsMatch(bl, want) {
  if (!want) return true;
  const have = blockProps(bl);
  for (const k of ['facing', 'axis']) {
    if (want[k] !== undefined && have[k] !== undefined && String(have[k]) !== String(want[k])) return false;
  }
  return true;
}

async function gotoNear(c, my, target) {
  const b = c.bot;
  if (b.entity.position.distanceTo(target) > 4) {
    await goTo(c, my, new goals.GoalNear(target.x, target.y, target.z, 3), 15000);
  }
  return c.token === my && !!c.bot;
}

// يرجع: 'ok' | 'wrong' (انبنى بس الاتجاه مو مطابق) | 'fail'
async function placeOriented(c, my, target, e) {
  const b = c.bot;
  const item = b.inventory.items().find((i) => i.name === e.name);
  if (!item) return 'fail';
  const want = e.props || {};
  const hasFacing = want.facing !== undefined && FACING_YAW[want.facing] !== undefined;
  const axisFaces = want.axis !== undefined && AXIS_FACES[want.axis] ? AXIS_FACES[want.axis] : null;
  if (!(await gotoNear(c, my, target))) return 'fail';

  let triedOnce = false;
  for (let k = 0; k < 3; k++) {
    if (c.token !== my || !c.bot) return 'fail';
    const order = axisFaces ? axisFaces.concat(FACES) : FACES;
    let ref = null, face = null;
    for (const f of order) {
      const r = b.blockAt(target.offset(f[0], f[1], f[2]));
      if (r && isSolid(r)) { ref = r; face = new Vec3(-f[0], -f[1], -f[2]); break; }
    }
    if (!ref) return 'fail';
    try {
      await b.equip(item, 'hand');
      // المحاولة الأولى بالاتجاه المطلوب، والثانية بعكسه (بعض البلوكات تأخذ اتجاه المقابل)
      if (hasFacing) {
        const yaw = FACING_YAW[want.facing] + (k % 2 === 1 ? Math.PI : 0);
        await b.look(yaw, 0, true);
      }
      await b.placeBlock(ref, face, { forceLook: 'ignore' });
    } catch (err) {
      await sleep(200);
      continue;
    }
    await sleep(150);
    triedOnce = true;
    const got = b.blockAt(target);
    if (got && got.name === e.name) {
      if (propsMatch(got, want)) return 'ok';
      // اتجاه غلط: نكسره ونعيد بزاوية ثانية
      await digIfSolid(c, my, target);
      continue;
    }
  }
  if (triedOnce) {
    const got = b.blockAt(target);
    if (got && got.name === e.name) return 'wrong';
  }
  return 'fail';
}

async function liteBuild(c, my) {
  const L = c.lite;
  const E = L.view || E;
  const b = c.bot;
  L.building = true;
  L.paused = false;
  emitLite(c);
  let i = L.cursor || 0;
  try {
    for (; i < E.length; i++) {
      if (c.token !== my || !c.bot) break;
      const e = E[i];
      L.cursor = i;
      const target = new Vec3(L.origin.x + e.x, L.origin.y + e.y, L.origin.z + e.z);
      const cur = b.blockAt(target);
      if (cur && cur.name === e.name) {
        L.done++;
        if (!propsMatch(cur, e.props)) L.wrong = (L.wrong || 0) + 1;
        continue;
      }

      if (inventoryCount(b, e.name) < 1) {
        L.missing = missingFrom(b, needFrom(E, i));
        L.paused = true;
        const list = L.missing.map((m) => m.name + ' ×' + m.missing).join('، ');
        const msg = '⏸️ توقفت مؤقتاً. ينقصني: ' + (list || e.name) + ' — وفّرها وبكمل تلقائياً';
        logC(c, 'err', msg);
        try { b.chat(msg.slice(0, 250)); } catch (_) { /* تجاهل */ }
        emitLite(c);
        while (c.token === my && c.bot && inventoryCount(b, e.name) < 1) await sleep(2500);
        if (c.token !== my || !c.bot) break;
        L.paused = false;
        logC(c, 'sys', 'تم توفير الموارد، أكمل البناء');
      }

      if (cur && isSolid(cur)) { L.skipped++; continue; }
      const res = await placeOriented(c, my, target, e);
      if (res === 'ok') L.done++;
      else if (res === 'wrong') {
        L.done++; L.wrong = (L.wrong || 0) + 1;
        logC(c, 'err', 'اتجاه غير مطابق للمخطط: ' + e.name + ' عند ' + target.x + ' ' + target.y + ' ' + target.z);
      } else {
        L.skipped++;
        logC(c, 'err', 'فشل بناء ' + e.name + ' عند ' + target.x + ' ' + target.y + ' ' + target.z);
      }
      if (i % 10 === 0) emitLite(c);
    }
  } finally {
    L.building = false;
    L.paused = false;
    if (c.token === my && i >= E.length) {
      L.cursor = i;
      logC(c, 'sys', 'انتهى البناء: تم ' + L.done + ' بلوك، تم تخطي ' + L.skipped);
    }
    emitLite(c);
  }
}

// ---------------------------- Socket.io ----------------------------
function getBot(id) { return fleet.get(id) || null; }

io.on('connection', (socket) => {
  const first = fleet.values().next().value;
  socket._sel = first ? first.id : null;
  socket.emit('init', {
    fleet: Array.from(fleet.values()).map(summary),
    logs: first ? first.logs : [],
    sel: socket._sel
  });

  socket.on('select', (id) => {
    const c = getBot(id);
    if (!c) return;
    socket._sel = id;
    c.mapCache = null;
    socket.emit('logs', { id: id, logs: c.logs });
  });

  socket.on('addBot', (cfg) => {
    cfg = cfg || {};
    const c = createCtl({ label: String(cfg.label || '').slice(0, 24) || undefined });
    c.cfg.host = String(cfg.host || '').trim() || c.cfg.host;
    c.cfg.port = parseInt(cfg.port, 10) || 25565;
    c.cfg.username = /^\w{1,16}$/.test(String(cfg.username || '')) ? cfg.username : c.cfg.username;
    c.cfg.owner = String(cfg.owner || '').trim();
    c.cfg.version = String(cfg.version || '').trim();
    saveData();
    socket._sel = c.id;
    socket.emit('selected', c.id);
  });

  socket.on('updateBot', (d) => {
    const c = d && getBot(d.id);
    if (!c) return;
    const host = String(d.host || '').trim();
    const port = parseInt(d.port, 10);
    const username = String(d.username || '').trim();
    if (!host) { logC(c, 'err', 'يرجى إدخال عنوان السيرفر'); return; }
    if (!(port >= 1 && port <= 65535)) { logC(c, 'err', 'رقم المنفذ غير صحيح'); return; }
    if (!/^\w{1,16}$/.test(username)) { logC(c, 'err', 'اسم البوت يجب أن يكون إنجليزياً (حتى 16 حرفاً)'); return; }
    c.cfg = { host: host, port: port, username: username, version: String(d.version || '').trim(), owner: String(d.owner || '').trim(), owners: d.owners !== undefined ? parseOwners(d.owners) : (c.cfg.owners || []) };
    saveData();
    logC(c, 'sys', 'تم حفظ إعدادات الاتصال');
  });

  socket.on('removeBot', (id) => {
    const c = getBot(id);
    if (!c) return;
    stopBot(c);
    fleet.delete(id);
    saveData();
    const first = fleet.values().next().value;
    socket._sel = first ? first.id : null;
    socket.emit('selected', socket._sel);
  });

  socket.on('rename', (d) => {
    const c = d && getBot(d.id);
    if (!c) return;
    const l = String(d.label || '').trim().slice(0, 24);
    if (l) { c.label = l; saveData(); }
  });

  socket.on('connectBot', (id) => {
    const c = getBot(id);
    if (!c) return;
    c.attempts = 0;
    c.manualStop = false;
    logC(c, 'sys', 'في طابور الاتصال...');
    queueStart(c);
  });
  socket.on('disconnectBot', (id) => { const c = getBot(id); if (c) stopBot(c); });

  socket.on('cmd', (d) => {
    const c = d && getBot(d.id);
    if (!c || typeof d.name !== 'string') return;
    const args = Array.isArray(d.args) ? d.args.map((x) => String(x)).slice(0, 4) : [];
    runCmd(c, d.name, args, 'web');
  });

  socket.on('lite:upload', (d) => {
    const c = d && getBot(d.id);
    if (!c) return;
    if (c.lite && c.lite.building) { logC(c, 'err', 'أوقف البناء أولاً قبل تغيير المخطط'); return; }
    try {
      const buf = Buffer.from(String(d.data || ''), 'base64');
      if (buf.length > 12 * 1024 * 1024) throw new Error('الملف كبير (الحد 12 ميجا)');
      const P = parseLitematic(buf);
      c.lite = {
        name: String(d.name || 'مخطط').slice(0, 60), entries: P.entries, origin: null,
        cursor: 0, done: 0, skipped: 0, building: false, paused: false, missing: []
      };
      logC(c, 'sys', 'تم تحليل المخطط: ' + c.lite.name + ' (' + P.entries.length + ' بلوك)');
    } catch (e) {
      c.lite = null;
      logC(c, 'err', 'فشل تحليل الملف: ' + e.message);
    }
    emitLite(c);
  });

  socket.on('lite:check', (d) => {
    const c = d && getBot(d.id);
    if (!c) return;
    if (!c.lite) { logC(c, 'err', 'ارفع ملف المخطط أولاً'); return; }
    if (!c.bot || c.status !== 'connected') { logC(c, 'err', 'البوت غير متصل'); return; }
    const x = parseInt(d.x, 10), y = parseInt(d.y, 10), z = parseInt(d.z, 10);
    if ([x, y, z].some(isNaN)) { logC(c, 'err', 'أدخل إحداثيات البناء X Y Z'); return; }
    const L = c.lite;
    L.origin = { x: x, y: y, z: z };
    L.rot = parseInt(d.rot, 10) || 0;
    L.view = rotateEntries(L.entries, L.rot);
    const need = {};
    for (const e of L.view) {
      const cur = c.bot.blockAt(new Vec3(x + e.x, y + e.y, z + e.z));
      if (cur && cur.name === e.name) continue;
      need[e.name] = (need[e.name] || 0) + 1;
    }
    L.missing = missingFrom(c.bot, need);
    logC(c, 'sys', 'فحص الموارد: ' + (L.missing.length
      ? L.missing.map((m) => m.name + ' ×' + m.missing).join('، ')
      : 'كل المواد متوفرة'));
    emitLite(c);
  });

  socket.on('lite:build', (d) => {
    const c = d && getBot(d.id);
    if (!c) return;
    if (!c.lite) { logC(c, 'err', 'ارفع ملف المخطط أولاً'); return; }
    if (!c.bot || c.status !== 'connected') { logC(c, 'err', 'البوت غير متصل'); return; }
    const x = parseInt(d.x, 10), y = parseInt(d.y, 10), z = parseInt(d.z, 10);
    if ([x, y, z].some(isNaN)) { logC(c, 'err', 'أدخل إحداثيات البناء X Y Z'); return; }
    const L = c.lite;
    const newRot = parseInt(d.rot, 10) || 0;
    if (L.cursor >= L.entries.length || L.rot !== newRot) { L.cursor = 0; L.done = 0; L.skipped = 0; }
    L.rot = newRot;
    L.view = rotateEntries(L.entries, L.rot);
    L.origin = { x: x, y: y, z: z };
    const my = startTask(c, 'build', 'بناء ' + L.name);
    liteBuild(c, my)
      .catch((e) => logC(c, 'err', 'توقف البناء: ' + e.message))
      .finally(() => endTask(c, my));
  });

  socket.on('lite:stop', (d) => {
    const c = d && getBot(d.id);
    if (!c) return;
    stopAll(c);
    logC(c, 'sys', 'أوقفت البناء والمهام');
    emitLite(c);
  });

  socket.on('chat', (d) => {
    const c = d && getBot(d.id);
    if (!c) return;
    if (!c.bot || c.status !== 'connected') { logC(c, 'err', 'البوت غير متصل'); return; }
    const t = String(d.text || '').slice(0, 256);
    if (!t.trim()) return;
    try { c.bot.chat(t); logC(c, 'me', t); } catch (e) { logC(c, 'err', 'تعذر إرسال الرسالة: ' + e.message); }
  });

  socket.on('inv', async (d) => {
    const c = d && getBot(d.id);
    if (!c || !c.bot || c.status !== 'connected') return;
    const b = c.bot;
    try {
      const items = b.inventory.items().filter((i) => i.name === d.name);
      if (!items.length) return;
      if (d.action === 'toss') {
        const total = items.reduce((s, i) => s + i.count, 0);
        const cnt = d.all ? total : Math.min(total, Math.max(1, parseInt(d.count, 10) || 1));
        await b.toss(items[0].type, null, cnt);
        logC(c, 'sys', 'تم رمي ' + cnt + ' × ' + d.name);
      } else if (d.action === 'equip') {
        let dest = 'hand';
        if (/_helmet$/.test(d.name)) dest = 'head';
        else if (/_chestplate$/.test(d.name)) dest = 'torso';
        else if (/_leggings$/.test(d.name)) dest = 'legs';
        else if (/_boots$/.test(d.name)) dest = 'feet';
        else if (d.name === 'shield') dest = 'off-hand';
        await b.equip(items[0], dest);
        logC(c, 'sys', 'تم تجهيز: ' + d.name);
      }
    } catch (e) { logC(c, 'err', 'فشل العملية: ' + e.message); }
  });

  socket.on('ctl', (d) => {
    const c = d && getBot(d.id);
    if (c) ctlInput(c, String(d.dir), !!d.on);
  });

  socket.on('look', (d) => {
    const c = d && getBot(d.id);
    if (!c || !c.bot || !c.bot.entity || c.status !== 'connected') return;
    const b = c.bot;
    const step = 0.5;
    let yaw = b.entity.yaw;
    let pitch = b.entity.pitch;
    if (d.dir === 'left') yaw += step;
    else if (d.dir === 'right') yaw -= step;
    else if (d.dir === 'up') pitch = Math.min(1.5, pitch + 0.3);
    else if (d.dir === 'down') pitch = Math.max(-1.5, pitch - 0.3);
    b.look(yaw, pitch, true);
  });

  socket.on('setting', (d) => {
    const c = d && getBot(d.id);
    if (!c || typeof d.key !== 'string') return;
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, d.key)) return;
    c.settings[d.key] = !!d.value;
    if (d.key === 'autoReconnect' && !c.settings.autoReconnect && c.reconnectTimer) {
      clearTimeout(c.reconnectTimer);
      c.reconnectTimer = null;
      setStatus(c, 'disconnected');
    }
    saveData();
  });

  socket.on('snap', (id) => {
    const c = getBot(id);
    if (!c || !c.bot || !c.bot.entity || c.status !== 'connected') return;
    const b = c.bot;
    let front = '';
    try { const bl = b.blockAtCursor(6); if (bl) front = bl.name; } catch (_) { /* تجاهل */ }
    socket.emit('snap', {
      id: id, t: Date.now(), map: buildMap(c, 24), yaw: b.entity.yaw, pitch: b.entity.pitch,
      front: front, ents: entitiesRel(b), pos: summary(c).pos
    });
  });

  socket.on('viewer', (id) => {
    const c = getBot(id);
    if (!c) return;
    if (!viewerLib) { logC(c, 'err', 'الكاميرا الحية تحتاج تثبيت prismarine-viewer'); return; }
    if (!c.bot || c.status !== 'connected') { logC(c, 'err', 'البوت غير متصل'); return; }
    try {
      if (c.viewerBot !== c.bot) {
        c.viewerPort = viewerPortSeq++;
        viewerLib(c.bot, { port: c.viewerPort, firstPerson: true, viewDistance: 4 });
        c.viewerBot = c.bot;
        logC(c, 'sys', 'تم تشغيل الكاميرا الحية على المنفذ ' + c.viewerPort);
      }
      socket.emit('viewer', { id: id, port: c.viewerPort });
    } catch (e) { logC(c, 'err', 'تعذر تشغيل الكاميرا: ' + e.message); }
  });

  socket.on('getPath', (id) => {
    const c = getBot(id);
    if (!c) return;
    const pts = c.path;
    const step = Math.max(1, Math.ceil(pts.length / 600));
    const out = [];
    for (let i = 0; i < pts.length; i += step) out.push([pts[i].x, pts[i].z, pts[i].t]);
    if (pts.length) { const l = pts[pts.length - 1]; out.push([l.x, l.z, l.t]); }
    socket.emit('path', { id: id, pts: out });
  });

  socket.on('addSched', (d) => {
    const c = d && getBot(d.id);
    if (!c) return;
    const allowed = ['wood', 'mine', 'follow', 'sort', 'stop', 'bridge', 'armor'];
    if (allowed.indexOf(d.cmd) === -1) return;
    const every = Math.max(1, Math.min(1440, parseInt(d.every, 10) || 60));
    const args = Array.isArray(d.args) ? d.args.map((x) => String(x)).filter(Boolean).slice(0, 3) : [];
    c.schedule.push({ sid: 's' + Date.now(), cmd: d.cmd, args: args, every: every, next: Date.now() + every * 60000 });
    saveData();
  });

  socket.on('delSched', (d) => {
    const c = d && getBot(d.id);
    if (!c) return;
    c.schedule = c.schedule.filter((s) => s.sid !== d.sid);
    saveData();
  });
});

// ---------------------------- حماية وتشغيل ----------------------------
process.on('uncaughtException', (e) => { console.error('uncaughtException:', e && e.message ? e.message : e); });
process.on('unhandledRejection', (e) => { console.error('unhandledRejection:', e && e.message ? e.message : e); });
process.on('SIGINT', () => {
  for (const c of fleet.values()) { c.manualStop = true; discardBot(c); }
  process.exit(0);
});
server.on('error', (e) => { console.error('تعذر تشغيل السيرفر:', e.message); process.exit(1); });

loadData();
if (fleet.size === 0) {
  const c = createCtl({
    cfg: {
      host: process.env.MC_HOST || 'localhost',
      port: parseInt(process.env.MC_PORT || '25565', 10),
      username: process.env.MC_USER || 'MineBot',
      version: process.env.MC_VERSION || '',
      owner: process.env.MC_OWNER || ''
    }
  });
  if (process.env.MC_HOST) setTimeout(() => startBot(c), 500);
}

server.listen(WEB.port, WEB.host, () => {
  console.log('لوحة التحكم تعمل على: http://' + WEB.host + ':' + WEB.port);
});

/*HTML_START
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>أسطول بوتات ماين كرافت</title>
<style>
:root { --bg:#0f1419; --card:#1a212b; --card2:#222b38; --text:#e8edf2; --muted:#8a97a6; --ok:#3ecf6e; --bad:#ef5350; --warn:#f5a623; --accent:#4f9cff; --line:#2c3745; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font-family:system-ui,"Segoe UI",Tahoma,sans-serif; font-size:15px; }
header { display:flex; align-items:center; justify-content:space-between; padding:10px 14px; background:var(--card); border-bottom:1px solid var(--line); position:sticky; top:0; z-index:5; }
header h1 { margin:0; font-size:16px; }
main { padding:10px; max-width:980px; margin:0 auto; display:grid; gap:10px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:12px; }
.card h2 { margin:0 0 10px; font-size:14px; color:var(--muted); font-weight:600; }
.grid2 { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
.grid3 { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
.grid4 { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; }
label { display:block; font-size:12px; color:var(--muted); margin-bottom:3px; }
input[type=text], input[type=number], select { width:100%; padding:9px; border-radius:9px; border:1px solid var(--line); background:var(--card2); color:var(--text); font-size:14px; }
button { padding:10px 6px; border-radius:10px; background:var(--card2); color:var(--text); font-size:13px; cursor:pointer; border:1px solid var(--line); touch-action:manipulation; }
button:active { transform:scale(.97); }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
button.danger { background:rgba(239,83,80,.2); border-color:var(--bad); color:var(--bad); }
button.small { padding:5px 8px; font-size:12px; }
.badge { padding:3px 9px; border-radius:20px; font-size:11px; font-weight:bold; background:var(--card2); }
.badge.ok { background:rgba(62,207,110,.18); color:var(--ok); }
.badge.bad { background:rgba(239,83,80,.18); color:var(--bad); }
.badge.warn { background:rgba(245,166,35,.18); color:var(--warn); }
.cards { display:flex; gap:8px; overflow-x:auto; padding-bottom:4px; }
.bcard { flex:0 0 150px; background:var(--card2); border:2px solid var(--line); border-radius:12px; padding:8px; cursor:pointer; }
.bcard.sel { border-color:var(--accent); }
.bcard .top { display:flex; align-items:center; gap:8px; }
.bcard .nm { font-weight:bold; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bcard .sub { font-size:11px; color:var(--muted); margin-top:5px; min-height:15px; }
.addcard { flex:0 0 90px; display:flex; align-items:center; justify-content:center; font-size:26px; color:var(--muted); background:var(--card2); border:2px dashed var(--line); border-radius:12px; cursor:pointer; }
.mini { height:5px; background:#11161c; border-radius:4px; overflow:hidden; margin-top:4px; }
.mini i { display:block; height:100%; }
.mini.hp i { background:var(--bad); } .mini.fd i { background:var(--warn); }
.pix { image-rendering:pixelated; width:40px; height:40px; flex:0 0 40px; }
.pix.big { width:56px; height:56px; flex-basis:56px; }
.m-idle { animation:bob 2s ease-in-out infinite; }
.m-mining, .m-digging, .m-wood { animation:shake .35s linear infinite; }
.m-fighting { animation:jab .4s ease-in-out infinite; }
.m-retreat, .m-forward, .m-manual, .m-follow, .m-come, .m-bridge { animation:run .5s ease-in-out infinite; }
.m-shelter { animation:bob 3s ease-in-out infinite; filter:brightness(.8); }
.m-off { filter:grayscale(1) brightness(.6); }
@keyframes bob { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-3px)} }
@keyframes shake { 0%,100%{transform:rotate(-6deg)} 50%{transform:rotate(6deg)} }
@keyframes jab { 0%,100%{transform:translateX(0)} 50%{transform:translateX(-5px) scale(1.06)} }
@keyframes run { 0%,100%{transform:translateY(0) rotate(-4deg)} 50%{transform:translateY(-4px) rotate(4deg)} }
.stat { background:var(--card2); border-radius:10px; padding:8px; }
.stat .k { font-size:11px; color:var(--muted); }
.stat .v { font-size:14px; font-weight:bold; margin-top:2px; direction:ltr; text-align:right; }
.bar { height:7px; background:#11161c; border-radius:6px; overflow:hidden; margin-top:5px; }
.bar i { display:block; height:100%; width:0; transition:width .4s; }
.bar.hp i { background:var(--bad); } .bar.fd i { background:var(--warn); }
canvas.map { width:100%; max-width:420px; aspect-ratio:1/1; background:#0b0f13; border-radius:10px; image-rendering:pixelated; display:block; margin:0 auto; }
.toggles { display:flex; flex-wrap:wrap; gap:10px; margin-top:10px; }
.toggles label { display:flex; align-items:center; gap:5px; font-size:13px; color:var(--text); margin:0; }
#chat { height:220px; overflow-y:auto; background:#0b0f13; border-radius:10px; padding:8px; font-size:13px; line-height:1.7; }
#chat div { word-break:break-word; }
#chat .t { color:var(--muted); font-size:11px; margin-left:6px; }
#chat .sys { color:var(--accent); } #chat .err { color:var(--bad); } #chat .me { color:var(--ok); } #chat .alert { color:var(--warn); font-weight:bold; }
.row { display:flex; gap:8px; margin-top:8px; }
.row input { flex:1; }
.joy { display:grid; grid-template-columns:repeat(3,64px); grid-template-rows:repeat(3,56px); gap:6px; justify-content:center; margin:6px auto; }
.joy button { font-size:22px; padding:0; user-select:none; -webkit-user-select:none; }
.inv { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:6px; }
.item { background:var(--card2); border-radius:9px; padding:7px; font-size:12px; }
.item b { display:block; margin-bottom:5px; word-break:break-all; }
.item .acts { display:flex; gap:4px; flex-wrap:wrap; }
.hint { font-size:11px; color:var(--muted); margin-top:6px; }
.legend span { display:inline-block; margin-left:10px; font-size:11px; color:var(--muted); }
.snaps { display:flex; gap:6px; overflow-x:auto; margin-top:8px; }
.snaps canvas { width:120px; height:120px; border-radius:8px; flex:0 0 auto; }
#toast { position:fixed; top:56px; right:10px; left:10px; z-index:20; display:grid; gap:6px; pointer-events:none; }
#toast div { background:rgba(245,166,35,.96); color:#111; padding:10px 12px; border-radius:10px; font-weight:bold; font-size:13px; }
details summary { cursor:pointer; color:var(--muted); font-size:13px; margin-bottom:8px; }
.sch { display:flex; justify-content:space-between; align-items:center; background:var(--card2); border-radius:8px; padding:6px 8px; margin-top:6px; font-size:13px; }

.burger { position:fixed; top:12px; left:12px; z-index:90; width:42px; height:42px; border-radius:10px; border:1px solid var(--line); background:var(--card); color:var(--text); font-size:20px; cursor:pointer; }
.drawer { position:fixed; top:0; bottom:0; left:-270px; width:260px; background:var(--card); border-right:1px solid var(--line); padding:64px 14px 14px; z-index:100; transition:left .25s; overflow-y:auto; box-shadow:4px 0 18px rgba(0,0,0,.4); }
.drawer.open { left:0; }
.drawer h3 { font-size:13px; color:var(--muted); margin:14px 4px 6px; }
.drawer button { display:block; width:100%; text-align:right; margin-bottom:6px; padding:10px 12px; }
.drawer-ov { position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:95; display:none; }
.drawer-ov.show { display:block; }
.flash { outline:2px solid var(--accent); transition:outline-color 1.2s; }
</style>
</head>
<body>
<button class="burger" id="burger" aria-label="القائمة">☰</button>
<div class="drawer-ov" id="drawerOv"></div>
<nav class="drawer" id="drawer">
  <h3>الأسطول</h3>
  <button id="mnFleet">🚀 الأسطول والبوتات</button>
  <button id="mnPanel">⚙️ إعدادات البوت المختار</button>
  <h3>Litematica</h3>
  <button id="mnLite">🧱 ماتيكل: البناء والمعلومات</button>
  <button id="mnUpload">📤 رفع ملف ماتيكل</button>
  <button id="mnLiteCheck">🔎 فحص الموارد الناقصة</button>
  <h3>الأدوات</h3>
  <button id="mnXray">🔍 X-Ray (فحص الخامات)</button>
  <button id="mnXrayMine">⛏️ X-Ray وتعدين</button>
</nav>
<header>
  <h1>🤖 أسطول بوتات ماين كرافت</h1>
  <div><button class="small" id="btnMascot">🖼️ صورة الأيقونة</button><input type="file" id="fileMascot" accept="image/*" hidden></div>
</header>
<div id="toast"></div>
<main>
  <section class="card">
    <h2>🚀 الأسطول (التيم)</h2>
    <div class="cards" id="cards"></div>
  </section>

  <div id="panel" style="display:none;gap:10px;grid-template-columns:1fr">
  <section class="card">
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <img id="bigPix" class="pix big" alt="">
      <div style="flex:1;min-width:120px"><div id="selName" style="font-weight:bold;font-size:16px"></div><div id="selTask" class="hint"></div></div>
      <span id="selBadge" class="badge bad">مفصول</span>
    </div>
    <div class="grid4" style="margin-top:10px">
      <button class="primary" id="btnConnect">اتصال</button>
      <button class="danger" id="btnDisconnect">فصل</button>
      <button id="btnRename">✏️ الاسم</button>
      <button class="danger" id="btnRemove">🗑️ حذف</button>
    </div>
    <details style="margin-top:10px"><summary>⚙️ إعدادات الاتصال</summary>
      <div class="grid2">
        <div><label>عنوان السيرفر</label><input type="text" id="host" dir="ltr"></div>
        <div><label>المنفذ</label><input type="number" id="port" dir="ltr"></div>
        <div><label>اسم البوت (إنجليزي)</label><input type="text" id="username" dir="ltr"></div>
        <div><label>اسم المشرف (مهند)</label><input type="text" id="owner" dir="ltr"></div>
        <div><label>مشرفين إضافيين (افصل بفاصلة)</label><input type="text" id="owners" dir="ltr"></div>
        <div><label>إصدار اللعبة (اختياري)</label><input type="text" id="version" dir="ltr" placeholder="تلقائي"></div>
        <div style="display:flex;align-items:flex-end"><button class="primary" id="btnSave" style="width:100%">حفظ</button></div>
      </div>
    </details>
  </section>

  <section class="card">
    <h2>معلومات البوت</h2>
    <div class="grid2">
      <div class="stat"><div class="k">❤️ الصحة</div><div class="v" id="hp">-</div><div class="bar hp"><i id="hpBar"></i></div></div>
      <div class="stat"><div class="k">🍗 الجوع</div><div class="v" id="fd">-</div><div class="bar fd"><i id="fdBar"></i></div></div>
    </div>
    <div class="grid3" style="margin-top:8px">
      <div class="stat"><div class="k">X</div><div class="v" id="px">-</div></div>
      <div class="stat"><div class="k">Y</div><div class="v" id="py">-</div></div>
      <div class="stat"><div class="k">Z</div><div class="v" id="pz">-</div></div>
    </div>
    <div class="grid2" style="margin-top:8px">
      <div class="stat"><div class="k">📍 الموقع</div><div class="v" id="loc" style="direction:rtl">-</div></div>
      <div class="stat"><div class="k">🎒 الحقيبة</div><div class="v" id="free" style="direction:rtl">-</div></div>
    </div>
  </section>

  <section class="card">
    <h2>🗺️ الخريطة (منظر علوي 2D)</h2>
    <canvas class="map" id="map" width="410" height="410"></canvas>
    <div class="legend" style="text-align:center;margin-top:6px"><span>🔵 لاعب</span><span>🔴 وحش</span><span>🟢 حيوان</span><span>🟡 عنصر</span></div>
    <div class="grid3" style="margin-top:8px">
      <button id="btnSnap">📸 التقاط كاميرا البوت</button>
      <button id="btnPath">🛤️ مسار آخر ساعة</button>
      <button id="btnChest">📦 تحديد الصندوق</button>
      <button id="btnViewer" style="grid-column:1/-1">🎥 كاميرا حية 3D (عين البوت)</button>
    </div>
    <iframe id="viewerFrame" style="display:none;width:100%;height:320px;border:0;border-radius:10px;margin-top:8px;background:#000"></iframe>
    <div class="snaps" id="snaps"></div>
    <canvas class="map" id="pathCanvas" width="410" height="410" style="display:none;margin-top:8px"></canvas>
  </section>

  <section class="card">
    <h2>🎮 ذراع التحكم (اضغط باستمرار)</h2>
    <div class="joy">
      <button data-look="left">↺</button><button data-ctl="forward">⬆️</button><button data-look="right">↻</button>
      <button data-ctl="left">⬅️</button><button data-ctl="jump">⤴️</button><button data-ctl="right">➡️</button>
      <button data-look="up">🔼</button><button data-ctl="back">⬇️</button><button data-look="down">🔽</button>
    </div>
    <div class="hint" style="text-align:center">عند توجيه البوت نحو فجوة أو لافا يبني جسراً تلقائياً إن توفرت بلوكات</div>
  </section>

  <section class="card">
    <h2>⚡ أوامر ومهام</h2>
    <div class="grid3">
      <button data-cmd="follow">🚶 اتبع المشرف</button>
      <button data-cmd="come">📍 تعال إليّ</button>
      <button data-cmd="stop">✋ قف</button>
      <button data-cmd="forward">⬆️ للأمام</button>
      <button data-cmd="dig">⛏️ احفر</button>
      <button data-cmd="armor">🛡️ ارتدِ الدرع</button>
      <button data-cmd="drop">🗑️ ألقِ الكل</button>
      <button data-cmd="coords">🧭 الإحداثيات</button>
      <button data-cmd="sort">🧹 رتّب الحقيبة</button>
      <button data-cmd="eat">🍗 كل</button>
      <button data-cmd="status">❤️ الحالة</button>
      <button data-cmd="inv">🎒 الحقيبة</button>
      <button data-cmd="home">🏠 احفظ البيت</button>
      <button data-cmd="return">🔙 ارجع للبيت</button>
      <button data-cmd="help">❓ المساعدة</button>
    </div>
    <div class="grid3" style="margin-top:8px">
      <div><label>الطبقة Y</label><input type="number" id="mineY" value="-58"></div>
      <div><label>طول النفق</label><input type="number" id="mineLen" value="40"></div>
      <div style="display:flex;align-items:flex-end"><button class="primary" id="btnMine" style="width:100%">⛏️ تعدين آمن</button></div>
      <div><label>عدد جذوع الخشب</label><input type="number" id="woodN" value="8"></div>
      <div style="display:flex;align-items:flex-end"><button id="btnWood" style="width:100%">🪵 اجمع خشب</button></div>
      <div style="display:flex;align-items:flex-end"><button id="btnBridge" style="width:100%">🌉 ابنِ جسراً</button></div>
    </div>
    <div class="toggles">
      <label><input type="checkbox" data-set="autoReconnect"> إعادة اتصال</label>
      <label><input type="checkbox" data-set="autoDefense"> دفاع تلقائي</label>
      <label><input type="checkbox" data-set="kiting"> مراوغة</label>
      <label><input type="checkbox" data-set="creeper"> رادار الكريبر</label>
      <label><input type="checkbox" data-set="autoEat"> أكل تلقائي</label>
      <label><input type="checkbox" data-set="autoArmor"> درع ذكي</label>
      <label><input type="checkbox" data-set="mlg"> MLG ماء</label>
      <label><input type="checkbox" data-set="autoBridge"> جسر تلقائي</label>
      <label><input type="checkbox" data-set="radar"> رادار اللاعبين</label>
      <label><input type="checkbox" data-set="autoSort"> فرز الحقيبة</label>
    </div>
  </section>

  <section class="card">
    <h2>🎒 حقيبة البوت</h2>
    <div class="hint" id="armorLine"></div>
    <div class="inv" id="inv"></div>
  </section>

  <section class="card">
    <h2>⏰ التشغيل المجدول</h2>
    <div class="grid3">
      <div><label>المهمة</label><select id="schCmd"><option value="wood">جمع خشب</option><option value="mine">تعدين</option><option value="sort">ترتيب الحقيبة</option><option value="follow">اتبع المشرف</option><option value="armor">ارتداء الدرع</option><option value="stop">توقف</option></select></div>
      <div><label>كل (دقيقة)</label><input type="number" id="schEvery" value="120"></div>
      <div><label>وسائط (اختياري)</label><input type="text" id="schArgs" dir="ltr" placeholder="مثال: -58 40"></div>
    </div>
    <button class="primary" id="btnSched" style="width:100%;margin-top:8px">إضافة</button>
    <div id="schList"></div>
  </section>

  <section class="card">
    <h2>💬 الشات المباشر</h2>
    <div id="chat"></div>
    <div class="row">
      <input type="text" id="msg" placeholder="اكتب رسالة أو أمراً يبدأ بـ /">
      <button class="primary" id="btnSend">إرسال</button>
    </div>
  </section>
  </div>
  <section class="card" id="cardLite">
    <h2>🧱 Litematica والبناء</h2>
    <p class="hint">ارفع ملف المخطط (.litematic)، وحدد إحداثيات البناء، والبوت يبنيه طبقة طبقة. إذا نقصته مواد يوقف مؤقتاً ويطلبها في الشات.</p>
    <div class="grid3">
      <div><label>ملف المخطط</label><input type="file" id="liteFile" accept=".litematic,.nbt,.schematic"></div>
      <div><label>X</label><input type="number" id="liteX" value="0"></div>
      <div><label>Y</label><input type="number" id="liteY" value="64"></div>
      <div><label>Z</label><input type="number" id="liteZ" value="0"></div>
    </div>
    <div class="grid3" style="margin-top:8px">
      <div><label>اتجاه البيت</label><select id="liteRot"><option value="0">الأصلي (0°)</option><option value="1">تدوير 90° مع عقارب الساعة</option><option value="2">180°</option><option value="3">270° مع عقارب الساعة</option></select></div>
    </div>
    <div class="grid3" style="margin-top:8px">
      <button id="liteCheck">🔎 فحص الموارد الناقصة</button>
      <button class="primary" id="liteBuild">▶️ ابدأ البناء</button>
      <button class="danger" id="liteStop">⏹️ إيقاف</button>
    </div>
    <div id="liteStatus" class="hint" style="margin-top:8px">لم يُرفع ملف بعد</div>
    <div id="liteMissing" class="hint" style="margin-top:6px"></div>
    <h2 style="margin-top:18px">🔍 فحص الخامات (X-Ray)</h2>
    <p class="hint">يفحص المنطقة حول البوت ويعرض عدد الخامة وأقرب موقع. التعدين يحتاج بيكاكس مناسب.</p>
    <div class="grid3">
      <div><label>الخامة (مثل: الماس، ذهب، حديد)</label><input id="xrOre" placeholder="الماس"></div>
      <div><label>نصف القطر</label><input type="number" id="xrR" value="16"></div>
      <div style="display:flex;align-items:flex-end;gap:6px"><button id="xrScan" style="flex:1">🔍 فحص</button><button class="primary" id="xrMine" style="flex:1">⛏️ فحص وتعدين</button></div>
    </div>
  </section>
</main>

<script src="/socket.io/socket.io.js"></script>
<script>
var socket = io();
function $(id) { return document.getElementById(id); }
function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

var fleet = {};
var order = [];
var sel = null;
var detail = {};
var lastMap = null;
var STATUS = { connected:['متصل','ok'], disconnected:['مفصول','bad'], connecting:['جاري الاتصال','warn'], reconnecting:['إعادة اتصال','warn'] };
var MODES = { idle:'خامل', follow:'يتبع المشرف', come:'يتجه للمشرف', fighting:'يقاتل', retreat:'ينسحب', shelter:'محتمٍ ببلوكات', mining:'يعدّن', wood:'يجمع خشب', digging:'يحفر', bridge:'يبني جسراً', manual:'تحكم يدوي', forward:'للأمام' };
var DIMS = { 'minecraft:overworld':'العالم العادي', 'overworld':'العالم العادي', 'minecraft:the_nether':'النذر', 'the_nether':'النذر', 'minecraft:the_end':'الإند', 'the_end':'الإند' };

// ---------- أيقونة البيكسل ----------
var customImg = null;
var pixCache = {};
(function () {
  try {
    var s = localStorage.getItem('mascotImg');
    if (s) { var im = new Image(); im.onload = function () { customImg = im; pixCache = {}; renderAll(); }; im.src = s; }
  } catch (e) { }
})();

function drawStar(ctx) {
  var cx = 8, cy = 8.6, R = 8, r = 3.7, pts = [], i, x, y;
  for (i = 0; i < 10; i++) {
    var a = -Math.PI / 2 + i * Math.PI / 5;
    var rad = (i % 2 === 0) ? R : r;
    pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
  }
  function inside(px, py) {
    var c = false;
    for (var i2 = 0, j = pts.length - 1; i2 < pts.length; j = i2++) {
      var xi = pts[i2][0], yi = pts[i2][1], xj = pts[j][0], yj = pts[j][1];
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) c = !c;
    }
    return c;
  }
  var g = [];
  for (y = 0; y < 16; y++) { g[y] = []; for (x = 0; x < 16; x++) g[y][x] = inside(x + 0.5, y + 0.5); }
  for (y = 0; y < 16; y++) {
    for (x = 0; x < 16; x++) {
      if (!g[y][x]) continue;
      var edge = !(g[y - 1] && g[y - 1][x]) || !(g[y + 1] && g[y + 1][x]) || !g[y][x - 1] || !g[y][x + 1];
      ctx.fillStyle = edge ? '#c8604a' : (y > 9 ? '#f08c74' : '#f6a58f');
      ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.fillStyle = '#fff'; ctx.fillRect(5, 6, 2, 3); ctx.fillRect(9, 6, 2, 3);
  ctx.fillStyle = '#111'; ctx.fillRect(6, 7, 1, 1); ctx.fillRect(10, 7, 1, 1);
  ctx.fillStyle = '#7a2a1c'; ctx.fillRect(6, 10, 4, 1); ctx.fillRect(5, 9, 1, 1); ctx.fillRect(10, 9, 1, 1);
}

function drawProps(ctx, mode) {
  var p = function (c, x, y, w, h) { ctx.fillStyle = c; ctx.fillRect(x, y, w || 1, h || 1); };
  if (mode === 'mining' || mode === 'digging' || mode === 'wood') {
    p('#8b5a2b', 11, 12); p('#8b5a2b', 12, 11); p('#8b5a2b', 13, 10);
    p('#b8c2cc', 12, 8, 4, 1); p('#b8c2cc', 14, 9); p('#b8c2cc', 11, 9);
  } else if (mode === 'fighting' || mode === 'retreat') {
    p('#8b5a2b', 11, 14); p('#e8eef5', 12, 13); p('#e8eef5', 13, 12); p('#e8eef5', 14, 11); p('#e8eef5', 15, 10); p('#6b4a2a', 10, 13, 3, 1);
  } else if (mode === 'shelter') {
    p('#8a8a8a', 11, 11, 4, 4); p('#6a6a6a', 11, 11, 4, 1);
  } else if (mode === 'bridge') {
    p('#7d7d7d', 0, 14, 6, 2);
  }
}

function pixURL(mode, off) {
  var key = mode + (off ? '|off' : '') + (customImg ? '|c' : '');
  if (pixCache[key]) return pixCache[key];
  var cv = document.createElement('canvas');
  cv.width = 16; cv.height = 16;
  var ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  if (customImg) ctx.drawImage(customImg, 0, 0, 16, 16); else drawStar(ctx);
  if (!off) drawProps(ctx, mode);
  pixCache[key] = cv.toDataURL();
  return pixCache[key];
}

function setPix(img, f) {
  var off = f.status !== 'connected';
  img.src = pixURL(off ? 'idle' : f.mode, off);
  var base = img.className.replace(/\bm-\S+/g, '').trim();
  img.className = base + ' ' + (off ? 'm-off' : 'm-' + f.mode);
}

$('btnMascot').onclick = function () { $('fileMascot').click(); };
$('fileMascot').onchange = function () {
  var f = this.files && this.files[0];
  if (!f) return;
  var rd = new FileReader();
  rd.onload = function () {
    var im = new Image();
    im.onload = function () {
      var cv = document.createElement('canvas');
      cv.width = 32; cv.height = 32;
      var cx = cv.getContext('2d');
      cx.imageSmoothingEnabled = false;
      cx.drawImage(im, 0, 0, 32, 32);
      var url = cv.toDataURL();
      try { localStorage.setItem('mascotImg', url); } catch (e) { }
      var im2 = new Image();
      im2.onload = function () { customImg = im2; pixCache = {}; renderAll(); };
      im2.src = url;
    };
    im.src = rd.result;
  };
  rd.readAsDataURL(f);
};

// ---------- أدوات ----------
function toast(text) {
  var d = el('div', '', text);
  $('toast').appendChild(d);
  setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 7000);
}

function addLine(e) {
  var box = $('chat');
  var near = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  var div = el('div', e.type);
  var d = new Date(e.t);
  div.appendChild(el('span', 't', ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2)));
  div.appendChild(el('span', '', (e.type === 'me' ? 'أنت: ' : '') + e.text));
  box.appendChild(div);
  while (box.children.length > 250) box.removeChild(box.firstChild);
  if (near) box.scrollTop = box.scrollHeight;
}

function emit(name, extra) {
  var o = extra || {};
  o.id = sel;
  socket.emit(name, o);
}

// ---------- الأسطول ----------
function renderCards() {
  var box = $('cards');
  box.textContent = '';
  order.forEach(function (id) {
    var f = fleet[id];
    var c = el('div', 'bcard' + (id === sel ? ' sel' : ''));
    var top = el('div', 'top');
    var im = el('img', 'pix'); im.alt = '';
    setPix(im, f);
    var nm = el('div', 'nm', f.label);
    top.appendChild(im);
    top.appendChild(nm);
    c.appendChild(top);
    var st = STATUS[f.status] || STATUS.disconnected;
    var sub = el('div', 'sub', f.status === 'connected' ? (f.task || MODES[f.mode] || '') : st[0]);
    c.appendChild(sub);
    if (typeof f.health === 'number') {
      var h = el('div', 'mini hp'); var hi = el('i'); hi.style.width = Math.max(0, Math.min(100, f.health * 5)) + '%'; h.appendChild(hi); c.appendChild(h);
      var d2 = el('div', 'mini fd'); var di = el('i'); di.style.width = Math.max(0, Math.min(100, f.food * 5)) + '%'; d2.appendChild(di); c.appendChild(d2);
    }
    if (f.pos) c.appendChild(el('div', 'sub', f.pos.x + ' ' + f.pos.y + ' ' + f.pos.z));
    c.onclick = function () { selectBot(id); };
    box.appendChild(c);
  });
  var add = el('div', 'addcard', '+');
  add.onclick = function () {
    var label = prompt('اسم البوت الجديد:', 'Bot_' + (order.length + 1));
    if (label === null) return;
    var base = fleet[sel] ? fleet[sel].cfg : { host: 'localhost', port: 25565, owner: '', version: '' };
    socket.emit('addBot', { label: label, host: base.host, port: base.port, owner: base.owner, version: base.version, username: 'MineBot' + (order.length + 1) });
  };
  box.appendChild(add);
}

function fillForm(f) {
  $('host').value = f.cfg.host; $('port').value = f.cfg.port; $('username').value = f.cfg.username;
  $('owner').value = f.cfg.owner; $('version').value = f.cfg.version;
  $('owners').value = (f.cfg.owners || []).join(', ');
}

function selectBot(id) {
  if (!fleet[id]) return;
  sel = id;
  socket.emit('select', id);
  detail = {}; lastMap = null;
  $('chat').textContent = '';
  $('snaps').textContent = '';
  $('pathCanvas').style.display = 'none';
  fillForm(fleet[id]);
  renderAll();
}

function renderPanel() {
  var f = fleet[sel];
  $('panel').style.display = f ? 'grid' : 'none';
  if (!f) return;
  $('selName').textContent = f.label;
  $('selTask').textContent = f.status === 'connected' ? ((MODES[f.mode] || f.mode) + (f.task ? ' - ' + f.task : '')) : '';
  var st = STATUS[f.status] || STATUS.disconnected;
  var b = $('selBadge'); b.textContent = st[0]; b.className = 'badge ' + st[1];
  setPix($('bigPix'), f);
  if (typeof f.health === 'number') {
    $('hp').textContent = Math.round(f.health * 10) / 10 + ' / 20';
    $('hpBar').style.width = Math.max(0, Math.min(100, f.health * 5)) + '%';
    $('fd').textContent = f.food + ' / 20';
    $('fdBar').style.width = Math.max(0, Math.min(100, f.food * 5)) + '%';
  } else { $('hp').textContent = '-'; $('fd').textContent = '-'; $('hpBar').style.width = '0'; $('fdBar').style.width = '0'; }
  if (f.pos) {
    $('px').textContent = f.pos.x; $('py').textContent = f.pos.y; $('pz').textContent = f.pos.z;
    $('loc').textContent = (DIMS[f.dim] || f.dim || '') + (detail.biome ? ' - ' + detail.biome : '');
  } else { $('px').textContent = '-'; $('py').textContent = '-'; $('pz').textContent = '-'; $('loc').textContent = '-'; }
  $('free').textContent = detail.free !== undefined ? ('فارغ: ' + detail.free + ' خانة') : '-';
  var tg = document.querySelectorAll('input[data-set]');
  for (var i = 0; i < tg.length; i++) tg[i].checked = !!f.settings[tg[i].getAttribute('data-set')];
}

function renderAll() { renderCards(); renderPanel(); renderInv(); renderSched(); }

// ---------- الحقيبة ----------
var invSig = '';
function renderInv() {
  var inv = detail.inv || [];
  var sig = JSON.stringify(inv) + JSON.stringify(detail.armor || []);
  if (sig === invSig) return;
  invSig = sig;
  var names = ['خوذة', 'درع', 'بنطلون', 'حذاء'];
  var al = [];
  (detail.armor || []).forEach(function (a, i) { al.push(names[i] + ': ' + (a || 'لا يوجد')); });
  $('armorLine').textContent = al.join(' | ') + (detail.held ? ' | في اليد: ' + detail.held : '');
  var box = $('inv');
  box.textContent = '';
  var agg = {};
  inv.forEach(function (i) { if (!agg[i.n]) agg[i.n] = { n: i.n, d: i.d, c: 0 }; agg[i.n].c += i.c; });
  Object.keys(agg).forEach(function (k) {
    var it = agg[k];
    var d = el('div', 'item');
    d.appendChild(el('b', '', (it.d || it.n) + ' × ' + it.c));
    var a = el('div', 'acts');
    var b1 = el('button', 'small', 'ألقِ 1'); b1.onclick = function () { emit('inv', { action: 'toss', name: it.n, count: 1 }); };
    var b2 = el('button', 'small danger', 'ألقِ الكل'); b2.onclick = function () { emit('inv', { action: 'toss', name: it.n, all: true }); };
    var b3 = el('button', 'small', 'جهّز'); b3.onclick = function () { emit('inv', { action: 'equip', name: it.n }); };
    a.appendChild(b1); a.appendChild(b2); a.appendChild(b3);
    d.appendChild(a);
    box.appendChild(d);
  });
  if (!inv.length) box.appendChild(el('div', 'hint', 'الحقيبة فارغة أو البوت غير متصل'));
}

// ---------- الجدولة ----------
var schSig = '';
function renderSched() {
  var list = detail.sched || [];
  var sig = JSON.stringify(list);
  if (sig === schSig) return;
  schSig = sig;
  var box = $('schList');
  box.textContent = '';
  list.forEach(function (s) {
    var d = el('div', 'sch');
    d.appendChild(el('span', '', s.cmd + ' ' + (s.args || []).join(' ') + ' — كل ' + s.every + ' دقيقة'));
    var b = el('button', 'small danger', 'حذف');
    b.onclick = function () { emit('delSched', { sid: s.sid }); };
    d.appendChild(b);
    box.appendChild(d);
  });
}

// ---------- الخريطة ----------
function drawMap(cv, m, ents, yaw, cone) {
  var ctx = cv.getContext('2d');
  var n = m.r * 2 + 1;
  var s = cv.width / n;
  ctx.clearRect(0, 0, cv.width, cv.height);
  for (var i = 0; i < m.cells.length; i++) {
    ctx.fillStyle = m.pal[m.cells[i]];
    ctx.fillRect((i % n) * s, Math.floor(i / n) * s, s + 0.5, s + 0.5);
  }
  var cx = (m.r + 0.5) * s, cy = (m.r + 0.5) * s;
  if (cone) {
    var fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    var ang = Math.atan2(fz, fx);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, cv.width * 0.6, ang - 0.6, ang + 0.6);
    ctx.closePath(); ctx.fill();
  }
  var colors = { p: '#4f9cff', h: '#ff4040', m: '#3ecf6e', i: '#ffd24a' };
  (ents || []).forEach(function (e) {
    if (Math.abs(e.x) > m.r || Math.abs(e.z) > m.r) return;
    ctx.fillStyle = colors[e.t] || '#fff';
    var rr = e.t === 'i' ? s * 0.25 : s * 0.5;
    ctx.beginPath(); ctx.arc(cx + e.x * s, cy + e.z * s, Math.max(2, rr), 0, 6.3); ctx.fill();
    if (e.t === 'p') { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); }
  });
  var ang2 = Math.atan2(-Math.cos(yaw), -Math.sin(yaw));
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(ang2);
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(s * 1.4, 0); ctx.lineTo(-s * 0.9, s * 0.9); ctx.lineTo(-s * 0.9, -s * 0.9); ctx.closePath();
  ctx.fill(); ctx.stroke(); ctx.restore();
}

function renderMap() {
  var cv = $('map');
  if (detail.map) lastMap = detail.map;
  if (lastMap) drawMap(cv, lastMap, detail.ents, detail.yaw || 0, false);
}

function drawPath(pts) {
  var cv = $('pathCanvas');
  cv.style.display = 'block';
  var ctx = cv.getContext('2d');
  ctx.fillStyle = '#0b0f13'; ctx.fillRect(0, 0, cv.width, cv.height);
  if (pts.length < 2) { ctx.fillStyle = '#8a97a6'; ctx.font = '16px sans-serif'; ctx.fillText('لا توجد بيانات مسار كافية بعد', 80, 200); return; }
  var minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
  pts.forEach(function (p) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); minz = Math.min(minz, p[1]); maxz = Math.max(maxz, p[1]); });
  var span = Math.max(maxx - minx, maxz - minz, 10);
  var sc = (cv.width - 40) / span;
  var ox = 20 + ((span - (maxx - minx)) * sc) / 2, oz = 20 + ((span - (maxz - minz)) * sc) / 2;
  var X = function (x) { return ox + (x - minx) * sc; };
  var Z = function (z) { return oz + (z - minz) * sc; };
  var t0 = pts[0][2], t1 = pts[pts.length - 1][2];
  for (var i = 1; i < pts.length; i++) {
    var f = (pts[i][2] - t0) / Math.max(1, t1 - t0);
    ctx.strokeStyle = 'hsl(' + Math.round(200 - f * 160) + ',90%,60%)';
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(X(pts[i - 1][0]), Z(pts[i - 1][1])); ctx.lineTo(X(pts[i][0]), Z(pts[i][1])); ctx.stroke();
  }
  ctx.fillStyle = '#3ecf6e'; ctx.beginPath(); ctx.arc(X(pts[0][0]), Z(pts[0][1]), 6, 0, 6.3); ctx.fill();
  ctx.fillStyle = '#ef5350'; ctx.beginPath(); ctx.arc(X(pts[pts.length - 1][0]), Z(pts[pts.length - 1][1]), 6, 0, 6.3); ctx.fill();
  ctx.fillStyle = '#e8edf2'; ctx.font = '13px sans-serif';
  ctx.fillText('أخضر = البداية | أحمر = الآن', 14, 18);
}

// ---------- أحداث السوكت ----------
socket.on('init', function (d) {
  fleet = {}; order = [];
  d.fleet.forEach(function (f) { fleet[f.id] = f; order.push(f.id); });
  sel = d.sel;
  $('chat').textContent = '';
  (d.logs || []).forEach(addLine);
  if (sel && fleet[sel]) fillForm(fleet[sel]);
  renderAll();
});
socket.on('fleet', function (list) {
  var ids = list.map(function (f) { return f.id; });
  var changed = ids.join(',') !== order.join(',');
  fleet = {}; list.forEach(function (f) { fleet[f.id] = f; });
  order = ids;
  if (!sel || !fleet[sel]) { sel = order[0] || null; if (sel) { socket.emit('select', sel); fillForm(fleet[sel]); } }
  void changed;
  renderCards(); renderPanel();
});
socket.on('detail', function (d) {
  if (d.id !== sel) return;
  detail = d;
  renderMap(); renderInv(); renderSched();
  var f = fleet[sel];
  if (f) { $('free').textContent = d.free !== undefined ? ('فارغ: ' + d.free + ' خانة') : '-'; if (f.pos) $('loc').textContent = (DIMS[f.dim] || f.dim || '') + (d.biome ? ' - ' + d.biome : ''); }
});
socket.on('log', function (e) { if (e.id === sel) addLine(e); });
socket.on('logs', function (d) { if (d.id === sel) { $('chat').textContent = ''; d.logs.forEach(addLine); } });
socket.on('alert', function (a) { toast(a.text); });
socket.on('selected', function (id) { sel = id; if (id) socket.emit('select', id); });
socket.on('snap', function (s) {
  if (s.id !== sel) return;
  var cv = document.createElement('canvas');
  cv.width = 392; cv.height = 392;
  drawMap(cv, s.map, s.ents, s.yaw, true);
  var ctx = cv.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(0, 0, 392, 22);
  ctx.fillStyle = '#fff'; ctx.font = '13px sans-serif';
  var t = new Date(s.t);
  ctx.fillText(t.toLocaleTimeString() + ' | أمامه: ' + (s.front || 'لا شيء'), 8, 15);
  var box = $('snaps');
  box.insertBefore(cv, box.firstChild);
  while (box.children.length > 8) box.removeChild(box.lastChild);
  cv.onclick = function () { var a = document.createElement('a'); a.href = cv.toDataURL(); a.download = 'snapshot.png'; a.click(); };
});
socket.on('viewer', function (d) {
  if (d.id !== sel) return;
  var fr = $('viewerFrame');
  fr.style.display = 'block';
  fr.src = 'http://' + location.hostname + ':' + d.port;
});
socket.on('path', function (d) { if (d.id === sel) drawPath(d.pts); });

// ---------- الأزرار ----------
$('btnConnect').onclick = function () { socket.emit('connectBot', sel); };
$('btnDisconnect').onclick = function () { socket.emit('disconnectBot', sel); };
$('btnRename').onclick = function () {
  var f = fleet[sel]; if (!f) return;
  var l = prompt('الاسم الجديد:', f.label);
  if (l) socket.emit('rename', { id: sel, label: l });
};
$('btnRemove').onclick = function () { if (confirm('حذف هذا البوت من الأسطول؟')) socket.emit('removeBot', sel); };
$('btnSave').onclick = function () {
  socket.emit('updateBot', { id: sel, host: $('host').value, port: $('port').value, username: $('username').value, owner: $('owner').value, owners: $('owners').value, version: $('version').value });
};
$('btnViewer').onclick = function () { socket.emit('viewer', sel); };
$('btnSnap').onclick = function () { socket.emit('snap', sel); };
$('btnPath').onclick = function () { socket.emit('getPath', sel); };
$('btnChest').onclick = function () { socket.emit('cmd', { id: sel, name: 'chest' }); };
$('btnMine').onclick = function () { socket.emit('cmd', { id: sel, name: 'mine', args: [$('mineY').value, $('mineLen').value] }); };
$('btnWood').onclick = function () { socket.emit('cmd', { id: sel, name: 'wood', args: [$('woodN').value] }); };
$('btnBridge').onclick = function () { socket.emit('cmd', { id: sel, name: 'bridge', args: ['20'] }); };
$('btnSched').onclick = function () {
  var args = $('schArgs').value.trim().split(/\s+/).filter(Boolean);
  socket.emit('addSched', { id: sel, cmd: $('schCmd').value, every: $('schEvery').value, args: args });
};
setInterval(function () { if (sel && $('pathCanvas').style.display === 'block') socket.emit('getPath', sel); }, 5000);

var cmdBtns = document.querySelectorAll('button[data-cmd]');
for (var i = 0; i < cmdBtns.length; i++) {
  cmdBtns[i].onclick = function () { socket.emit('cmd', { id: sel, name: this.getAttribute('data-cmd') }); };
}
var setBoxes = document.querySelectorAll('input[data-set]');
for (var j = 0; j < setBoxes.length; j++) {
  setBoxes[j].onchange = function () { socket.emit('setting', { id: sel, key: this.getAttribute('data-set'), value: this.checked }); };
}

// الجويستيك: ضغط مستمر
var holds = {};
var ctlBtns = document.querySelectorAll('button[data-ctl]');
function startHold(dir) {
  socket.emit('ctl', { id: sel, dir: dir, on: true });
  clearInterval(holds[dir]);
  holds[dir] = setInterval(function () { socket.emit('ctl', { id: sel, dir: dir, on: true }); }, 400);
}
function endHold(dir) {
  clearInterval(holds[dir]);
  socket.emit('ctl', { id: sel, dir: dir, on: false });
}
for (var k = 0; k < ctlBtns.length; k++) {
  (function (btn) {
    var dir = btn.getAttribute('data-ctl');
    btn.addEventListener('pointerdown', function (e) { e.preventDefault(); startHold(dir); });
    btn.addEventListener('pointerup', function () { endHold(dir); });
    btn.addEventListener('pointerleave', function () { endHold(dir); });
    btn.addEventListener('pointercancel', function () { endHold(dir); });
    btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  })(ctlBtns[k]);
}
var lookBtns = document.querySelectorAll('button[data-look]');
for (var m = 0; m < lookBtns.length; m++) {
  lookBtns[m].onclick = function () { socket.emit('look', { id: sel, dir: this.getAttribute('data-look') }); };
}

function sendMsg() {
  var v = $('msg').value;
  if (!v.trim()) return;
  socket.emit('chat', { id: sel, text: v });
  $('msg').value = '';
}
$('btnSend').onclick = sendMsg;
$('msg').onkeydown = function (e) { if (e.key === 'Enter') sendMsg(); };
// ---------- Litematica و X-Ray ----------
function renderLite(d) {
  var st = $('liteStatus'), ms = $('liteMissing');
  if (!d || !d.loaded) { st.textContent = 'لم يُرفع ملف بعد'; ms.textContent = ''; return; }
  var line = d.name + ' — ' + d.total + ' بلوك • تم ' + d.done + ' • تخطّى ' + d.skipped;
  if (d.building) line += d.paused ? ' • ⏸️ متوقف مؤقتاً (ينقص موارد)' : ' • 🔨 يبني الآن';
  if (d.wrong) line += ' • اتجاه غلط: ' + d.wrong;
  st.textContent = line;
  ms.textContent = (d.missing && d.missing.length)
    ? 'الموارد الناقصة: ' + d.missing.map(function (m) { return m.name + ' ×' + m.missing; }).join(' ، ')
    : '';
}
socket.on('lite', function (d) { if (d && d.id === sel) renderLite(d); });
$('liteFile').onchange = function () {
  var f = this.files && this.files[0];
  if (!f) return;
  if (!sel) return toast('اختر بوت أولاً');
  if (f.size > 12 * 1024 * 1024) return toast('الملف كبير (الحد 12 ميجا)');
  var r = new FileReader();
  r.onload = function () {
    var b64 = String(r.result).split(',')[1] || '';
    socket.emit('lite:upload', { id: sel, name: f.name, data: b64 });
    toast('جاري تحليل الملف...');
  };
  r.readAsDataURL(f);
};
function liteOrigin() { return { id: sel, x: $('liteX').value, y: $('liteY').value, z: $('liteZ').value, rot: $('liteRot').value }; }
$('liteCheck').onclick = function () { if (!sel) return toast('اختر بوت أولاً'); socket.emit('lite:check', liteOrigin()); };
$('liteBuild').onclick = function () { if (!sel) return toast('اختر بوت أولاً'); socket.emit('lite:build', liteOrigin()); };
$('liteStop').onclick = function () { if (sel) socket.emit('lite:stop', { id: sel }); };
$('xrScan').onclick = function () { if (!sel) return toast('اختر بوت أولاً'); socket.emit('cmd', { id: sel, name: 'xray', args: [$('xrOre').value.trim(), $('xrR').value] }); };
$('xrMine').onclick = function () { if (!sel) return toast('اختر بوت أولاً'); socket.emit('cmd', { id: sel, name: 'xray', args: ['تعدين', $('xrOre').value.trim(), $('xrR').value] }); };

// ---------- القائمة الجانبية ----------
(function () {
  var dr = $('drawer'), ov = $('drawerOv');
  function openDr(v) { dr.classList.toggle('open', v); ov.classList.toggle('show', v); }
  $('burger').onclick = function () { openDr(!dr.classList.contains('open')); };
  ov.onclick = function () { openDr(false); };
  function go(id) {
    openDr(false);
    var t = $(id); if (!t) return;
    t.scrollIntoView({ behavior: 'smooth', block: 'start' });
    t.classList.add('flash');
    setTimeout(function () { t.classList.remove('flash'); }, 1500);
  }
  $('mnFleet').onclick = function () { openDr(false); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  $('mnPanel').onclick = function () { if (!sel) return toast('اختر بوت أولاً'); go('panel'); };
  $('mnLite').onclick = function () { go('cardLite'); };
  $('mnUpload').onclick = function () { openDr(false); if (!sel) return toast('اختر بوت أولاً'); $('liteFile').click(); };
  $('mnLiteCheck').onclick = function () { openDr(false); $('liteCheck').click(); };
  $('mnXray').onclick = function () { go('cardLite'); $('xrScan').click(); };
  $('mnXrayMine').onclick = function () { go('cardLite'); $('xrMine').click(); };
})();
</script>
</body>
</html>
HTML_END*/
