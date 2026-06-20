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

async function fetchAllPages(url, headers) {
  let results = [];
  let nextUrl = url;
  let pages = 0;
  
  while (nextUrl && pages < 5) {
    const res = await fetch(nextUrl, { headers });
    const data = await res.json();
    if (data.results) results = results.concat(data.results);
    nextUrl = data.next || null;
    pages++;
  }
  return results;
}

function getTodayString() {
  const now = new Date();
  return now.toISOString().split('T')[0];
}

async function getKoiboxData(local, question) {
  const key = KOIBOX_KEYS[local];
  if (!key) return { error: 'No hay key para este local' };

  const headers = { 'X-Koibox-Key': key, 'Accept': 'application/json' };
  const today = getTodayString();

  try {
    // Detectar si pregunta por una fecha específica
    const fechaMatch = question.match(/(\d{1,2})[\/\-\s](\d{1,2})/);
    let fechaFiltro = today;
    
    if (fechaMatch) {
      const dia = fechaMatch[1].padStart(2, '0');
      const mes = fechaMatch[2].padStart(2, '0');
      const año = new Date().getFullYear();
      fechaFiltro = `${año}-${mes}-${dia}`;
    } else if (question.toLowerCase().includes('hoy')) {
      fechaFiltro = today;
    } else if (question.toLowerCase().includes('mañana')) {
      const manana = new Date();
      manana.setDate(manana.getDate() + 1);
      fechaFiltro = manana.toISOString().split('T')[0];
    }

    console.log('Fecha filtro:', fechaFiltro);

    // Agenda filtrada por fecha
    const agendaUrl = `https://api.koibox.cloud/api/agenda/?fecha__gte=${fechaFiltro}&fecha__lte=${fechaFiltro}&page_size=200`;
    const agendaHoy = await fetchAllPages(agendaUrl, headers);

    // Agenda del mes actual
    const primerDiaMes = today.substring(0, 7) + '-01';
    const agendaMesUrl = `https://api.koibox.cloud/api/agenda/?fecha__gte=${primerDiaMes}&fecha__lte=${today}&page_size=200`;
    const agendaMes = await fetchAllPages(agendaMesUrl, headers);

    // Clientes
    const clientes = await fetchAllPages('https://api.koibox.cloud/api/clientes/?page_size=100', headers);

    return { 
      fecha_consultada: fechaFiltro,
      fecha_hoy: today,
      citas_fecha: agendaHoy,
      total_citas_fecha: agendaHoy.length,
      citas_mes: agendaMes,
      total_citas_mes: agendaMes.length,
      clientes_total: clientes.length,
    };
  } catch (e) {
    console.error('Error Koibox:', e.message);
    return { error: e.message };
  }
}

async function callAnthropic(question, local, koiboxData) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Eres el asistente de negocio de LeBarbier ${local} en Sevilla.
Hoy es ${koiboxData.fecha_hoy}.

Datos reales de Koibox:
- Fecha consultada: ${koiboxData.fecha_consultada}
- Citas en esa fecha: ${koiboxData.total_citas_fecha}
- Detalle citas del día: ${JSON.stringify(koiboxData.citas_fecha?.slice(0, 50))}
- Total citas este mes: ${koiboxData.total_citas_mes}
- Barberos este mes: ${JSON.stringify(
  Object.entries(
    (koiboxData.citas_mes || []).reduce((acc, c) => {
      const barbero = c.usuario_nombre || c.empleado_nombre || 'Sin asignar';
      acc[barbero] = (acc[barbero] || 0) + 1;
      return acc;
    }, {})
  ).sort((a, b) => b[1] - a[1])
)}
- Total clientes: ${koiboxData.clientes_total}

Responde en español de forma específica y clara.
Usa tablas cuando compares barberos.
Destaca en negrita los datos más importantes.
Máximo 200 palabras.

Pregunta: ${question}`
      }]
    })
  });

  const data = await response.json();
  if (data.error) throw new Error('Anthropic: ' + data.error.message);
  return data.content[0].text;
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
  const contentTypes = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png',
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'index.html'), (err2, data2) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
  console.log('ANTHROPIC_KEY:', !!ANTHROPIC_KEY);
  console.log('KOIBOX keys:', Object.keys(KOIBOX_KEYS).map(k => k + ': ' + (KOIBOX_KEYS[k] ? 'OK' : 'FALTA')));
});
