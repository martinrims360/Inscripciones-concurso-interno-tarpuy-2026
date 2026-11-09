'use strict';

require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');
const rateLimit = require('express-rate-limit');
const ExcelJS = require('exceljs');

// ==========================================
// CONFIGURACIÓN
// ==========================================

const { DATABASE_URL, ADMIN_PASSWORD, SESSION_SECRET } = process.env;

if (!DATABASE_URL || !ADMIN_PASSWORD || !SESSION_SECRET) {
  console.error(
    'Faltan variables de entorno: DATABASE_URL, ADMIN_PASSWORD y SESSION_SECRET son obligatorias.'
  );
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 8080;
const PRECIO_INSCRIPCION = 10;
const IS_PROD = process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
  console.error('Error inesperado en PostgreSQL:', err.message);
});

const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '200kb' }));

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// ==========================================
// LIMITACIÓN DE SOLICITUDES
// ==========================================

const writeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Demasiados envíos. Espera unos minutos e inténtalo otra vez.'
  }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Demasiados intentos. Espera 15 minutos.'
  }
});

// ==========================================
// UTILIDADES
// ==========================================

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (message) => new HttpError(400, message);

const clean = (value, max = 160) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

function wrap(fn) {
  return (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);
}

// ==========================================
// DATOS DEL FORMULARIO
// ==========================================

const GRADOS = [
  { n: 'Inicial · 3 años', v: 'Inicial' },
  { n: 'Inicial · 4 años', v: 'Inicial' },
  { n: 'Inicial · 5 años', v: 'Inicial' },

  ...[1, 2, 3, 4, 5, 6].map((i) => ({
    n: `${i}° de Primaria`,
    v: 'Primaria'
  })),

  ...[1, 2, 3, 4, 5].map((i) => ({
    n: `${i}° de Secundaria`,
    v: 'Secundaria'
  }))
];

const GRADO_NIVEL = Object.fromEntries(
  GRADOS.map((g) => [g.n, g.v])
);

const AULAS = [
  'Regular',
  'C2',
  'C3',
  'C4',
  'BASICO',
  'INTERMEDIO',
  'AVANZADO'
];

const CATEGORIAS = [
  'CATEGORÍA “A” : GOTTFRIED LEIBNIZ (Alumnos regulares)',
  'CATEGORÍA “B” : FRIEDRICH GAUSS (Alumnos de círculo)'
];

// ==========================================
// VALIDACIÓN DE PAGOS
// ==========================================

function parseOperaciones(value) {
  const operations = clean(value, 120)
    .split(/[,;\s]+/)
    .filter(Boolean);

  if (
    !operations.length ||
    operations.length > 6 ||
    !operations.every((item) => /^[A-Za-z0-9-]{4,20}$/.test(item))
  ) {
    throw bad(
      'El N° de operación no es válido. Usa letras y números de 4 a 20 caracteres.'
    );
  }

  return operations.join(', ');
}

function parseMedio(value) {
  if (!['Yape', 'Transferencia', 'Efectivo'].includes(value)) {
    throw bad('Elige un medio de pago válido.');
  }

  return value;
}

