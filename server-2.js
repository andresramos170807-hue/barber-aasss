const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const KOIBOX_KEYS = {
  'Sevilla Este': process.env.KOIBOX_KEY_LB_SEVILLA_ESTE,
  'Bormujos': process.env.KOIBOX_KEY_LB_BORMUJOS,
  'Ginés': process.env.KOIBOX_KEY_LB_GINES,
};

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

async function getKoiboxData(local) {
  const key = KOIBOX_KEYS[local];
  if (!key) return { error: 'No hay key para este local' };

  try {
    const [citas, clientes, caja] = await Promise.all([
      fetch('https://koibox.cloud/api/citas/', {
        headers: { 'X-Koibox-Key': key }
      }).then(r => r.json()),
      fetch('https://koibox.cloud/api/clientes/', {
        headers: { 'X-Koibox-Key': key }
      }).then(r => r.json()),
      fetch('https://koibox.cloud/api/caja/', {
        headers: { 'X-Koibox-Key': key }
      }).then(r => r.json()),
    ]);

    return { citas, clientes, caja };
  } catch (e) {
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
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Eres el asistente de negocio de LeBarbier ${local} en Sevilla.

Datos reales de Koibox:
${JSON.stringify(koiboxData, null, 2)}

Responde en español, directo y claro. Usa negrita para datos importantes. Máximo 120 palabras.

Pregunta: ${question}`
      }]
    })
  });
  const data = await response.json();
  return data.content[0].text;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/query') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { question, local } = JSON.parse(body);
        const koiboxData = await getKoiboxData(local);
        const response = await callAnthropic(question, local, koiboxData);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Servir archivos estáticos
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const contentTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
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
});
