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

async function fetchAllPages(url, headers, maxPages = 120) {
  let results = [];
  let nextUrl = url;
  let pages = 0;
  let count = null;
  while (nextUrl && pages < maxPages) {
    try {
      const res = await fetch(nextUrl, { headers });
      if (!res.ok) break;
      const data = await res.json();
      if (count === null && data.count !== undefined) count = data.count;
      if (data.results) results = results.concat(data.results);
      else if (Array.isArray(data)) results = results.concat(data);
      nextUrl = data.next || null;
      pages++;
    } catch(e) { break; }
  }
  return { results, count: count !== null ? count : results.length };
}

function getDateRange() {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const firstDay = `${year}-${month}-01`;
  const lastDay = new Date(year, now.getMonth() + 1, 0).toISOString().split('T')[0];
  return { today, firstDay, lastDay, year, month, day: now.getDate(), daysInMonth: new Date(year, now.getMonth()+1, 0).getDate() };
}

function detectDate(question) {
  const { today } = getDateRange();
  const now = new Date();
  if (question.toLowerCase().includes('mañana')) {
    const m = new Date(); m.setDate(m.getDate() + 1);
    return m.toISOString().split('T')[0];
  }
  const match = question.match(/\b(\d{1,2})[\/\-](\d{1,2})\b/);
  if (match) return `${now.getFullYear()}-${match[2].padStart(2,'0')}-${match[1].padStart(2,'0')}`;
  const diaMatch = question.match(/\b(el|día|dia)\s+(\d{1,2})\b/i);
  if (diaMatch) return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${diaMatch[2].padStart(2,'0')}`;
  return today;
}

function nombreBarbero(cita) {
  if (cita.user) {
    if (typeof cita.user === 'object') {
      return cita.user.first_name || cita.user.username || cita.user.nombre || 'Sin asignar';
    }
  }
  return cita.usuario_nombre || cita.empleado_nombre || 'Sin asignar';
}

async function getKoiboxData(local, question) {
  const key = KOIBOX_KEYS[local];
  if (!key) return { error: 'No hay key para este local' };

  const headers = { 'X-Koibox-Key': key, 'Accept': 'application/json' };
  const { today, firstDay, lastDay, year, month, day, daysInMonth } = getDateRange();
  const fechaEspecifica = detectDate(question);

  try {
    // Todo en paralelo para que sea rapido
    const [citasMesData, citasDiaData, ventasData, clientesData] = await Promise.all([
      fetchAllPages(
        `https://api.koibox.cloud/api/agenda/?fecha__gte=${firstDay}&fecha__lte=${lastDay}&page_size=200`,
        headers, 120
      ),
      fetchAllPages(
        `https://api.koibox.cloud/api/agenda/?fecha__gte=${fechaEspecifica}&fecha__lte=${fechaEspecifica}&page_size=200`,
        headers, 10
      ),
      fetchAllPages(
        `https://api.koibox.cloud/api/ventas/?fecha__gte=${firstDay}&fecha__lte=${lastDay}&page_size=200`,
        headers, 120
      ),
      fetchAllPages(
        `https://api.koibox.cloud/api/clientes/?page_size=200`, headers, 2
      ),
    ]);

    const citasMes = citasMesData.results;
    const totalCitasMes = citasMesData.count;
    const ventas = ventasData.results;

    console.log('Ventas descargadas:', ventas.length, 'de', ventasData.count);
    console.log('Citas descargadas:', citasMes.length, 'de', totalCitasMes);

    // Calcular facturación total de ventas
    let facturacionTotal = 0;
    ventas.forEach(v => {
      facturacionTotal += parseFloat(v.total) || parseFloat(v.total_con_iva) || parseFloat(v.importe) || 0;
    });

    // Ranking barberos del mes (por citas)
    const barberosMap = {};
    citasMes.forEach(c => {
      const nombre = nombreBarbero(c);
      barberosMap[nombre] = (barberosMap[nombre] || 0) + 1;
    });
    const barberosRanking = Object.entries(barberosMap)
      .map(([nombre, citas]) => ({ nombre, citas }))
      .sort((a, b) => b.citas - a.citas);

    // Facturación por empleado (de ventas)
    const facturaPorEmpleado = {};
    ventas.forEach(v => {
      const emp = (v.assigned_to && (v.assigned_to.first_name || v.assigned_to.username)) || v.empleado_nombre || 'Sin asignar';
      const importe = parseFloat(v.total) || parseFloat(v.total_con_iva) || 0;
      facturaPorEmpleado[emp] = (facturaPorEmpleado[emp] || 0) + importe;
    });
    const rankingFacturacion = Object.entries(facturaPorEmpleado)
      .map(([nombre, total]) => ({ nombre, facturacion: Math.round(total*100)/100 }))
      .sort((a, b) => b.facturacion - a.facturacion);

    // Citas por día
    const porDia = {};
    citasMes.forEach(c => {
      const f = c.fecha || 'Sin fecha';
      porDia[f] = (porDia[f] || 0) + 1;
    });

    // Previsión
    const prevision = day > 0 ? Math.round((facturacionTotal / day) * daysInMonth) : 0;
    const ticketMedio = ventasData.count > 0 ? Math.round((facturacionTotal / ventasData.count)*100)/100 : 0;

    return {
      fecha_hoy: today,
      fecha_consultada: fechaEspecifica,
      total_citas_mes: totalCitasMes,
      citas_dia: citasDiaData.results,
      total_citas_dia: citasDiaData.count,
      facturacion_mes: Math.round(facturacionTotal*100)/100,
      total_ventas: ventasData.count,
      ticket_medio: ticketMedio,
      prevision_mes: prevision,
      barberos_ranking: barberosRanking,
      ranking_facturacion: rankingFacturacion,
      citas_por_dia: porDia,
      total_clientes: clientesData.count,
      dias_transcurridos: day,
      dias_mes: daysInMonth,
    };
  } catch (e) {
    console.error('Error Koibox:', e.message);
    return { error: e.message };
  }
}

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
        content: `Eres el asistente de negocio de LeBarbier ${local} en Sevilla. Hoy es ${d.fecha_hoy}.

DATOS REALES DE KOIBOX (ya calculados, son correctos):

MES ACTUAL:
- Total citas del mes: ${d.total_citas_mes}
- Facturación real del mes: ${d.facturacion_mes}€
- Total ventas registradas: ${d.total_ventas}
- Ticket medio: ${d.ticket_medio}€
- Previsión fin de mes: ${d.prevision_mes}€
- Días transcurridos: ${d.dias_transcurridos} de ${d.dias_mes}
- Total clientes registrados: ${d.total_clientes}

FECHA CONSULTADA (${d.fecha_consultada}):
- Citas ese día: ${d.total_citas_dia}
- Detalle: ${JSON.stringify(d.citas_dia?.slice(0,30).map(c => ({hora: c.hora_inicio || c.hora, cliente: c.cliente_nombre, barbero: nombreBarbero(c), servicio: c.servicio_nombre})))}

RANKING BARBEROS POR CITAS (mes):
${JSON.stringify(d.barberos_ranking)}

RANKING FACTURACIÓN POR EMPLEADO (mes):
${JSON.stringify(d.ranking_facturacion)}

CITAS POR DÍA:
${JSON.stringify(d.citas_por_dia)}

INSTRUCCIONES:
- Usa SIEMPRE estos datos reales, son correctos y ya están calculados
- Responde en español, claro y específico
- Usa tablas markdown para comparativas
- Destaca en **negrita** los datos clave
- Si el ranking de barberos muestra todo "Sin asignar", explica que las citas en Koibox no tienen barbero asignado y sugiere revisar la facturación por empleado en su lugar
- Máximo 300 palabras

PREGUNTA: ${question}`
      }]
    })
  });
  const result = await response.json();
  if (result.error) throw new Error('Anthropic: ' + result.error.message);
  return result.content[0].text;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // Endpoint para el panel superior con datos reales
  if (req.method === 'GET' && req.url.startsWith('/api/stats')) {
    const urlParams = new URL(req.url, 'http://localhost');
    const local = urlParams.searchParams.get('local') || 'Sevilla Este';
    try {
      const d = await getKoiboxData(local, 'facturacion del mes');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        facturacion: d.facturacion_mes,
        citas: d.total_citas_mes,
        ticket: d.ticket_medio,
        prevision: d.prevision_mes,
      }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/api/query') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { question, local } = JSON.parse(body);
        console.log('Pregunta:', question, '| Local:', local);
        const koiboxData = await getKoiboxData(local, question);
        const response = await callAnthropic(question, local, koiboxData);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response }));
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
  const types = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.jpeg':'image/jpeg','.jpg':'image/jpeg','.png':'image/png' };
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
  console.log(`Servidor corriendo en puerto ${PORT}`);
  console.log('Keys:', Object.keys(KOIBOX_KEYS).map(k => k + ':' + (KOIBOX_KEYS[k] ? 'OK' : 'FALTA')));
});
