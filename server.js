const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const KOIBOX_KEYS = {
  'Sevilla Este': process.env.KOIBOX_KEY_LB_SEVILLA_ESTE,
  'Bormujos': process.env.KOIBOX_KEY_LB_BORMUJOS,
  'Gines': process.env.KOIBOX_KEY_LB_GINES,
};

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// ---------- CACHE (para que la app vaya rapida) ----------
const CACHE = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutos
const ULTIMO_BUENO = new Map(); // copia de seguridad: ultimos datos completos

function cacheGet(clave) {
  const item = CACHE.get(clave);
  if (!item) return null;
  if (Date.now() - item.time > CACHE_TTL) { CACHE.delete(clave); return null; }
  return item.data;
}
function cacheSet(clave, data) {
  CACHE.set(clave, { data, time: Date.now() });
}

// ---------- OBJETIVOS (OKR) ----------
function leerObjetivos() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'objetivos.json'), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { objetivos: {} };
  }
}


// ---------- CONTROL DE VELOCIDAD (Koibox nos limita: error 429) ----------
const MS_ENTRE_PETICIONES = 400;
let ultimaPeticion = 0;
let colaKoibox = Promise.resolve();

function espera(ms) { return new Promise(r => setTimeout(r, ms)); }

// Todas las llamadas a Koibox pasan por aqui, de una en una y espaciadas
function koiboxFetch(url, headers) {
  colaKoibox = colaKoibox.then(async () => {
    const desde = Date.now() - ultimaPeticion;
    if (desde < MS_ENTRE_PETICIONES) await espera(MS_ENTRE_PETICIONES - desde);
    ultimaPeticion = Date.now();
    return fetch(url, { headers });
  });
  return colaKoibox;
}

// ---------- KOIBOX ----------
async function fetchAllPages(url, headers, maxPages = 60) {
  let results = [];
  let nextUrl = url;
  let pages = 0;
  let count = null;
  let completo = true;

  while (nextUrl && pages < maxPages) {
    let data = null;
    const esperas429 = [3000, 8000, 20000];

    for (let intento = 0; intento < 4; intento++) {
      try {
        const res = await koiboxFetch(nextUrl, headers);
        if (res.status === 429) {
          const w = esperas429[Math.min(intento, esperas429.length - 1)];
          console.log('Koibox 429 (limite). Esperando', w, 'ms');
          await espera(w);
          continue;
        }
        if (res.status >= 500) { await espera(2000); continue; }
        if (!res.ok) { console.log('Koibox error', res.status, nextUrl); break; }
        data = await res.json();
        break;
      } catch (e) {
        await espera(1000 * (intento + 1));
      }
    }

    if (!data) { completo = false; break; }

    if (count === null && data.count !== undefined) count = data.count;
    if (data.results) results = results.concat(data.results);
    else if (Array.isArray(data)) results = results.concat(data);
    nextUrl = data.next || null;
    pages++;
  }

  if (nextUrl) completo = false;
  return { results, count: count !== null ? count : results.length, completo };
}

function getDateRange() {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const firstDay = `${year}-${month}-01`;
  const daysInMonth = new Date(year, now.getMonth() + 1, 0).getDate();
  const lastDay = `${year}-${month}-${String(daysInMonth).padStart(2, '0')}`;
  return { today, firstDay, lastDay, year, month, day: now.getDate(), daysInMonth };
}

function detectDate(question) {
  const { today } = getDateRange();
  const now = new Date();
  const q = (question || '').toLowerCase();
  if (q.includes('mañana')) {
    const m = new Date(); m.setDate(m.getDate() + 1);
    return m.toISOString().split('T')[0];
  }
  const match = q.match(/\b(\d{1,2})[\/\-](\d{1,2})\b/);
  if (match) return `${now.getFullYear()}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  const diaMatch = q.match(/\b(el|día|dia)\s+(\d{1,2})\b/);
  if (diaMatch) return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${diaMatch[2].padStart(2, '0')}`;
  return today;
}

function nombreBarbero(cita) {
  if (cita.user && typeof cita.user === 'object') {
    return cita.user.first_name || cita.user.username || cita.user.nombre || 'Sin asignar';
  }
  return cita.usuario_nombre || cita.empleado_nombre || 'Sin asignar';
}