// ==========================================
// BASE DE DATOS
// ==========================================

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS libres (
    id SERIAL PRIMARY KEY,
    dni TEXT NOT NULL UNIQUE,
    grado TEXT NOT NULL,
    nivel TEXT NOT NULL,
    nombre TEXT NOT NULL,
    telefono TEXT,
    aula TEXT,
    categoria TEXT,
    monto INTEGER NOT NULL DEFAULT 10,
    operacion TEXT NOT NULL DEFAULT '',
    medio TEXT NOT NULL DEFAULT 'Yape',
    pagador TEXT,
    verificado BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  ALTER TABLE libres ADD COLUMN IF NOT EXISTS telefono TEXT;
  ALTER TABLE libres ADD COLUMN IF NOT EXISTS aula TEXT;
  ALTER TABLE libres ADD COLUMN IF NOT EXISTS categoria TEXT;
  ALTER TABLE libres ADD COLUMN IF NOT EXISTS pagador TEXT;

  ALTER TABLE libres
    ADD COLUMN IF NOT EXISTS verificado BOOLEAN NOT NULL DEFAULT FALSE;

  ALTER TABLE libres
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

  ALTER TABLE libres
    ADD COLUMN IF NOT EXISTS monto INTEGER NOT NULL DEFAULT 10;

  ALTER TABLE libres
    ADD COLUMN IF NOT EXISTS operacion TEXT NOT NULL DEFAULT '';

  ALTER TABLE libres
    ADD COLUMN IF NOT EXISTS medio TEXT NOT NULL DEFAULT 'Yape';

  ALTER TABLE libres DROP CONSTRAINT IF EXISTS libres_medio_check;

  ALTER TABLE libres
    ADD CONSTRAINT libres_medio_check
    CHECK (medio IN ('Yape', 'Transferencia', 'Efectivo'));

  CREATE INDEX IF NOT EXISTS idx_libres_created_at
    ON libres(created_at);
`;

// ==========================================
// RUTA DE SALUD DEL SERVIDOR
// ==========================================

app.get('/healthz', wrap(async (_req, res) => {
  await pool.query('SELECT 1');

  res.json({
    ok: true
  });
}));

// ==========================================
// REGISTRO DE ALUMNOS
// ==========================================

app.post('/api/libres', writeLimiter, wrap(async (req, res) => {
  const body = req.body || {};

  const dni = clean(body.dni, 14);
  const grado = clean(body.grado, 40);
  const nivel = GRADO_NIVEL[grado];

  const nombre = clean(body.nombre, 120);
  const telefono = clean(body.tel, 20);
  const aula = clean(body.aula, 20);
  const categoria = clean(body.categoria, 120);
  const pagador = clean(body.pagador, 120);

  // Validaciones

  if (!/^\d{8}$/.test(dni)) {
    throw bad('El DNI debe tener 8 dígitos.');
  }

  if (!nivel) {
    throw bad('Elige un grado válido.');
  }

  if (!nombre) {
    throw bad('Escribe los apellidos y nombres del alumno.');
  }

  if (!/^9\d{8}$/.test(telefono)) {
    throw bad('El celular debe tener 9 dígitos y empezar con 9.');
  }

  if (!AULAS.includes(aula)) {
    throw bad('Elige un aula válida.');
  }

  if (!CATEGORIAS.includes(categoria)) {
    throw bad('Elige una categoría válida.');
  }

  const medio = parseMedio(body.medio);

  if (!pagador) {
    throw bad('Escribe el nombre de quien hizo el pago.');
  }

  const operacion =
    medio === 'Efectivo'
      ? ''
      : parseOperaciones(body.operacion);

  try {
    const result = await pool.query(
      `INSERT INTO libres
        (
          dni,
          grado,
          nivel,
          nombre,
          telefono,
          aula,
          categoria,
          monto,
          operacion,
          medio,
          pagador
        )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        dni,
        grado,
        nivel,
        nombre,
        telefono,
        aula,
        categoria,
        PRECIO_INSCRIPCION,
        operacion,
        medio,
        pagador
      ]
    );

    res.status(201).json({
      ok: true,
      id: result.rows[0].id,
      monto: PRECIO_INSCRIPCION
    });

  } catch (err) {
    if (err.code === '23505') {
      throw new HttpError(
        409,
        `El DNI ${dni} ya tiene una inscripción registrada.`
      );
    }

    throw err;
  }
}));

// ==========================================
// AUTENTICACIÓN DEL ADMINISTRADOR
// ==========================================

const sign = (value) =>
  crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(value)
    .digest('hex');

function safeEqual(a, b) {
  const left = crypto
    .createHash('sha256')
    .update(String(a ?? ''))
    .digest();

  const right = crypto
    .createHash('sha256')
    .update(String(b ?? ''))
    .digest();

  return crypto.timingSafeEqual(left, right);
}

