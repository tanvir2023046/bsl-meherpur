/**
 * seed.js — Initializes the database and seeds verified data.
 *
 * Works against whichever driver is active (PostgreSQL when DATABASE_URL
 * is set, otherwise the local SQLite file). Idempotent — safe to re-run.
 *
 * Administrative structure of Meherpur District (Khulna Division), verified from:
 *  - Wikipedia "Union councils of Meherpur District"
 *  - Banglapedia "Meherpur District" (3 upazilas, 2 municipalities, 18 unions)
 *  - Bangladesh Bureau of Statistics, Population Census 2022 (union lists)
 *
 * NOTE: 9 wards per municipality are verified; wards are seeded as numbered
 * wards ("১নং ওয়ার্ড" ... "৯নং ওয়ার্ড"). Village lists are NOT seeded —
 * admins add them via the Admin panel.
 *
 * Standalone usage:  node seed.js
 * Also called automatically by server.js on first boot when the DB is empty.
 */
const bcrypt = require('bcryptjs');
const db = require('./db');

// ---------------------------------------------------------------- roles
const ROLES = [
  ['super_admin',      'সুপার অ্যাডমিন',   ['view_dashboard','view_members','create_cv','edit_cv','verify_cv','archive_cv','manage_units','manage_positions','manage_users','view_nid','view_phone_full']],
  ['district_admin',   'জেলা অ্যাডমিন',    ['view_dashboard','view_members','create_cv','edit_cv','verify_cv','archive_cv','manage_units','manage_positions','manage_users','view_nid','view_phone_full']],
  ['upazila_admin',    'উপজেলা অ্যাডমিন',  ['view_dashboard','view_members','create_cv','edit_cv','verify_cv','archive_cv','manage_units','view_nid','view_phone_full']],
  ['municipality_admin','পৌরসভা অ্যাডমিন', ['view_dashboard','view_members','create_cv','edit_cv','verify_cv','archive_cv','manage_units','view_nid','view_phone_full']],
  ['union_admin',      'ইউনিয়ন অ্যাডমিন',  ['view_dashboard','view_members','create_cv','edit_cv','verify_cv','view_phone_full']],
  ['ward_admin',       'ওয়ার্ড অ্যাডমিন',   ['view_dashboard','view_members','create_cv','edit_cv']],
  ['data_entry',       'ডেটা এন্ট্রি',      ['view_dashboard','view_members','create_cv','edit_cv']],
  ['viewer',           'দর্শক',              ['view_dashboard']],
];

// ---------------------------------------------------------------- units
// Unit hierarchy. type: district|upazila|municipality|union|ward
const UNITS = [
  // [name_bn, name_en, type, parentNameBn]
  ['মেহেরপুর জেলা', 'Meherpur District', 'district', null],

  ['মেহেরপুর সদর উপজেলা', 'Meherpur Sadar Upazila', 'upazila', 'মেহেরপুর জেলা'],
  ['গাংনী উপজেলা', 'Gangni Upazila', 'upazila', 'মেহেরপুর জেলা'],
  ['মুজিবনগর উপজেলা', 'Mujibnagar Upazila', 'upazila', 'মেহেরপুর জেলা'],

  ['মেহেরপুর পৌরসভা', 'Meherpur Municipality', 'municipality', 'মেহেরপুর সদর উপজেলা'],
  ['গাংনী পৌরসভা', 'Gangni Municipality', 'municipality', 'গাংনী উপজেলা'],

  // Meherpur Sadar unions (verified: Wikipedia + BBS 2022 census)
  ['আমদহ ইউনিয়ন', 'Amdah Union', 'union', 'মেহেরপুর সদর উপজেলা'],
  ['আমঝুপি ইউনিয়ন', 'Amjhupi Union', 'union', 'মেহেরপুর সদর উপজেলা'],
  ['বাড়াদী ইউনিয়ন', 'Baradi Union', 'union', 'মেহেরপুর সদর উপজেলা'],
  ['বুড়িপোতা ইউনিয়ন', 'Buripota Union', 'union', 'মেহেরপুর সদর উপজেলা'],
  ['কুতুবপুর ইউনিয়ন', 'Kutubpur Union', 'union', 'মেহেরপুর সদর উপজেলা'],
  ['পিরোজপুর ইউনিয়ন', 'Pirojpur Union', 'union', 'মেহেরপুর সদর উপজেলা'],
  ['শ্যামপুর ইউনিয়ন', 'Shyampur Union', 'union', 'মেহেরপুর সদর উপজেলা'],

  // Mujibnagar unions (verified)
  ['দারিয়াপুর ইউনিয়ন', 'Dariapur Union', 'union', 'মুজিবনগর উপজেলা'],
  ['মনখালী ইউনিয়ন', 'Monkhali Union', 'union', 'মুজিবনগর উপজেলা'],
  ['বাগোয়ান ইউনিয়ন', 'Bagoan Union', 'union', 'মুজিবনগর উপজেলা'],
  ['মহাজনপুর ইউনিয়ন', 'Mahajonpur Union', 'union', 'মুজিবনগর উপজেলা'],

  // Gangni unions (verified)
  ['কাথুলী ইউনিয়ন', 'Kathuli Union', 'union', 'গাংনী উপজেলা'],
  ['তেতুলবাড়ীয়া ইউনিয়ন', 'Tetulbaria Union', 'union', 'গাংনী উপজেলা'],
  ['কাজিপুর ইউনিয়ন', 'Kazipur Union', 'union', 'গাংনী উপজেলা'],
  ['বামন্দী ইউনিয়ন', 'Bamondi Union', 'union', 'গাংনী উপজেলা'],
  ['মনমুড়া ইউনিয়ন', 'Monmura Union', 'union', 'গাংনী উপজেলা'],
  ['ষোলটাকা ইউনিয়ন', 'Sholotaka Union', 'union', 'গাংনী উপজেলা'],
  ['সাহারবাটি ইউনিয়ন', 'Saharbati Union', 'union', 'গাংনী উপজেলা'],
  ['ধানখোলা ইউনিয়ন', 'Dhankhola Union', 'union', 'গাংনী উপজেলা'],
  ['রায়পুর ইউনিয়ন', 'Raypur Union', 'union', 'গাংনী উপজেলা'],
];