function importeVenta(v) {
  return parseFloat(v.total) || parseFloat(v.total_con_iva) || parseFloat(v.importe) || 0;
}

async function getDatosLocal(local, fechaEspecifica) {
  const key = KOIBOX_KEYS[local];
  if (!key) return null;

  const cacheKey = `${local}|${fechaEspecifica}`;
  const cached = cacheGet(cacheKey);
  if (cached) { console.log('CACHE HIT', cacheKey); return cached; }

  const headers = { 'X-Koibox-Key': key, 'Accept': 'application/json' };
  const { today, firstDay, lastDay, day, daysInMonth } = getDateRange();

  const [citasMesData, citasDiaData, ventasData, clientesData] = await Promise.all([
    fetchAllPages(`https://api.koibox.cloud/api/agenda/?fecha__gte=${firstDay}&fecha__lte=${lastDay}&limit=200`, headers, 120),
    fetchAllPages(`https://api.koibox.cloud/api/agenda/?fecha__gte=${fechaEspecifica}&fecha__lte=${fechaEspecifica}&limit=200`, headers, 10),
    fetchAllPages(`https://api.koibox.cloud/api/ventas/?fecha__gte=${firstDay}&fecha__lte=${lastDay}&limit=200`, headers, 120),
    fetchAllPages(`https://api.koibox.cloud/api/clientes/?limit=1`, headers, 1),
  ]);

  const citasMes = citasMesData.results;
  const ventas = ventasData.results;

  console.log(`[${local}] ventas ${ventas.length}/${ventasData.count} (completo:${ventasData.completo}) | citas ${citasMes.length}/${citasMesData.count} (completo:${citasMesData.completo}) | facturacion pendiente de calcular`);

  let facturacion = 0;
  ventas.forEach(v => { facturacion += importeVenta(v); });
  facturacion = Math.round(facturacion * 100) / 100;

  const barberosMap = {};
  citasMes.forEach(c => {
    const n = nombreBarbero(c);
    barberosMap[n] = (barberosMap[n] || 0) + 1;
  });
  const barberos_ranking = Object.entries(barberosMap)
    .map(([nombre, citas]) => ({ nombre, citas }))
    .sort((a, b) => b.citas - a.citas);

  const factEmp = {};
  ventas.forEach(v => {
    const emp = (v.assigned_to && (v.assigned_to.first_name || v.assigned_to.username)) || v.empleado_nombre || 'Sin asignar';
    factEmp[emp] = (factEmp[emp] || 0) + importeVenta(v);
  });
  const ranking_facturacion = Object.entries(factEmp)
    .map(([nombre, total]) => ({ nombre, facturacion: Math.round(total * 100) / 100 }))
    .sort((a, b) => b.facturacion - a.facturacion);

  const porDia = {};
  citasMes.forEach(c => {
    const f = c.fecha || 'Sin fecha';
    porDia[f] = (porDia[f] || 0) + 1;
  });

  const ticket_medio = ventasData.count > 0 ? Math.round((facturacion / ventasData.count) * 100) / 100 : 0;
  const prevision = day > 0 ? Math.round((facturacion / day) * daysInMonth) : 0;

  const datos = {
    local,
    fecha_hoy: today,
    fecha_consultada: fechaEspecifica,
    facturacion_mes: facturacion,
    total_ventas: ventasData.count,
    total_citas_mes: citasMesData.count,
    ticket_medio,
    prevision_mes: prevision,
    total_citas_dia: citasDiaData.count,
    citas_dia: citasDiaData.results.slice(0, 40).map(c => ({
      hora: c.hora_inicio || c.hora,
      cliente: c.cliente_nombre || (c.cliente && c.cliente.nombre),
      barbero: nombreBarbero(c),
      servicio: c.servicio_nombre,
    })),
    barberos_ranking,
    ranking_facturacion,
    citas_por_dia: porDia,
    total_clientes: clientesData.count,
    dias_transcurridos: day,
    dias_mes: daysInMonth,
  };

  const datosCompletos = ventasData.completo && citasMesData.completo;

  if (datosCompletos) {
    cacheSet(cacheKey, datos);
    ULTIMO_BUENO.set(local, datos);
    return datos;
  }

  // Descarga incompleta (Koibox nos ha limitado): usar la ultima copia buena antes que dar datos falsos
  console.log('AVISO: descarga incompleta en', local);
  const respaldo = ULTIMO_BUENO.get(local);
  if (respaldo) {
    console.log('Usando ultima copia buena de', local);
    return { ...respaldo, aviso: 'Koibox limito las peticiones. Datos de hace unos minutos.' };
  }
  return { ...datos, aviso: 'Koibox limito las peticiones y los datos pueden estar incompletos. Vuelve a preguntar en un minuto.' };
}

