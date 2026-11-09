'use strict';
/**
 * XI Concurso Nacional de Matemática Lima Este 2026 · Tarpuy
 * Servidor de inscripciones (Express + Postgres/Neon)
 */
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');
const rateLimit = require('express-rate-limit');
const ExcelJS = require('exceljs');

const { DATABASE_URL, ADMIN_PASSWORD, SESSION_SECRET } = process.env;
if (!DATABASE_URL || !ADMIN_PASSWORD || !SESSION_SECRET) {
  console.error('Faltan variables de entorno: DATABASE_URL, ADMIN_PASSWORD y SESSION_SECRET son obligatorias.');
  process.exit(1);
}
const PORT = process.env.PORT || 8080;
const P_DEL = Number(process.env.PRECIO_DELEGACION) || 13; // S/ por alumno de delegación
const P_LIB = Number(process.env.PRECIO_LIBRE) || 10;     // S/ por alumno libre
const IS_PROD = process.env.NODE_ENV === 'production';

const pool = new Pool({ connectionString: DATABASE_URL, max: 5, idleTimeoutMillis: 30000 });

/* ------------------------------ Esquema ------------------------------ */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS fichas (
  id          SERIAL PRIMARY KEY,
  ie          TEXT NOT NULL,
  director    TEXT NOT NULL,
  tipo        TEXT NOT NULL CHECK (tipo IN ('Estatal','Privado')),
  direccion   TEXT NOT NULL,
  telefono    TEXT NOT NULL,
  correo      TEXT NOT NULL,
  monto       INTEGER NOT NULL,
  operacion   TEXT NOT NULL,
  medio       TEXT NOT NULL CHECK (medio IN ('Yape','Transferencia')),
  pagador     TEXT,
  verificado  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS asesores (
  id        SERIAL PRIMARY KEY,
  ficha_id  INTEGER NOT NULL REFERENCES fichas(id) ON DELETE CASCADE,
  nivel     TEXT NOT NULL,
  nombre    TEXT NOT NULL,
  telefono  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alumnos (
  id        SERIAL PRIMARY KEY,
  ficha_id  INTEGER NOT NULL REFERENCES fichas(id) ON DELETE CASCADE,
  nivel     TEXT NOT NULL,
  grado     TEXT NOT NULL,
  nro       INTEGER NOT NULL,
  dni       TEXT NOT NULL UNIQUE,
  nombre    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS libres (
  id          SERIAL PRIMARY KEY,
  dni         TEXT NOT NULL UNIQUE,
  grado       TEXT NOT NULL,
  nivel       TEXT NOT NULL,
  nombre      TEXT NOT NULL,
  monto       INTEGER NOT NULL,
  operacion   TEXT NOT NULL,
  medio       TEXT NOT NULL CHECK (medio IN ('Yape','Transferencia')),
  pagador     TEXT,
  verificado  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alumnos_ficha ON alumnos(ficha_id);
CREATE INDEX IF NOT EXISTS idx_asesores_ficha ON asesores(ficha_id);
ALTER TABLE libres ADD COLUMN IF NOT EXISTS telefono TEXT;
ALTER TABLE libres ADD COLUMN IF NOT EXISTS aula TEXT;
ALTER TABLE libres ADD COLUMN IF NOT EXISTS categoria TEXT;
ALTER TABLE libres DROP CONSTRAINT IF EXISTS libres_medio_check;
ALTER TABLE libres ADD CONSTRAINT libres_medio_check CHECK (medio IN ('Yape','Transferencia','Efectivo'));
`;

/* ------------------------------ Datos fijos ------------------------------ */
const GRADOS = [
  { n: 'Inicial · 3 años', v: 'Inicial' },
  { n: 'Inicial · 4 años', v: 'Inicial' },
  { n: 'Inicial · 5 años', v: 'Inicial' },
  ...[1, 2, 3, 4, 5, 6].map(i => ({ n: `${i}° de Primaria`, v: 'Primaria' })),
  ...[1, 2, 3, 4, 5].map(i => ({ n: `${i}° de Secundaria`, v: 'Secundaria' })),
];
const GRADO_NIVEL = Object.fromEntries(GRADOS.map(g => [g.n, g.v]));
const NIVELES = ['Inicial', 'Primaria', 'Secundaria'];
const MAX_POR_GRADO = 10;

/* ------------------------------ Validación ------------------------------ */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);
const clean = (v, max = 160) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function parseOps(v) {
  const ops = clean(v, 120).split(/[,;\s]+/).filter(Boolean);
  if (!ops.length || ops.length > 6 || !ops.every(o => /^[A-Za-z0-9-]{4,20}$/.test(o))) {
    throw bad('El N° de operación no es válido (letras y números, 4 a 20 caracteres; separa varios con coma).');
  }
  return ops.join(', ');
}
const CATEGORIAS = ['CATEGORÍA “A” : GOTTFRIED LEIBNIZ (Alumnos regulares)', 'CATEGORÍA “B” : FRIEDRICH GAUSS (Alumnos de círculo)'];
const AULAS = ['Regular', 'C2', 'C3', 'C4', 'BASICO', 'INTERMEDIO', 'AVANZADO'];
function parseMedio(v, extra = []) {
  if (v !== 'Yape' && v !== 'Transferencia' && !extra.includes(v)) throw bad('Elige el medio de pago.');
  return v;
}
function dniOk(dni, grado) {
  if (grado === '5° de Primaria') return /^(\d{8}|\d{14})$/.test(dni); // DNI o código de estudiante
  return /^\d{8}$/.test(dni);
}

/* ------------------------------ App ------------------------------ */
const app = express();
app.set('trust proxy', 1); // Fly.io está detrás de un proxy
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  next();
});

const writeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados envíos desde esta conexión. Espera unos minutos e inténtalo otra vez.' },
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera 15 minutos.' },
});

app.get('/healthz', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch { res.status(500).json({ ok: false }); }
});

/* ---------- Inscripción de delegación ---------- */
app.post('/api/fichas', writeLimiter, wrap(async (req, res) => {
  const b = req.body || {};
  const ie = clean(b.ie), director = clean(b.director), direccion = clean(b.dir, 200);
  const tel = clean(b.tel, 20), correo = clean(b.mail, 120), pagador = clean(b.pagador, 120);
  if (!ie || !director || !direccion) throw bad('Completa los datos de la institución.');
  if (b.tipo !== 'Estatal' && b.tipo !== 'Privado') throw bad('Elige el tipo de I.E.');
  if (!/^\d{6,9}$/.test(tel)) throw bad('El teléfono no es válido.');
  if (!/^\S+@\S+\.\S+$/.test(correo)) throw bad('El correo no es válido.');
  const operacion = parseOps(b.operacion), medio = parseMedio(b.medio);

  if (!Array.isArray(b.alumnos) || !b.alumnos.length) throw bad('Agrega al menos un alumno.');
  if (b.alumnos.length > GRADOS.length * MAX_POR_GRADO) throw bad('Demasiados alumnos.');
  const alumnos = [], seen = new Set(), porGrado = {}, nivelesUsados = new Set();
  for (const a of b.alumnos) {
    const grado = clean(a.grado, 40), nivel = GRADO_NIVEL[grado];
    if (!nivel) throw bad('Grado no válido.');
    const dni = clean(a.dni, 14), nombre = clean(a.nombre, 120);
    if (!nombre) throw bad('Falta el nombre de un alumno.');
    if (!dniOk(dni, grado)) throw bad(`DNI no válido: ${dni || '(vacío)'}.`);
    if (seen.has(dni)) throw bad(`El DNI ${dni} está repetido en la ficha.`);
    seen.add(dni);
    porGrado[grado] = (porGrado[grado] || 0) + 1;
    if (porGrado[grado] > MAX_POR_GRADO) throw bad(`Máximo ${MAX_POR_GRADO} alumnos por grado (${grado}).`);
    alumnos.push({ nivel, grado, nro: porGrado[grado], dni, nombre });
    nivelesUsados.add(nivel);
  }

  const asesores = [];
  for (const a of Array.isArray(b.asesores) ? b.asesores : []) {
    const nivel = clean(a.nivel, 20), nombre = clean(a.nombre, 120), t = clean(a.tel, 20);
    if (!NIVELES.includes(nivel)) throw bad('Nivel de asesor no válido.');
    if (!nombre || !/^\d{6,9}$/.test(t)) throw bad(`Completa el asesor de ${nivel} (nombre y teléfono).`);
    asesores.push({ nivel, nombre, tel: t });
  }
  for (const n of nivelesUsados) {
    if (!asesores.some(a => a.nivel === n)) throw bad(`Falta el asesor del nivel ${n}.`);
  }

  const monto = alumnos.length * P_DEL; // el servidor calcula el monto, no el navegador
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dnis = alumnos.map(a => a.dni);
    const dup = await client.query(
      `SELECT dni FROM alumnos WHERE dni = ANY($1) UNION SELECT dni FROM libres WHERE dni = ANY($1)`, [dnis]);
    if (dup.rowCount) {
      throw new HttpError(409, `Ya existe una inscripción con estos DNI: ${dup.rows.map(r => r.dni).join(', ')}.`);
    }
    const f = await client.query(
      `INSERT INTO fichas (ie,director,tipo,direccion,telefono,correo,monto,operacion,medio,pagador)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [ie, director, b.tipo, direccion, tel, correo, monto, operacion, medio, pagador || null]);
    const id = f.rows[0].id;
    for (const a of asesores) {
      await client.query('INSERT INTO asesores (ficha_id,nivel,nombre,telefono) VALUES ($1,$2,$3,$4)', [id, a.nivel, a.nombre, a.tel]);
    }
    await client.query(
      `INSERT INTO alumnos (ficha_id,nivel,grado,nro,dni,nombre)
       SELECT $1, * FROM unnest($2::text[],$3::text[],$4::int[],$5::text[],$6::text[])`,
      [id, alumnos.map(a => a.nivel), alumnos.map(a => a.grado), alumnos.map(a => a.nro), dnis, alumnos.map(a => a.nombre)]);
    await client.query('COMMIT');
    res.status(201).json({ ok: true, id, monto, alumnos: alumnos.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') throw new HttpError(409, 'Uno de los DNI ya está inscrito.');
    throw e;
  } finally { client.release(); }
}));

/* ---------- Inscripción de alumno libre ---------- */
app.post('/api/libres', writeLimiter, wrap(async (req, res) => {
  const b = req.body || {};
  const grado = clean(b.grado, 40), nivel = GRADO_NIVEL[grado];
  if (!nivel) throw bad('Elige el grado.');
  const dni = clean(b.dni, 14), nombre = clean(b.nombre, 120), pagador = clean(b.pagador, 120);
  if (!nombre) throw bad('Falta el nombre del alumno.');
  const tel = clean(b.tel, 20);
  if (!/^9\d{8}$/.test(tel)) throw bad('El celular debe tener 9 dígitos y empezar con 9.');
  if (!dniOk(dni, grado)) throw bad('El DNI debe tener 8 dígitos.');
  const aula = clean(b.aula, 20);
  if (!AULAS.includes(aula)) throw bad('Elige el aula.');
  const categoria = clean(b.categoria, 80);
  if (!CATEGORIAS.includes(categoria)) throw bad('Elige la categoría.');
  const medio = parseMedio(b.medio, ['Efectivo']);
  if (!pagador) throw bad('Escribe el nombre de quien hizo el pago.');
  const operacion = medio === 'Efectivo' ? '' : parseOps(b.operacion);
  try {
    const dup = await pool.query(`SELECT 1 FROM alumnos WHERE dni=$1 UNION SELECT 1 FROM libres WHERE dni=$1`, [dni]);
    if (dup.rowCount) throw new HttpError(409, `El DNI ${dni} ya está inscrito.`);
    const r = await pool.query(
      `INSERT INTO libres (dni,grado,nivel,nombre,telefono,monto,operacion,medio,pagador,aula,categoria)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [dni, grado, nivel, nombre, tel, P_LIB, operacion, medio, pagador || null, aula, categoria]);
    res.status(201).json({ ok: true, id: r.rows[0].id, monto: P_LIB });
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, `El DNI ${dni} ya está inscrito.`);
    throw e;
  }
}));

/* ------------------------------ Panel del organizador ------------------------------ */
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex');
const sameStr = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
function cookies(req) {
  const out = {};
  for (const p of (req.headers.cookie || '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return out;
}
function isAdmin(req) {
  const t = cookies(req).adm;
  if (!t) return false;
  const [exp, sig] = t.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return sameStr(sig, sign(exp));
}
const needAdmin = (req, res, next) => isAdmin(req) ? next() : res.status(401).json({ error: 'No autorizado' });

app.post('/api/admin/login', loginLimiter, (req, res) => {
  if (!sameStr(req.body && req.body.password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  const exp = String(Date.now() + 12 * 3600 * 1000);
  res.set('Set-Cookie', `adm=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${IS_PROD ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (_req, res) => {
  res.set('Set-Cookie', `adm=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${IS_PROD ? '; Secure' : ''}`);
  res.json({ ok: true });
});

async function loadAll() {
  const [f, as, al, li] = await Promise.all([
    pool.query('SELECT * FROM fichas ORDER BY id'),
    pool.query('SELECT * FROM asesores ORDER BY id'),
    pool.query('SELECT * FROM alumnos ORDER BY ficha_id, id'),
    pool.query('SELECT * FROM libres ORDER BY id'),
  ]);
  const fichas = f.rows.map(r => ({
    _id: r.id, ie: r.ie, director: r.director, tipo: r.tipo, dir: r.direccion, tel: r.telefono, mail: r.correo,
    monto: r.monto, operacion: r.operacion, medio: r.medio, pagador: r.pagador || '', verificado: r.verificado,
    fecha: r.created_at, asesores: [], alumnos: [],
  }));
  const byId = new Map(fichas.map(x => [x._id, x]));
  for (const a of as.rows) byId.get(a.ficha_id)?.asesores.push({ nivel: a.nivel, nombre: a.nombre, tel: a.telefono });
  for (const a of al.rows) byId.get(a.ficha_id)?.alumnos.push({ nivel: a.nivel, grado: a.grado, n: a.nro, dni: a.dni, nombre: a.nombre });
  const libres = li.rows.map(r => ({
    _id: r.id, dni: r.dni, grado: r.grado, nivel: r.nivel, nombre: r.nombre, aula: r.aula || '', categoria: r.categoria || '', tel: r.telefono || '', monto: r.monto,
    operacion: r.operacion, medio: r.medio, pagador: r.pagador || '', verificado: r.verificado, fecha: r.created_at,
  }));
  return { fichas, libres };
}

app.get('/api/admin/data', needAdmin, wrap(async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await loadAll());
}));

app.patch('/api/admin/verify', needAdmin, wrap(async (req, res) => {
  const { t, id, v } = req.body || {};
  if (!['fichas', 'libres'].includes(t) || !Number.isInteger(id)) throw bad('Datos no válidos.');
  await pool.query(`UPDATE ${t} SET verificado = $1 WHERE id = $2`, [!!v, id]);
  res.json({ ok: true });
}));

app.get('/api/admin/export.xlsx', needAdmin, wrap(async (_req, res) => {
  const { fichas, libres } = await loadAll();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Tarpuy · XI Concurso Nacional de Matemática Lima Este 2026';
  const estado = (v) => v ? 'Verificado' : 'Pendiente';
  const sheet = (name, cols, rows) => {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = cols.map(([header, key, width]) => ({ header, key, width }));
    rows.forEach(r => ws.addRow(r));
    const h = ws.getRow(1);
    h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A1A5C' } };
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
    return ws;
  };
  const alumnos = [], asesores = [];
  fichas.forEach(f => {
    f.alumnos.forEach(a => alumnos.push({ ie: f.ie, tipo: f.tipo, nivel: a.nivel, grado: a.grado, n: a.n, dni: a.dni, nombre: a.nombre }));
    f.asesores.forEach(a => asesores.push({ ie: f.ie, nivel: a.nivel, nombre: a.nombre, tel: a.tel }));
  });
  sheet('Alumnos', [['I.E.', 'ie', 38], ['Tipo', 'tipo', 10], ['Nivel', 'nivel', 12], ['Grado', 'grado', 18], ['N°', 'n', 6], ['DNI / Código', 'dni', 16], ['Apellidos y nombres', 'nombre', 40]], alumnos);
  sheet('Instituciones', [['N°', 'n', 6], ['Nombre de la I.E.', 'ie', 38], ['Tipo', 'tipo', 10], ['Director', 'director', 30], ['Dirección', 'dir', 36], ['Teléfono', 'tel', 12], ['Correo', 'mail', 30], ['N° alumnos', 'na', 11], ['Monto (S/)', 'monto', 11], ['Medio de pago', 'medio', 15], ['N° operación', 'operacion', 22], ['Pagó (nombre)', 'pagador', 26], ['Estado de pago', 'estado', 14], ['Fecha de registro', 'fecha', 20]],
    fichas.map((f, i) => ({ n: i + 1, ie: f.ie, tipo: f.tipo, director: f.director, dir: f.dir, tel: f.tel, mail: f.mail, na: f.alumnos.length, monto: f.monto, medio: f.medio, operacion: f.operacion, pagador: f.pagador, estado: estado(f.verificado), fecha: f.fecha })));
  sheet('Asesores', [['I.E.', 'ie', 38], ['Nivel', 'nivel', 12], ['Apellidos y nombres del asesor', 'nombre', 38], ['Teléfono', 'tel', 12]], asesores);
  sheet('Alumnos libres', [['N°', 'n', 6], ['DNI', 'dni', 12], ['Grado', 'grado', 18], ['Aula', 'aula', 14], ['Categoría', 'categoria', 44], ['Nivel', 'nivel', 12], ['Apellidos y nombres', 'nombre', 40],['Celular / WhatsApp', 'tel', 16],['Monto (S/)', 'monto', 11], ['Medio de pago', 'medio', 15], ['N° operación', 'operacion', 22], ['Pagó (nombre)', 'pagador', 26], ['Estado de pago', 'estado', 14], ['Fecha de registro', 'fecha', 20]],
    libres.map((r, i) => ({ n: i + 1, ...r, estado: estado(r.verificado) })));
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': 'attachment; filename="inscritos-xi-concurso-matematica-lima-este-2026.xlsx"',
    'Cache-Control': 'no-store',
  });
  await wb.xlsx.write(res);
  res.end();
}));

/* ------------------------------ Estáticos y errores ------------------------------ */
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use('/api', (_req, res) => res.status(404).json({ error: 'No encontrado' }));

function wrap(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Solicitud no válida.' });
  console.error(err);
  res.status(500).json({ error: 'Error del servidor. Inténtalo de nuevo en un momento.' });
});

(async () => {
  await pool.query(SCHEMA);
  app.listen(PORT, '0.0.0.0', () => console.log(`Concurso Tarpuy escuchando en :${PORT}`));
})().catch(e => { console.error('No se pudo iniciar:', e.message); process.exit(1); });
