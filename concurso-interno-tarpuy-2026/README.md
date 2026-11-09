# XI Concurso Nacional de Matemática Lima Este 2026 · Inscripciones

Portal de inscripción (delegaciones y alumnos libres) con pago por Yape o transferencia,
panel del organizador con contraseña y descarga a Excel.
Stack: Node.js + Express · Postgres en Neon · hosting en Fly.io.

## 1. Neon (base de datos)
1. En https://neon.tech crea un proyecto. Región: **AWS South America (São Paulo)**.
2. En el panel del proyecto pulsa **Connect** y copia la cadena de conexión (`postgresql://...?sslmode=require`).
3. No hace falta crear tablas: el servidor las crea solo la primera vez que arranca.

## 2. Fly.io (hosting)
1. Instala `flyctl` (https://fly.io/docs/flyctl/install/) y entra: `fly auth login`
2. Abre `fly.toml` y cambia `app = "concurso-tarpuy-2026"` por un nombre único tuyo.
3. Crea la app sin desplegar todavía:
   `fly launch --no-deploy --copy-config --name TU-NOMBRE`
   (si pregunta por Postgres o Redis, responde que **no**; ya usas Neon).
4. Guarda las claves como secretos (no se suben al código):
   ```
   fly secrets set DATABASE_URL="PEGA_AQUI_LA_CADENA_DE_NEON"
   fly secrets set ADMIN_PASSWORD="TU_CONTRASEÑA_DE_ORGANIZADORA"
   fly secrets set SESSION_SECRET="$(openssl rand -hex 32)"
   ```
   (En Windows PowerShell, para SESSION_SECRET escribe una cadena larga cualquiera de 40+ caracteres.)
5. Despliega: `fly deploy`
6. Abre: `fly open` — ese es el enlace para compartir (`https://TU-NOMBRE.fly.dev`).

## 3. Usar el panel
En el pie de la página pulsa **Acceso organizador** e ingresa tu `ADMIN_PASSWORD`.
Ahí ves las inscripciones, marcas "Verificado" cuando confirmas el pago en tu Yape/BCP
y descargas el Excel (hojas: Alumnos, Instituciones, Asesores, Alumnos libres).

## 4. Dominio propio (opcional)
```
fly certs add concurso.tudominio.pe
fly certs show concurso.tudominio.pe   # te indica los registros DNS (A/AAAA o CNAME)
```
Crea esos registros en tu proveedor de dominio y espera a que el certificado quede emitido.

## 5. Probar en tu computadora (opcional)
```
npm install
cp .env.example .env   # y completa los valores
export $(cat .env | xargs) && npm start
```
Abre http://localhost:8080

## Cambios frecuentes
- **Precios**: `PRECIO_DELEGACION` y `PRECIO_LIBRE` en `fly.toml` (sección `[env]`), luego `fly deploy`.
- **Número de Yape, QR, cuenta BCP y CCI**: están en `public/index.html` (busca `const YAPE` y `const BANK`).
- **Logo y textos**: también en `public/index.html`.
- **Ver logs**: `fly logs`
- **Mantener siempre encendida**: en `fly.toml` pon `min_machines_running = 1` (evita la pequeña espera al primer visitante).

## Seguridad y datos
- El público solo puede **enviar** inscripciones; no puede leer los datos. Solo el panel con contraseña los muestra.
- El servidor calcula el monto (no el navegador) y rechaza DNI repetidos entre delegaciones y alumnos libres.
- Hay límite de envíos por conexión y de intentos de contraseña.
- Respaldos: Neon guarda historial; además descarga el Excel al cerrar las inscripciones.
- Para borrar o corregir un registro, usa el editor SQL de Neon (tabla `fichas`, `alumnos` o `libres`).
- Por tratarse de datos de menores, guarda el Excel en un lugar seguro y no lo compartas por grupos abiertos.