function calcularOKR(datos) {
  const cfg = leerObjetivos();
  const obj = (cfg.objetivos && cfg.objetivos[datos.local]) || null;
  if (!obj) return null;

  const pct = (real, meta) => meta > 0 ? Math.round((real / meta) * 1000) / 10 : 0;
  const ritmoEsperado = Math.round((datos.dias_transcurridos / datos.dias_mes) * 1000) / 10;

  return {
    ritmo_esperado_pct: ritmoEsperado,
    facturacion: { objetivo: obj.facturacion, real: datos.facturacion_mes, pct: pct(datos.facturacion_mes, obj.facturacion) },
    citas: { objetivo: obj.citas, real: datos.total_citas_mes, pct: pct(datos.total_citas_mes, obj.citas) },
    ticket_medio: { objetivo: obj.ticket_medio, real: datos.ticket_medio, pct: pct(datos.ticket_medio, obj.ticket_medio) },
  };
}

async function getKoiboxData(local, question) {
  const fechaEspecifica = detectDate(question);

  if (local === 'Todos') {
    const locales = ['Sevilla Este', 'Bormujos', 'Gines'];
    const todos = await Promise.all(locales.map(l => getDatosLocal(l, fechaEspecifica).catch(() => null)));
    const validos = todos.filter(Boolean);
    if (!validos.length) return { error: 'No se pudieron cargar los datos' };

    const suma = (campo) => validos.reduce((a, d) => a + (d[campo] || 0), 0);
    const facturacion = Math.round(suma('facturacion_mes') * 100) / 100;
    const ventas = suma('total_ventas');
    const base = validos[0];

    return {
      local: 'Todos',
      fecha_hoy: base.fecha_hoy,
      fecha_consultada: fechaEspecifica,
      facturacion_mes: facturacion,
      total_ventas: ventas,
      total_citas_mes: suma('total_citas_mes'),
      ticket_medio: ventas > 0 ? Math.round((facturacion / ventas) * 100) / 100 : 0,
      prevision_mes: suma('prevision_mes'),
      total_citas_dia: suma('total_citas_dia'),
      total_clientes: suma('total_clientes'),
      dias_transcurridos: base.dias_transcurridos,
      dias_mes: base.dias_mes,
      por_local: validos.map(d => ({
        local: d.local,
        facturacion: d.facturacion_mes,
        citas: d.total_citas_mes,
        ticket: d.ticket_medio,
        prevision: d.prevision_mes,
        okr: calcularOKR(d),
      })),
    };
  }

  const datos = await getDatosLocal(local, fechaEspecifica);
  if (!datos) return { error: 'No hay clave para este local' };
  datos.okr = calcularOKR(datos);
  return datos;
}

// ---------- IA ----------
async function callAnthropic(question, local, d) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: `Eres el asistente de negocio de LeBarbier ${local} (Sevilla). Hoy es ${d.fecha_hoy}.

DATOS REALES DE KOIBOX (ya calculados y correctos, usalos tal cual):
${JSON.stringify(d, null, 1)}

INSTRUCCIONES:
- Responde SIEMPRE en español, claro y concreto.
- Usa tablas markdown para comparativas y rankings.
- Destaca en **negrita** los datos clave.
- Si preguntan por OKR u objetivos: usa el campo "okr". Compara el % conseguido con "ritmo_esperado_pct" (el % del mes que ya ha pasado). Si el % conseguido es MENOR que el ritmo esperado, van por detras del objetivo; si es mayor, van por delante. Di claramente si van bien o mal y cuanto falta en euros/citas.
- Si "barberos_ranking" sale todo como "Sin asignar", avisa de que las citas en Koibox no tienen barbero asignado y usa "ranking_facturacion" en su lugar.
- Maximo 300 palabras.

PREGUNTA: ${question}`
      }]
    })
  });
  const result = await response.json();
  if (result.error) throw new Error('Anthropic: ' + result.error.message);
  return result.content[0].text;
}

