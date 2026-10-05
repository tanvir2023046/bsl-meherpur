/**
 * server.js — BCL Meherpur CV Builder & Org Management System
 *
 * Node.js + Express. Database is dual-driver via db.js:
 *   - PostgreSQL (pg) when DATABASE_URL is set  -> Render / Supabase
 *   - better-sqlite3 file DB otherwise          -> local mode
 *
 * Session auth, bcrypt passwords, server-side role-based permissions
 * enforced on EVERY API route.
 */
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// ---- app -----------------------------------------------------------------
const app = express();
app.set('trust proxy', 1); // Render terminates TLS at its proxy
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  name: 'bclmhr.sid',
  secret: process.env.SESSION_SECRET || 'bcl-meherpur-change-me-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd, // only over HTTPS in production (Render serves HTTPS)
    maxAge: 1000 * 60 * 60 * 12,
  },
}));

// ---- helpers -------------------------------------------------------------
const getUser = async id =>
  db.get('SELECT id, username, full_name, role, unit_id, is_active FROM users WHERE id=?', [id]);

async function permsOf(user) {
  const row = await db.get('SELECT permissions FROM roles WHERE name=?', [user.role]);
  try { return JSON.parse(row.permissions); } catch { return []; }
}
const can = (user, perm) => permsOf(user).then(p => p.includes(perm));

async function requireLogin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'লগইন প্রয়োজন' });
  const u = await getUser(req.session.userId);
  if (!u || !u.is_active) { req.session.destroy(() => {}); return res.status(401).json({ error: 'লগইন প্রয়োজন' }); }
  req.user = u;
  next();
}
const requirePerm = perm => async (req, res, next) => {
  if (!(await can(req.user, perm))) return res.status(403).json({ error: 'এই কাজের অনুমতি নেই' });
  next();
};

// All descendant unit ids (including the unit itself)
async function subtreeIds(unitId) {
  const ids = [Number(unitId)];
  const q = [Number(unitId)];
  while (q.length) {
    const rows = await db.all('SELECT id FROM units WHERE parent_id=? AND is_active=1', [q.pop()]);
    for (const r of rows) { ids.push(Number(r.id)); q.push(Number(r.id)); }
  }
  return ids;
}
// Units visible to this user (their organizational scope)
async function scopeIds(user) {
  if (user.role === 'super_admin' || user.role === 'district_admin') return null; // all
  if (!user.unit_id) return [];
  return subtreeIds(user.unit_id);
}
async function unitInScope(user, unitId) {
  if (!unitId) return true;
  const s = await scopeIds(user);
  return s === null || s.includes(Number(unitId));
}

// ---- privacy: strip/mask sensitive fields SERVER-SIDE --------------------
function maskPhone(p) {
  if (!p) return p;
  const d = String(p).replace(/\D/g, '');
  if (d.length < 4) return '***';
  return d.slice(0, 3) + '****' + d.slice(-3);
}
async function sanitizeCv(row, user) {
  const out = { ...row };
  try { out.data = JSON.parse(row.data); } catch { out.data = {}; }
  const p = out.data.personal || {};
  if (!(await can(user, 'view_nid'))) delete p.nid;
  if (!(await can(user, 'view_phone_full'))) {
    if (p.mobile) p.mobile = maskPhone(p.mobile);
    if (p.mobile2) p.mobile2 = maskPhone(p.mobile2);
  }
  return out;
}

// JSON path expression for the stored mobile number (dialect-specific)
const MOBILE_EXPR = db.isPg
  ? "(data::jsonb -> 'personal' ->> 'mobile')"
  : "json_extract(data,'$.personal.mobile')";

// ---- auth routes ---------------------------------------------------------
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const u = await db.get('SELECT * FROM users WHERE username=? AND is_active=1', [username]);
  if (!u || !bcrypt.compareSync(password || '', u.password_hash))
    return res.status(401).json({ error: 'ব্যবহারকারীর নাম বা পাসওয়ার্ড ভুল' });
  req.session.userId = Number(u.id);
  res.json({ ok: true, user: { id: Number(u.id), username: u.username, full_name: u.full_name, role: u.role, unit_id: u.unit_id } });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get('/api/me', requireLogin, async (req, res) => {
  res.json({ user: req.user, permissions: await permsOf(req.user) });
});

