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

async function fetchAllPages(url, headers, maxPages = 10) {
  let results = [];
  let nextUrl = url;
  let pages = 0;
  while (nextUrl && pages < maxPages) {
    try {
      const res = await fetch(nextUrl, { headers });
      if (!res.ok) break;
      const data = await res.json();
      if (data.results) results = results.concat(data.results);
      else if (Array.isArray(data)) results = results.concat(data);
      nextUrl = data.next || null;
      pages++;
    } catch(e) { break; }
  }
  return results;
}

function getDateRange() {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const firstDay = `${year}-${month}-01`;
  // Último día del mes
  const lastDay = new Date(year, now.getMonth() + 1, 0).toISOString().split('T')[0];
  return { today, firstDay, lastDay, year, month };
}

function detectDate(question) {
  const { today } = getDateRange();
  const now = new Date();
  
  if (question.toLowerCase().includes('mañana')) {
    const manana = new Date();
    manana.setDate(manana.getDate() + 1);
    return manana.toISOString().split('T')[0];
  }
  
  // Detectar "día X" o "el X" o "lunes X" etc
  const match = question.match(/\b(\d{1,2})[\/\-](\d{1,2})\b/);
  if (match) {
    const dia = match[1].padStart(2, '0');
    const mes = match[2].padStart(2, '0');
    return `${now.getFullYear()}-${mes}-${dia}`;
  }
  
  // Detectar solo día "el 23" "día 23"
  const diaMatch = question.match(/\b(el|día|dia)\s+(\d{1,2})\b/i);
  if (diaMatch) {
    const dia = diaMatch[2].padStart(2, '0');
    const mes = String(now.getMonth() + 1).padStart(2, '0');
    return `${now.getFullYear()}-${mes}-${dia}`;
  }
  
  return today;
}

async function getKoiboxData(local, question) {
  const key = KOIBOX_KEYS[local];
  if (!key) return { error: 'No hay key para este local' };

  const headers = { 'X-Koibox-Key': key, 'Accept': 'application/json' };
  const { today, firstDay, lastDay, year, month } = getDateRange();
  const fechaEspecifica = detectDate(question);

  console.log('Obteniendo datos de Koibox para:', local);
  console.log('Fecha específica detectada:', fechaEspecifica);

  try {
    const [
      citasDia,
      citasMes,
      clientes,
      cajaEntradas,
    ] = await Promise.all([
      // Citas del día específico
      fetchAllPages(
        `https://api.koibox.cloud/api/agenda/?fecha__gte=${fechaEspecifica}&fecha__lte=${fechaEspecifica}&page_size=200`,
        headers
      ),
      // Citas del mes completo
      fetchAllPages(
        `https://api.koibox.cloud/api/agenda/?fecha__gte=${firstDay}&fecha__lte=${lastDay}&page_size=200`,
        headers, 20
      ),
      // Clientes
      fetchAllPages(
        `https://api.koibox.cloud/api/clientes/?page_size=200`,
        headers, 5
      ),
      // Caja del mes
      fetchAllPages(
        `https://api.koibox.cloud/api/ventas/?fecha__gte=${firstDay}&fecha__lte=${lastDay}&page_size=200`,
        headers, 10
      ).catch(() => []),
    ]);

    // Análisis de barberos del mes
    const barberosMes = citasMes.reduce((acc, cita) => {
      const nombre = (cita.user && (cita.user.first_name || cita.user.username || cita.user.nombre)) || cita.usuario_nombre || cita.empleado_nombre || cita.user_nombre || 'Sin asignar';
      if (!acc[nombre]) acc[nombre] = { citas: 0, ingresos: 0, servicios: [] };
      acc[nombre].citas++;
      if (cita.precio) acc[nombre].ingresos += parseFloat(cita.precio) || 0;
      if (cita.servicio_nombre) acc[nombre].servicios.push(cita.servicio_nombre);
      return acc;
    }, {});

    const barberosRanking = Object.entries(barberosMes)
      .map(([nombre, data]) => ({
        nombre,
        citas: data.citas,
        ingresos: Math.round(data.ingresos * 100) / 100,
        ticket_medio: data.citas > 0 ? Math.round((data.ingresos / data.citas) * 100) / 100 : 0
      }))
      .sort((a, b) => b.ingresos - a.ingresos);

    // Análisis por día del mes
    const citasPorDia = citasMes.reduce((acc, cita) => {
      const fecha = cita.fecha || cita.date || 'Sin fecha';
      if (!acc[fecha]) acc[fecha] = { citas: 0, ingresos: 0 };
      acc[fecha].citas++;
      if (cita.precio) acc[fecha].ingresos += parseFloat(cita.precio) || 0;
      return acc;
    }, {});

    // Facturación de caja
    const facturacionCaja = cajaEntradas.reduce((acc, entrada) => {
      return acc + (parseFloat(entrada.total) || parseFloat(entrada.total_con_iva) || parseFloat(entrada.importe) || 0);
    }, 0);

    // Previsión: proyección basada en días transcurridos
    const diaActual = new Date().getDate();
    const diasEnMes = new Date(parseInt(year), parseInt(month), 0).getDate();
    const prevision = diaActual > 0 ? Math.round((facturacionCaja / diaActual) * diasEnMes * 100) / 100 : 0;

    return {
      fecha_hoy: today,
      fecha_consultada: fechaEspecifica,
      mes_actual: `${year}-${month}`,
      // Citas del día
      citas_dia: citasDia,
      total_citas_dia: citasDia.length,
      // Citas del mes
      total_citas_mes: citasMes.length,
      // Barberos
      barberos_ranking: barberosRanking,
      // Por día
      citas_por_dia: citasPorDia,
      // Clientes
      total_clientes: clientes.length,
      clientes_muestra: clientes.slice(0, 20),
      // Facturación
      facturacion_caja_mes: Math.round(facturacionCaja * 100) / 100,
      prevision_mes: prevision,
      dias_transcurridos: diaActual,
      dias_totales_mes: diasEnMes,
    };

  } catch (e) {
    console.error('Error Koibox:', e.message);
    return { error: e.message };
  }
}

async function callAnthropic(question, local, data) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `Eres el asistente de negocio de LeBarbier ${local} en Sevilla. Hoy es ${data.fecha_hoy}.

DATOS REALES DE KOIBOX:

📅 FECHA CONSULTADA: ${data.fecha_consultada}
- Citas ese día: ${data.total_citas_dia}
- Detalle: ${JSON.stringify(data.citas_dia?.slice(0, 30))}

📊 MES ACTUAL (${data.mes_actual}):
- Total citas: ${data.total_citas_mes}
- Días transcurridos: ${data.dias_transcurridos} de ${data.dias_totales_mes}
- Facturación caja: ${data.facturacion_caja_mes}€
- Previsión fin de mes: ${data.prevision_mes}€

✂️ RANKING BARBEROS (mes completo):
${JSON.stringify(data.barberos_ranking)}

📅 CITAS POR DÍA:
${JSON.stringify(data.citas_por_dia)}

👥 CLIENTES:
- Total clientes registrados: ${data.total_clientes}
- Muestra: ${JSON.stringify(data.clientes_muestra?.map(c => ({ nombre: (c.nombre || '') + ' ' + (c.apellidos || ''), telefono: c.telefono })))}

Responde en español de forma clara y específica. 
Usa tablas markdown cuando compares datos.
Destaca en **negrita** los datos clave.
Si preguntan por análisis mensual de barberos, muestra ranking completo con citas, ingresos y ticket medio.
Si preguntan por un día específico, muestra las citas de ese día.
Máximo 300 palabras.

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

  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
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