function getCookies(req) {
  const cookies = {};

  for (const part of (req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');

    if (index > 0) {
      cookies[part.slice(0, index).trim()] =
        decodeURIComponent(part.slice(index + 1).trim());
    }
  }

  return cookies;
}

function isAdmin(req) {
  const token = getCookies(req).adm;

  if (!token) return false;

  const [expires, signature] = token.split('.');

  if (!expires || !signature || !Number.isFinite(Number(expires))) {
    return false;
  }

  if (Number(expires) < Date.now()) {
    return false;
  }

  return safeEqual(signature, sign(expires));
}

function needAdmin(req, res, next) {
  if (isAdmin(req)) {
    return next();
  }

  return res.status(401).json({
    error: 'No autorizado.'
  });
}

// LOGIN

app.post('/api/admin/login', loginLimiter, (req, res) => {
  if (!safeEqual(req.body && req.body.password, ADMIN_PASSWORD)) {
    return res.status(401).json({
      error: 'Contraseña incorrecta.'
    });
  }

  const expires = String(
    Date.now() + 12 * 60 * 60 * 1000
  );

  res.setHeader(
    'Set-Cookie',
    `adm=${expires}.${sign(expires)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${IS_PROD ? '; Secure' : ''}`
  );

  return res.json({
    ok: true
  });
});

// LOGOUT

app.post('/api/admin/logout', (_req, res) => {
  res.setHeader(
    'Set-Cookie',
    `adm=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${IS_PROD ? '; Secure' : ''}`
  );

  res.json({
    ok: true
  });
});

// ==========================================
// OBTENER INSCRIPCIONES
// ==========================================

async function loadInscripciones() {
  const result = await pool.query(
    `SELECT
       id,
       dni,
       grado,
       nivel,
       nombre,
       aula,
       categoria,
       telefono,
       monto,
       operacion,
       medio,
       pagador,
       verificado,
       created_at
     FROM libres
     ORDER BY created_at DESC, id DESC`
  );

  return result.rows.map((row) => ({
    _id: row.id,
    dni: row.dni,
    grado: row.grado,
    nivel: row.nivel,
    nombre: row.nombre,
    aula: row.aula || '',
    categoria: row.categoria || '',
    tel: row.telefono || '',
    monto: Number(row.monto) || 0,
    operacion: row.operacion || '',
    medio: row.medio || 'Yape',
    pagador: row.pagador || '',
    verificado: Boolean(row.verificado),
    fecha: row.created_at
  }));
}

// ==========================================
// DATOS DEL PANEL ADMINISTRATIVO
// ==========================================

app.get('/api/admin/data', needAdmin, wrap(async (_req, res) => {
  res.set('Cache-Control', 'no-store');

  const libres = await loadInscripciones();

  res.json({
    fichas: [],
    libres
  });
}));

// ==========================================
// VERIFICACIÓN DE PAGOS
// ==========================================

app.patch('/api/admin/verify', needAdmin, wrap(async (req, res) => {
  const { t, id, v } = req.body || {};

  if (
    t !== 'libres' ||
    !Number.isInteger(id) ||
    id <= 0 ||
    typeof v !== 'boolean'
  ) {
    throw bad('Datos de verificación no válidos.');
  }

  const result = await pool.query(
    `UPDATE libres
     SET verificado = $1
     WHERE id = $2
     RETURNING id`,
    [v, id]
  );

  if (!result.rowCount) {
    throw new HttpError(404, 'No se encontró la inscripción.');
  }

  res.json({
    ok: true
  });
}));

// ==========================================
// EXPORTACIÓN A EXCEL
// ==========================================

app.get('/api/admin/export.xlsx', needAdmin, wrap(async (_req, res) => {
  const inscripciones = await loadInscripciones();

  const workbook = new ExcelJS.Workbook();

  workbook.creator = 'Tarpuy - VIII Olimpiada Tarpuyana 2026';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Inscripciones', {
    views: [{ state: 'frozen', ySplit: 1 }]
  });

  sheet.columns = [
    { header: 'N°', key: 'numero', width: 7 },
    { header: 'DNI', key: 'dni', width: 14 },
    { header: 'Grado', key: 'grado', width: 20 },
    { header: 'Nivel', key: 'nivel', width: 15 },
    { header: 'Aula', key: 'aula', width: 16 },
    { header: 'Categoría', key: 'categoria', width: 48 },
    { header: 'Apellidos y nombres', key: 'nombre', width: 38 },
    { header: 'Celular / WhatsApp', key: 'tel', width: 20 },
    { header: 'Monto (S/)', key: 'monto', width: 13 },
    { header: 'Medio de pago', key: 'medio', width: 18 },
    { header: 'N° de operación', key: 'operacion', width: 24 },
    { header: 'Nombre de quien pagó', key: 'pagador', width: 30 },
    { header: 'Estado de pago', key: 'estado', width: 18 },
    { header: 'Fecha de inscripción', key: 'fecha', width: 24 }
  ];

  inscripciones.forEach((row, index) => {
    sheet.addRow({
      numero: index + 1,
      ...row,
      estado: row.verificado ? 'Verificado' : 'Pendiente',
      fecha: row.fecha
        ? new Date(row.fecha).toLocaleString('es-PE')
        : ''
    });
  });

  const header = sheet.getRow(1);

  header.font = {
    bold: true,
    color: { argb: 'FFFFFFFF' }
  };

  header.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF14532D' }
  };

  header.alignment = {
    vertical: 'middle',
    wrapText: true
  };

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: sheet.columns.length }
  };

  res.set({
    'Content-Type':
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',

    'Content-Disposition':
      'attachment; filename="inscripciones-olimpiada-tarpuyana-2026.xlsx"',

    'Cache-Control': 'no-store'
  });

  await workbook.xlsx.write(res);
  res.end();
}));

// ==========================================
// ARCHIVOS ESTÁTICOS
// ==========================================

app.use(
  express.static(
    path.join(__dirname, 'public'),
    { maxAge: '1h' }
  )
);

app.use('/api', (_req, res) => {
  res.status(404).json({
    error: 'Ruta API no encontrada.'
  });
});

// ==========================================
// MANEJO DE ERRORES
// ==========================================

app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: err.message
    });
  }

  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: 'El contenido enviado no es un JSON válido.'
    });
  }

  console.error('Error del servidor:', err);

  return res.status(500).json({
    error: 'Error del servidor. Inténtalo de nuevo en un momento.'
  });
});

// ==========================================
// INICIAR SERVIDOR
// ==========================================

(async () => {
  await pool.query(SCHEMA);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `VIII Olimpiada Tarpuyana escuchando en el puerto ${PORT}`
    );
  });
})().catch((err) => {
  console.error('No se pudo iniciar el servidor:', err);
  process.exit(1);
});