// ---- uploads (photos/signatures) -----------------------------------------
fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, 'uploads'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname)),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => file.mimetype.startsWith('image/')
    ? cb(null, true) : cb(new Error('শুধু ছবি আপলোড করা যাবে')),
});

app.post('/api/upload', requireLogin, requirePerm('create_cv'), (req, res) => {
  upload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message || 'আপলোড ব্যর্থ হয়েছে' });
    if (!req.file) return res.status(400).json({ error: 'কোনো ফাইল পাওয়া যায়নি' });
    res.json({ ok: true, path: req.file.filename });
  });
});

// Serve uploaded images only to logged-in users (photos are sensitive)
// NOTE: on Render's free tier the filesystem is ephemeral — uploaded files
// are lost on redeploy/restart. For persistent uploads use object storage.
app.get('/uploads/:name', requireLogin, (req, res) => {
  const safe = path.basename(req.params.name);
  const fp = path.join(__dirname, 'uploads', safe);
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.sendFile(fp);
});

// ---- organizational units -------------------------------------------------
app.get('/api/units', requireLogin, async (req, res) => {
  const rows = await db.all('SELECT * FROM units WHERE is_active=1 ORDER BY sort_order, id');
  res.json({ units: rows });
});

function buildTree(rows) {
  const map = {}, roots = [];
  for (const r of rows) map[r.id] = { ...r, children: [] };
  for (const r of rows) {
    if (r.parent_id && map[r.parent_id]) map[r.parent_id].children.push(map[r.id]);
    else roots.push(map[r.id]);
  }
  return roots;
}
app.get('/api/units/tree', requireLogin, async (req, res) => {
  const rows = await db.all('SELECT * FROM units WHERE is_active=1 ORDER BY sort_order, id');
  res.json({ tree: buildTree(rows) });
});

app.post('/api/units', requireLogin, requirePerm('manage_units'), async (req, res) => {
  const { name_bn, name_en, type, parent_id } = req.body || {};
  if (!name_bn || !String(name_bn).trim()) return res.status(400).json({ error: 'ইউনিটের নাম দিন' });
  if (!['district','upazila','municipality','union','ward','village','other'].includes(type))
    return res.status(400).json({ error: 'ইউনিটের ধরন সঠিক নয়' });
  if (parent_id && !(await unitInScope(req.user, parent_id)))
    return res.status(403).json({ error: 'এই ইউনিটের অধীনে যোগ করার অনুমতি নেই' });
  const info = await db.run(
    'INSERT INTO units (name_bn, name_en, type, parent_id) VALUES (?,?,?,?)',
    [name_bn.trim(), name_en || null, type, parent_id || null]);
  res.json({ ok: true, id: info.lastID });
});

app.put('/api/units/:id', requireLogin, requirePerm('manage_units'), async (req, res) => {
  const id = Number(req.params.id);
  const cur = await db.get('SELECT * FROM units WHERE id=?', [id]);
  if (!cur) return res.status(404).json({ error: 'ইউনিট পাওয়া যায়নি' });
  if (!(await unitInScope(req.user, id))) return res.status(403).json({ error: 'অনুমতি নেই' });
  const { name_bn, name_en, type, parent_id, is_active } = req.body || {};
  if (parent_id && Number(parent_id) === id) return res.status(400).json({ error: 'নিজেকেই প্যারেন্ট করা যাবে না' });
  await db.run(
    'UPDATE units SET name_bn=?, name_en=?, type=?, parent_id=?, is_active=? WHERE id=?',
    [name_bn ?? cur.name_bn, name_en ?? cur.name_en, type ?? cur.type,
     parent_id === undefined ? cur.parent_id : (parent_id || null),
     is_active === undefined ? cur.is_active : (is_active ? 1 : 0), id]);
  res.json({ ok: true });
});