// ---------- SERVIDOR ----------
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }


  // Diagnostico profundo: facturacion real calculada + estados de las citas
  if (req.method === 'GET' && req.url.startsWith('/api/debug2')) {
    const { firstDay, lastDay } = getDateRange();
    const salida = {};
    for (const [local, key] of Object.entries(KOIBOX_KEYS)) {
      if (!key) { salida[local] = { error: 'FALTA CLAVE' }; continue; }
      const headers = { 'X-Koibox-Key': key, 'Accept': 'application/json' };
      try {
        const ventasData = await fetchAllPages(`https://api.koibox.cloud/api/ventas/?fecha__gte=${firstDay}&fecha__lte=${lastDay}&limit=200`, headers, 60);
        let suma = 0;
        ventasData.results.forEach(v => { suma += importeVenta(v); });

        const citasData = await fetchAllPages(`https://api.koibox.cloud/api/agenda/?fecha__gte=${firstDay}&fecha__lte=${lastDay}&limit=200`, headers, 60);
        // Contar los estados que existen en las citas
        const estados = {};
        citasData.results.forEach(ct => {
          let e = ct.estado;
          if (e && typeof e === 'object') e = e.nombre || e.name || JSON.stringify(e);
          if (e === undefined || e === null) e = '(sin campo estado)';
          estados[e] = (estados[e] || 0) + 1;
        });
        // Campos disponibles en una cita, para saber que podemos filtrar
        const camposCita = citasData.results[0] ? Object.keys(citasData.results[0]) : [];

        salida[local] = {
          ventas_total_koibox: ventasData.count,
          ventas_descargadas: ventasData.results.length,
          descarga_completa: ventasData.completo,
          facturacion_calculada: Math.round(suma * 100) / 100,
          citas_total_koibox: citasData.count,
          citas_descargadas: citasData.results.length,
          estados_de_las_citas: estados,
          campos_de_una_cita: camposCita,
        };
      } catch (e) {
        salida[local] = { error: e.message };
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ rango: { firstDay, lastDay }, locales: salida }, null, 2));
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/debug')) {
    const { firstDay, lastDay } = getDateRange();
    const salida = {};
    for (const [local, key] of Object.entries(KOIBOX_KEYS)) {
      if (!key) { salida[local] = { error: 'FALTA LA CLAVE EN RENDER' }; continue; }
      try {
        const r = await koiboxFetch(`https://api.koibox.cloud/api/ventas/?fecha__gte=${firstDay}&fecha__lte=${lastDay}&limit=1`, { 'X-Koibox-Key': key, 'Accept': 'application/json' });
        const txt = await r.text();
        let count = null;
        try { count = JSON.parse(txt).count; } catch (e) {}
        salida[local] = {
          clave_empieza_por: key.substring(0, 6) + '...',
          http_status: r.status,
          content_type: r.headers.get('content-type'),
          ventas_count: count,
          respuesta_cruda: count === null ? txt.substring(0, 200) : 'OK (JSON)',
        };
      } catch (e) {
        salida[local] = { error: e.message };
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ rango: { firstDay, lastDay }, locales: salida }, null, 2));
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/stats')) {
    try {
      const params = new URL(req.url, 'http://x').searchParams;
      const local = params.get('local') || 'Sevilla Este';
      const d = await getKoiboxData(local, 'facturacion del mes');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        facturacion: d.facturacion_mes,
        citas: d.total_citas_mes,
        ticket: d.ticket_medio,
        prevision: d.prevision_mes,
        okr: d.okr || null,
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/query') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { question, local } = JSON.parse(body);
        console.log('Pregunta:', question, '| Local:', local);
        const datos = await getKoiboxData(local, question);
        const respuesta = await callAnthropic(question, local, datos);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response: respuesta }));
      } catch (e) {
        console.error('Error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  const ext = path.extname(filePath);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png' };
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'index.html'), (e2, d2) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(d2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Servidor en puerto ${PORT}`);
  console.log('Keys:', Object.keys(KOIBOX_KEYS).map(k => k + ':' + (KOIBOX_KEYS[k] ? 'OK' : 'FALTA')).join(' | '));
  // Precalentar la cache al arrancar para que la primera pregunta sea rapida
  // Precalentado desactivado: se carga bajo demanda para no saturar Koibox
});