const BN_DIGITS = ['০','১','২','৩','৪','৫','৬','৭','৮','৯'];
const bnNum = n => String(n).split('').map(d => BN_DIGITS[+d]).join('');
// 9 wards per municipality (verified: Meherpur & Gangni municipalities each have 9 wards)
for (const muni of ['মেহেরপুর পৌরসভা', 'গাংনী পৌরসভা'])
  for (let w = 1; w <= 9; w++)
    UNITS.push([`${bnNum(w)}নং ওয়ার্ড`, `Ward No. ${w}`, 'ward', muni]);

// ---------------------------------------------------------------- positions
const POSITIONS = [
  'সভাপতি','সহ-সভাপতি','সাধারণ সম্পাদক','যুগ্ম সাধারণ সম্পাদক',
  'সাংগঠনিক সম্পাদক','সহ-সাংগঠনিক সম্পাদক','দপ্তর সম্পাদক','প্রচার সম্পাদক',
  'অর্থ সম্পাদক','শিক্ষা বিষয়ক সম্পাদক','সাংস্কৃতিক সম্পাদক','ক্রীড়া সম্পাদক',
  'সদস্য',
];

async function seed() {
  // ---- roles (upsert) ----
  for (const [name, label, perms] of ROLES) {
    const pj = JSON.stringify(perms);
    if (db.isPg) {
      await db.run(
        `INSERT INTO roles (name, label_bn, permissions) VALUES (?,?,?)
         ON CONFLICT (name) DO UPDATE SET label_bn = EXCLUDED.label_bn, permissions = EXCLUDED.permissions`,
        [name, label, pj], { noReturning: true }); // roles table has no `id` column
    } else {
      await db.run(
        `INSERT OR REPLACE INTO roles (name, label_bn, permissions) VALUES (?,?,?)`,
        [name, label, pj]);
    }
  }

  // ---- units (insert missing only) ----
  const existing = await db.all('SELECT id, name_bn FROM units');
  const already = new Set(existing.map(r => r.name_bn));
  const idByName = {};
  for (const r of existing) idByName[r.name_bn] = Number(r.id);

  let order = 0;
  for (const [bn, en, type, parentBn] of UNITS) {
    if (already.has(bn)) continue;
    const parentId = parentBn ? (idByName[parentBn] ?? null) : null;
    const info = await db.run(
      `INSERT INTO units (name_bn, name_en, type, parent_id, sort_order) VALUES (?,?,?,?,?)`,
      [bn, en, type, parentId, order++]);
    idByName[bn] = info.lastID;
  }

  // ---- positions (only when table is empty) ----
  const posCount = await db.count('SELECT COUNT(*) AS c FROM positions');
  if (posCount === 0) {
    let i = 0;
    for (const t of POSITIONS) {
      await db.run('INSERT INTO positions (title_bn, sort_order) VALUES (?,?)', [t, i++]);
    }
  }

  // ---- default admin (only when missing) ----
  const adminCount = await db.count("SELECT COUNT(*) AS c FROM users WHERE username='admin'");
  if (adminCount === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await db.run(
      `INSERT INTO users (username, password_hash, full_name, role, unit_id)
       VALUES ('admin', ?, 'প্রধান প্রশাসক', 'super_admin', ?)`,
      [hash, idByName['মেহেরপুর জেলা']]);
    console.log('Seeded default user: admin / admin123  (CHANGE THIS PASSWORD AFTER FIRST LOGIN)');
  }

  const n = await db.count('SELECT COUNT(*) AS c FROM units');
  console.log(`OK: ${n} organizational units, ${ROLES.length} roles, ${POSITIONS.length} positions. (db: ${db.isPg ? 'PostgreSQL' : 'SQLite'})`);
}

module.exports = { seed };

// Standalone: node seed.js
if (require.main === module) {
  (async () => {
    await db.init();
    await seed();
    await db.close();
  })().catch(e => { console.error(e); process.exit(1); });
}