// ---- positions ------------------------------------------------------------
app.get('/api/positions', requireLogin, async (req, res) => {
  res.json({ positions: await db.all('SELECT * FROM positions WHERE is_active=1 ORDER BY sort_order') });
});
app.post('/api/positions', requireLogin, requirePerm('manage_positions'), async (req, res) => {
  const { title_bn, level } = req.body || {};
  if (!title_bn || !String(title_bn).trim()) return res.status(400).json({ error: 'পদের নাম দিন' });
  const info = await db.run('INSERT INTO positions (title_bn, level) VALUES (?,?)', [title_bn.trim(), level || null]);
  res.json({ ok: true, id: info.lastID });
});
app.put('/api/positions/:id', requireLogin, requirePerm('manage_positions'), async (req, res) => {
  const { title_bn, is_active } = req.body || {};
  await db.run(
    'UPDATE positions SET title_bn=COALESCE(?,title_bn), is_active=COALESCE(?,is_active) WHERE id=?',
    [title_bn || null, is_active === undefined ? null : (is_active ? 1 : 0), Number(req.params.id)]);
  res.json({ ok: true });
});

// ---- dashboard stats (counts only — NEVER member rows) --------------------
app.get('/api/dashboard', requireLogin, requirePerm('view_dashboard'), async (req, res) => {
  const s = await scopeIds(req.user);
  const inScope = s === null ? '' : `AND unit_id IN (${s.map(() => '?').join(',')})`;
  const params = s === null ? [] : s;
  const countWhere = async (where, extra = []) =>
    db.count(`SELECT COUNT(*) AS c FROM cvs WHERE 1=1 ${where} ${inScope}`, [...extra, ...params]);

  const byLevel = {};
  for (const t of ['district','upazila','municipality','union','ward','village']) {
    const unitIds = (await db.all('SELECT id FROM units WHERE type=? AND is_active=1', [t])).map(r => Number(r.id));
    const scoped = s === null ? unitIds : unitIds.filter(id => s.includes(id));
    byLevel[t] = scoped.length
      ? await db.count(`SELECT COUNT(*) AS c FROM cvs WHERE unit_id IN (${scoped.map(() => '?').join(',')})`, scoped)
      : 0;
  }

  res.json({
    stats: {
      total_members: await countWhere(''),
      submitted: await countWhere(`AND status='submitted'`),
      verified: await countWhere(`AND status='verified'`),
      drafts: await countWhere(`AND status='draft'`),
      archived: await countWhere(`AND status='archived'`),
      by_level: byLevel,
    },
  });
});

// ---- CVs ------------------------------------------------------------------
const VALID_STATUSES = ['draft', 'submitted', 'verified', 'archived'];

function validateCvData(data) {
  const errors = [];
  const p = (data && data.personal) || {};
  if (!p.full_name || !String(p.full_name).trim()) errors.push('পূর্ণ নাম আবশ্যক');
  if (p.mobile && !/^01[0-9]{9}$/.test(String(p.mobile).replace(/[\s-]/g, '')))
    errors.push('মোবাইল নম্বর সঠিক নয় (01 দিয়ে শুরু, ১১ সংখ্যা)');
  if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) errors.push('ইমেইল ঠিকানা সঠিক নয়');
  if (p.nid && !/^[0-9]{10}$|^[0-9]{17}$/.test(String(p.nid).replace(/[\s-]/g, '')))
    errors.push('জাতীয় পরিচয়পত্র নম্বর সঠিক নয়');
  return errors;
}

app.get('/api/cvs', requireLogin, requirePerm('view_members'), async (req, res) => {
  const { q, status, unit_id, level, sort = 'updated_at', order = 'DESC' } = req.query;
  const s = await scopeIds(req.user);
  const where = [], params = [];
  if (s !== null) { where.push(`cvs.unit_id IN (${s.map(() => '?').join(',')})`); params.push(...s); }
  if (status && VALID_STATUSES.includes(status)) { where.push('cvs.status=?'); params.push(status); }
  if (unit_id) { where.push('cvs.unit_id=?'); params.push(Number(unit_id)); }
  if (level) {
    const ids = (await db.all('SELECT id FROM units WHERE type=? AND is_active=1', [level])).map(r => Number(r.id));
    const scoped = s === null ? ids : ids.filter(id => s.includes(id));
    where.push(scoped.length ? `cvs.unit_id IN (${scoped.map(() => '?').join(',')})` : '1=0');
    params.push(...scoped);
  }
  if (q) {
    where.push(`(cvs.data LIKE ? OR cvs.cv_code LIKE ?)`);
    params.push(`%${q}%`, `%${q}%`);
  }
  const sortCol = ['updated_at','created_at','id'].includes(sort) ? sort : 'updated_at';
  const dir = order === 'ASC' ? 'ASC' : 'DESC';
  const rows = await db.all(
    `SELECT cvs.*, units.name_bn AS unit_name
     FROM cvs LEFT JOIN units ON units.id = cvs.unit_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY ${sortCol} ${dir} LIMIT 200`, params);
  res.json({ cvs: await Promise.all(rows.map(r => sanitizeCv(r, req.user))) });
});

app.get('/api/cvs/:id', requireLogin, requirePerm('view_members'), async (req, res) => {
  const row = await db.get(
    `SELECT cvs.*, units.name_bn AS unit_name FROM cvs LEFT JOIN units ON units.id=cvs.unit_id WHERE cvs.id=?`,
    [Number(req.params.id)]);
  if (!row) return res.status(404).json({ error: 'CV পাওয়া যায়নি' });
  if (!(await unitInScope(req.user, row.unit_id))) return res.status(403).json({ error: 'অনুমতি নেই' });
  res.json({ cv: await sanitizeCv(row, req.user) });
});

app.post('/api/cvs', requireLogin, requirePerm('create_cv'), async (req, res) => {
  const { data, unit_id, status } = req.body || {};
  const errors = validateCvData(data || {});
  if (errors.length) return res.status(400).json({ error: errors[0], errors });
  if (unit_id && !(await unitInScope(req.user, unit_id)))
    return res.status(403).json({ error: 'এই ইউনিটে CV তৈরির অনুমতি নেই' });
  const st = VALID_STATUSES.includes(status) ? status : 'draft';
  // duplicate mobile warning
  const mobile = data?.personal?.mobile;
  let dup = null;
  if (mobile) {
    dup = await db.get(`SELECT id FROM cvs WHERE ${MOBILE_EXPR}=? LIMIT 1`, [mobile]);
  }
  const info = await db.run(
    `INSERT INTO cvs (data, unit_id, status, created_by, updated_by) VALUES (?,?,?,?,?)`,
    [JSON.stringify(data || {}), unit_id || req.user.unit_id || null, st, req.user.id, req.user.id]);
  const code = 'BCL-MHR-' + String(info.lastID).padStart(6, '0');
  await db.run('UPDATE cvs SET cv_code=? WHERE id=?', [code, info.lastID]);
  res.json({ ok: true, id: info.lastID, cv_code: code, duplicate_mobile: !!dup });
});

app.put('/api/cvs/:id', requireLogin, requirePerm('edit_cv'), async (req, res) => {
  const id = Number(req.params.id);
  const cur = await db.get('SELECT * FROM cvs WHERE id=?', [id]);
  if (!cur) return res.status(404).json({ error: 'CV পাওয়া যায়নি' });
  if (!(await unitInScope(req.user, cur.unit_id))) return res.status(403).json({ error: 'অনুমতি নেই' });
  if (cur.status === 'verified' && !(await can(req.user, 'verify_cv')))
    return res.status(403).json({ error: 'যাচাইকৃত CV সম্পাদনার অনুমতি নেই' });
  const { data, unit_id, status, photo_path, signature_path } = req.body || {};
  const errors = validateCvData(data || JSON.parse(cur.data));
  if (errors.length) return res.status(400).json({ error: errors[0], errors });
  await db.run(
    `UPDATE cvs SET data=COALESCE(?,data), unit_id=COALESCE(?,unit_id),
     status=COALESCE(?,status), photo_path=COALESCE(?,photo_path),
     signature_path=COALESCE(?,signature_path), updated_by=?,
     updated_at=${db.NOW} WHERE id=?`,
    [data ? JSON.stringify(data) : null, unit_id ?? null,
     status && VALID_STATUSES.includes(status) ? status : null,
     photo_path ?? null, signature_path ?? null, req.user.id, id]);
  res.json({ ok: true });
});

app.post('/api/cvs/:id/verify', requireLogin, requirePerm('verify_cv'), async (req, res) => {
  const id = Number(req.params.id);
  const cur = await db.get('SELECT * FROM cvs WHERE id=?', [id]);
  if (!cur || !(await unitInScope(req.user, cur.unit_id))) return res.status(404).json({ error: 'CV পাওয়া যায়নি' });
  await db.run(`UPDATE cvs SET status='verified', updated_by=?, updated_at=${db.NOW} WHERE id=?`, [req.user.id, id]);
  res.json({ ok: true });
});

app.post('/api/cvs/:id/archive', requireLogin, requirePerm('archive_cv'), async (req, res) => {
  const id = Number(req.params.id);
  const cur = await db.get('SELECT * FROM cvs WHERE id=?', [id]);
  if (!cur || !(await unitInScope(req.user, cur.unit_id))) return res.status(404).json({ error: 'CV পাওয়া যায়নি' });
  await db.run(`UPDATE cvs SET status='archived', updated_by=?, updated_at=${db.NOW} WHERE id=?`, [req.user.id, id]);
  res.json({ ok: true });
});

// ---- users (admin) ----------------------------------------------------------
app.get('/api/users', requireLogin, requirePerm('manage_users'), async (req, res) => {
  const rows = await db.all(
    `SELECT users.id, users.username, users.full_name, users.role, users.unit_id,
            users.is_active, units.name_bn AS unit_name, roles.label_bn AS role_bn
     FROM users LEFT JOIN units ON units.id=users.unit_id
     LEFT JOIN roles ON roles.name=users.role ORDER BY users.id`);
  res.json({ users: rows, roles: await db.all('SELECT * FROM roles') });
});

app.post('/api/users', requireLogin, requirePerm('manage_users'), async (req, res) => {
  const { username, password, full_name, role, unit_id } = req.body || {};
  if (!username || !password || !role) return res.status(400).json({ error: 'ব্যবহারকারীর নাম, পাসওয়ার্ড ও ভূমিকা আবশ্যক' });
  if (password.length < 6) return res.status(400).json({ error: 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে' });
  const roleExists = await db.get('SELECT 1 AS one FROM roles WHERE name=?', [role]);
  if (!roleExists) return res.status(400).json({ error: 'ভূমিকা সঠিক নয়' });
  try {
    const info = await db.run(
      'INSERT INTO users (username, password_hash, full_name, role, unit_id) VALUES (?,?,?,?,?)',
      [username.trim(), bcrypt.hashSync(password, 10), full_name || null, role, unit_id || null]);
    res.json({ ok: true, id: info.lastID });
  } catch { res.status(400).json({ error: 'এই ব্যবহারকারীর নাম ইতিমধ্যে আছে' }); }
});

app.put('/api/users/:id', requireLogin, requirePerm('manage_users'), async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'নিজের অ্যাকাউন্ট এখান থেকে বদলানো যাবে না' });
  const { full_name, role, unit_id, is_active, password } = req.body || {};
  const sets = [], params = [];
  if (full_name !== undefined) { sets.push('full_name=?'); params.push(full_name || null); }
  if (role) { sets.push('role=?'); params.push(role); }
  if (unit_id !== undefined) { sets.push('unit_id=?'); params.push(unit_id || null); }
  if (is_active !== undefined) { sets.push('is_active=?'); params.push(is_active ? 1 : 0); }
  if (password) {
    if (password.length < 6) return res.status(400).json({ error: 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে' });
    sets.push('password_hash=?'); params.push(bcrypt.hashSync(password, 10));
  }
  if (!sets.length) return res.status(400).json({ error: 'পরিবর্তনের কিছু নেই' });
  params.push(id);
  await db.run(`UPDATE users SET ${sets.join(',')} WHERE id=?`, params);
  res.json({ ok: true });
});

app.get('/api/roles', requireLogin, async (req, res) => {
  res.json({ roles: await db.all('SELECT * FROM roles') });
});

// ---- frontend: single self-contained index.html at project root ---------------
// (flat structure: no public/ folder — everything is uploaded at repo root)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
// SPA fallback (but keep /api 404s clean)
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'পাওয়া যায়নি' });
  if (req.method !== 'GET') return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ---- boot: init DB, auto-seed when empty, then listen ----------------------
(async () => {
  await db.init();
  const roleCount = await db.count('SELECT COUNT(*) AS c FROM roles');
  if (roleCount === 0) {
    console.log('Database is empty — running seed...');
    await require('./seed').seed();
  }
  app.listen(PORT, () => console.log(
    `BCL Meherpur CV System running on http://localhost:${PORT} (db: ${db.isPg ? 'PostgreSQL' : 'SQLite'})`));
})().catch(e => { console.error('Failed to start:', e); process.exit(1); });
