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

// Koibox limita: max 100 por pagina y pocas peticiones por minuto
const LIMITE = 100;
const MS_ENTRE_PETICIONES = 1100;

// ---------- CACHE ----------
const CACHE = new Map();
const ULTIMO_BUENO = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hora

function cacheGet(k) {
  const i = CACHE.get(k);
  if (!i) return null;
  if (Date.now() - i.time > CACHE_TTL) { CACHE.delete(k); return null; }
  return i.data;
}
function cacheSet(k, d) { CACHE.set(k, { data: d, time: Date.now() }); }

// ---------- OBJETIVOS ----------
function leerObjetivos() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'objetivos.json'), 'utf8')); }
  catch (e) { return { objetivos: {} }; }
}


// ---------- CALIDAD (formularios -> Google Sheets publicado en CSV) ----------
const CSV_ESTANDARIZADA = process.env.CALIDAD_CSV_URL || '';
const CSV_PERSONAL = process.env.CALIDAD_PERSONAL_CSV_URL || '';
let calidadCache = { data: null, time: 0 };

function parseCSV(texto) {
  const filas = [];
  let campo = '', fila = [], comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (comillas) {
      if (ch === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; }
        else comillas = false;
      } else campo += ch;
    } else {
      if (ch === '"') comillas = true;
      else if (ch === ',') { fila.push(campo); campo = ''; }
      else if (ch === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = ''; }
      else if (ch !== '\r') campo += ch;
    }
  }
  if (campo || fila.length) { fila.push(campo); filas.push(fila); }
  return filas.filter(f => f.some(x => x && x.trim()));
}

function normaliza(s) {
  return (s || '').toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

// "70 / 100" -> 70   |   "8,5" -> 8.5
function nota(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(',', '.');
  const m = s.match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

// "26/02/2026 18:01:53" -> Date
function fechaES(v) {
  const m = String(v || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0));
}

function identificarLocal(txt) {
  const t = normaliza(txt);
  if (!t) return null;
  if (t.includes('sevilla')) return 'Sevilla Este';
  if (t.includes('bormujo')) return 'Bormujos';
  if (t.includes('gine')) return 'Gines';   // cubre "gines" y "gines"
  return null; // MEN PELUQUEROS y otros se ignoran
}

// Lee un CSV y devuelve la ULTIMA nota de cada local
async function leerHojaCalidad(url) {
  if (!url) return {};
  try {
    const r = await fetch(url);
    if (!r.ok) { console.log('CSV calidad HTTP', r.status); return {}; }
    const filas = parseCSV(await r.text());
    if (filas.length < 2) return {};

    const cab = filas[0].map(normaliza);
    const buscar = (...cl) => cab.findIndex(h => cl.some(k => h.includes(k)));

    const iFecha = buscar('marca temporal', 'timestamp', 'fecha');
    const iLocal = buscar('barberia', 'barberia en la', 'local', 'salon', 'centro');
    const iNota  = buscar('puntuacion', 'puntuación', 'nota', 'calidad');
    const iObs   = buscar('observacion', 'comentario');

    const porLocal = {};
    for (let i = 1; i < filas.length; i++) {
      const f = filas[i];
      const local = identificarLocal(iLocal >= 0 ? f[iLocal] : '');
      if (!local) continue;

      const n = iNota >= 0 ? nota(f[iNota]) : null;
      if (n === null) continue;

      const fch = iFecha >= 0 ? fechaES(f[iFecha]) : null;
      const anterior = porLocal[local];

      // Nos quedamos con la revision MAS RECIENTE
      if (!anterior || !anterior._t || (fch && fch > anterior._t)) {
        porLocal[local] = {
          nota: n,
          fecha: iFecha >= 0 ? f[iFecha] : '',
          observaciones: iObs >= 0 ? f[iObs] : '',
          _t: fch,
        };
      }
    }
    return porLocal;
  } catch (e) {
    console.log('Error leyendo CSV calidad:', e.message);
    return {};
  }
}

async function getCalidad() {
  if (calidadCache.data && Date.now() - calidadCache.time < 15 * 60 * 1000) return calidadCache.data;

  const [est, per] = await Promise.all([
    leerHojaCalidad(CSV_ESTANDARIZADA),
    leerHojaCalidad(CSV_PERSONAL),
  ]);

  const out = {};
  ['Sevilla Este', 'Bormujos', 'Gines'].forEach(l => {
    out[l] = {
      calidad_estandarizada: est[l] ? est[l].nota : null,
      fecha_estandarizada: est[l] ? est[l].fecha : null,
      calidad_personal: per[l] ? per[l].nota : null,
      fecha_personal: per[l] ? per[l].fecha : null,
      observaciones: (est[l] && est[l].observaciones) || (per[l] && per[l].observaciones) || '',
    };
  });

  calidadCache = { data: out, time: Date.now() };
  return out;
}


// ---------- RENTABILIDAD POR EMPLEADO ----------
const CSV_EMPLEADOS = process.env.COSTES_EMPLEADOS_CSV_URL || '';
const CSV_GASTOS = process.env.COSTES_GASTOS_CSV_URL || '';
let costesCache = { data: null, time: 0 };

// Convierte "1.400,50 EUR" o "1400.5" en numero
function importe(v) {
  if (v === undefined || v === null) return null;
  let s = String(v).replace(/[^0-9,.\-]/g, '').trim();
  if (!s) return null;
  // Si tiene punto y coma, el punto son miles: 1.400,50
  if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// Lee la hoja de EMPLEADOS: Local | Empleado | Sueldo bruto | % SS
async function leerEmpleadosCSV() {
  if (!CSV_EMPLEADOS) return null;
  try {
    const r = await fetch(CSV_EMPLEADOS);
    if (!r.ok) { console.log('CSV empleados HTTP', r.status); return null; }
    const filas = parseCSV(await r.text());
    if (filas.length < 2) return null;

    const cab = filas[0].map(normaliza);
    const buscar = (...cl) => cab.findIndex(h => cl.some(k => h.includes(k)));

    const iLocal = buscar('local', 'barberia', 'salon', 'centro');
    const iNombre = buscar('empleado', 'nombre', 'barbero', 'trabajador');
    const iSueldo = buscar('sueldo', 'salario', 'bruto', 'nomina');
    const iSS = buscar('seguridad social', 'ss', 'cotizacion');
    const iHoras = buscar('horas semana', 'horas/sem', 'jornada', 'horas contrato');
    const iAdic = buscar('horas adicionales', 'adicionales', 'horas extra', 'extras', 'complementarias');
    const iPrecioH = buscar('precio hora', 'euros hora', 'valor hora', 'coste hora', 'pago hora');

    const out = {};
    for (let i = 1; i < filas.length; i++) {
      const f = filas[i];
      const local = identificarLocal(iLocal >= 0 ? f[iLocal] : '');
      const nombre = iNombre >= 0 ? (f[iNombre] || '').trim() : '';
      if (!local || !nombre) continue;

      const sueldo = iSueldo >= 0 ? importe(f[iSueldo]) : null;
      if (sueldo === null) continue;

      let ss = iSS >= 0 ? importe(f[iSS]) : null;
      if (ss === null) ss = 32;          // por defecto 32%
      if (ss > 100) ss = (ss / sueldo) * 100;  // si han puesto euros en vez de %

      let horas = iHoras >= 0 ? importe(f[iHoras]) : null;
      if (horas === null || horas <= 0) horas = 40;   // jornada completa por defecto

      if (!out[local]) out[local] = {};
      const adic = iAdic >= 0 ? (importe(f[iAdic]) || 0) : 0;
      let precioH = iPrecioH >= 0 ? importe(f[iPrecioH]) : null;
      // Si no ponen precio, se calcula solo: sueldo / horas del mes
      if (precioH === null || precioH <= 0) {
        const horasMes = horas * 4.33;
        precioH = horasMes > 0 ? Math.round((sueldo / horasMes) * 100) / 100 : 0;
      }

      out[local][nombre] = {
        sueldo_bruto_mes: sueldo,
        porcentaje_seguridad_social: ss,
        horas_semana: horas,
        horas_adicionales_mes: adic,
        precio_hora_adicional: precioH,
      };
    }
    return out;
  } catch (e) {
    console.log('Error CSV empleados:', e.message);
    return null;
  }
}

// Lee la hoja de GASTOS: Local | Concepto | Importe
async function leerGastosCSV() {
  if (!CSV_GASTOS) return null;
  try {
    const r = await fetch(CSV_GASTOS);
    if (!r.ok) { console.log('CSV gastos HTTP', r.status); return null; }
    const filas = parseCSV(await r.text());
    if (filas.length < 2) return null;

    const cab = filas[0].map(normaliza);
    const buscar = (...cl) => cab.findIndex(h => cl.some(k => h.includes(k)));

    const iLocal = buscar('local', 'barberia', 'salon', 'centro');
    const iConcepto = buscar('concepto', 'gasto', 'descripcion', 'tipo');
    const iImporte = buscar('importe', 'cantidad', 'euros', 'coste', 'mes');

    const out = {};
    for (let i = 1; i < filas.length; i++) {
      const f = filas[i];
      const local = identificarLocal(iLocal >= 0 ? f[iLocal] : '');
      if (!local) continue;
      const imp = iImporte >= 0 ? importe(f[iImporte]) : null;
      if (imp === null) continue;
      const concepto = (iConcepto >= 0 ? f[iConcepto] : 'Gasto').trim() || 'Gasto';
      if (!out[local]) out[local] = {};
      out[local][concepto] = (out[local][concepto] || 0) + imp;
    }
    return out;
  } catch (e) {
    console.log('Error CSV gastos:', e.message);
    return null;
  }
}

function leerCostesJSON() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'costes.json'), 'utf8')); }
  catch (e) { return null; }
}

// Junta lo de Google Sheets con el JSON de respaldo
async function getCostes() {
  if (costesCache.data && Date.now() - costesCache.time < 15 * 60 * 1000) return costesCache.data;

  const json = leerCostesJSON() || { reparto_gastos_fijos: 'facturacion', locales: {} };
  const [emp, gas] = await Promise.all([leerEmpleadosCSV(), leerGastosCSV()]);

  const cfg = { reparto_gastos_fijos: json.reparto_gastos_fijos || 'facturacion', locales: {}, origen: {} };

  ['Sevilla Este', 'Bormujos', 'Gines'].forEach(l => {
    const base = (json.locales && json.locales[l]) || {};
    cfg.locales[l] = {
      // Si hay Google Sheet, manda el Sheet. Si no, el JSON.
      empleados: (emp && emp[l]) ? emp[l] : (base.empleados || {}),
      gastos_fijos_mes: (gas && gas[l]) ? gas[l] : (base.gastos_fijos_mes || {}),
    };
    cfg.origen[l] = {
      empleados: (emp && emp[l]) ? 'Google Sheets' : 'costes.json',
      gastos: (gas && gas[l]) ? 'Google Sheets' : 'costes.json',
    };
  });

  costesCache = { data: cfg, time: Date.now() };
  return cfg;
}

// Compara nombres ignorando tildes y mayusculas ("Jesus Lozano" = "JESUS LOZANO")
function mismoNombre(a, b) {
  const n = (s) => (s || '').toString().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  return n(a) === n(b);
}

function calcularRentabilidad(datos, cfg) {
  if (!cfg || !cfg.locales) return null;
  const conf = cfg.locales[datos.local];
  if (!conf || !Object.keys(conf.empleados || {}).length) return null;

  const diasMes = datos.dias_mes || 30;
  const diasPasados = datos.dias_transcurridos || diasMes;
  const proporcion = diasPasados / diasMes;

  const gastosFijosMes = Object.values(conf.gastos_fijos_mes || {})
    .reduce((a, v) => a + (parseFloat(v) || 0), 0);
  const gastosFijosPeriodo = gastosFijosMes * proporcion;

  const empleadosApp = datos.ranking_empleados || [];
  const pagas = parseFloat(cfg.numero_pagas) || 12;
  const reparto = cfg.reparto_gastos_fijos || 'horas';

  const nombres = Object.keys(conf.empleados);

  // Totales del equipo para poder repartir
  const semanasMesPrev = (datos.dias_mes || 30) / 7;
  const propPrev = (datos.dias_transcurridos || 30) / (datos.dias_mes || 30);
  // Horas reales de cada uno en el periodo (contrato + adicionales)
  const horasRealesEquipo = nombres.reduce((a, n) => {
    const e = conf.empleados[n];
    const hc = (parseFloat(e.horas_semana) || 40) * semanasMesPrev * propPrev;
    const ha = parseFloat(e.horas_adicionales_mes) || 0;
    return a + hc + ha;
  }, 0);
  const baseEquipo = empleadosApp.reduce((a, e) => a + (e.facturacion_sin_iva || 0), 0);

  // Horas trabajadas en lo que va de mes (semana x 4.33 semanas)
  const semanasMes = diasMes / 7;
  const lista = [];
  let costeSalarialTotal = 0;

  nombres.forEach((nombreConf) => {
    const datosConf = conf.empleados[nombreConf];
    const enApp = empleadosApp.find(e => mismoNombre(e.nombre, nombreConf));
    const conIva = enApp ? enApp.facturacion : 0;
    const sinIva = enApp ? (enApp.facturacion_sin_iva || conIva) : 0;

    const horasSemana = parseFloat(datosConf.horas_semana) || 40;
    const jornadaPct = Math.round((horasSemana / 40) * 1000) / 10;
    const horasContrato = horasSemana * semanasMes * proporcion;

    const bruto = parseFloat(datosConf.sueldo_bruto_mes) || 0;
    const brutoMensualReal = bruto * (pagas / 12);
    const pctSS = (parseFloat(datosConf.porcentaje_seguridad_social) || 0) / 100;
    const ss = brutoMensualReal * pctSS;
    const costeContrato = (brutoMensualReal + ss) * proporcion;

    // Horas adicionales: van tal cual, no se prorratean (son las ya hechas este mes)
    const horasAdic = parseFloat(datosConf.horas_adicionales_mes) || 0;
    const precioHoraAdic = parseFloat(datosConf.precio_hora_adicional) || 0;
    const costeAdicional = horasAdic * precioHoraAdic * (1 + pctSS);

    const costeSalarial = costeContrato + costeAdicional;
    costeSalarialTotal += costeSalarial;

    const horasPeriodo = horasContrato + (parseFloat(datosConf.horas_adicionales_mes) || 0);

    // REPARTO DE GASTOS FIJOS
    let gastosAsignados, criterio;
    if (reparto === 'partes_iguales') {
      gastosAsignados = gastosFijosPeriodo / nombres.length;
      criterio = 'a partes iguales';
    } else if (reparto === 'facturacion') {
      gastosAsignados = baseEquipo > 0 ? gastosFijosPeriodo * (sinIva / baseEquipo) : 0;
      criterio = 'segun lo que factura';
    } else {
      // Por horas: quien mas horas ocupa el local, mas gastos asume
      gastosAsignados = horasRealesEquipo > 0 ? gastosFijosPeriodo * (horasPeriodo / horasRealesEquipo) : 0;
      criterio = 'segun horas trabajadas';
    }

    const costeTotal = costeSalarial + gastosAsignados;
    const margen = sinIva - costeTotal;
    const r2 = (n) => Math.round(n * 100) / 100;
    const factorIva = sinIva > 0 ? (conIva / sinIva) : 1.21;

    lista.push({
      nombre: nombreConf,
      horas_semana: horasSemana,
      jornada_pct: jornadaPct,
      horas_contrato_periodo: r2(horasContrato),
      horas_adicionales: horasAdic,
      precio_hora_adicional: precioHoraAdic,
      coste_horas_adicionales: r2(costeAdicional),
      horas_trabajadas_periodo: r2(horasPeriodo),
      facturacion_con_iva: r2(conIva),
      facturacion_sin_iva: r2(sinIva),
      // El ratio que permite comparar jornadas distintas
      factura_por_hora: horasPeriodo > 0 ? r2(sinIva / horasPeriodo) : null,
      coste_por_hora: horasPeriodo > 0 ? r2(costeTotal / horasPeriodo) : null,
      margen_por_hora: horasPeriodo > 0 ? r2(margen / horasPeriodo) : null,
      coste_salarial: r2(costeSalarial),
      coste_salarial_contrato: r2(costeContrato),
      gastos_fijos_asignados: r2(gastosAsignados),
      criterio_reparto: criterio,
      coste_total: r2(costeTotal),
      margen: r2(margen),
      es_rentable: margen > 0,
      porcentaje_para_empresa: sinIva > 0 ? Math.round((margen / sinIva) * 1000) / 10 : null,
      porcentaje_coste_personal: sinIva > 0 ? Math.round((costeSalarial / sinIva) * 1000) / 10 : null,
      punto_muerto_sin_iva: r2(costeTotal),
      punto_muerto_con_iva: r2(costeTotal * factorIva),
      punto_muerto_por_hora: horasPeriodo > 0 ? r2((costeTotal * factorIva) / horasPeriodo) : null,
      cuanto_le_falta: margen < 0 ? r2(Math.abs(margen)) : 0,
      falta_por_dia: (margen < 0 && diasMes > diasPasados)
        ? r2(Math.abs(margen) * factorIva / (diasMes - diasPasados)) : 0,
      margen_proyectado_fin_mes: proporcion > 0 ? r2(margen / proporcion) : 0,
    });
  });

  lista.sort((a, b) => b.margen - a.margen);

  const baseTotal = r2v(lista.reduce((a, e) => a + e.facturacion_sin_iva, 0));
  const conIvaTotal = r2v(lista.reduce((a, e) => a + e.facturacion_con_iva, 0));
  const costes = r2v(lista.reduce((a, e) => a + e.coste_total, 0));
  const beneficio = r2v(baseTotal - costes);
  const horasTotales = r2v(lista.reduce((a, e) => a + e.horas_trabajadas_periodo, 0));

  return {
    _como_se_calcula: 'Ingresos SIN IVA menos (bruto x pagas/12 + Seguridad Social) menos su parte de gastos fijos. Los gastos fijos se reparten ' + (reparto === 'horas' ? 'segun las horas que trabaja cada uno' : reparto) + '. Todo ajustado a los dias transcurridos del mes.',
    periodo: `dia ${diasPasados} de ${diasMes}`,
    numero_pagas: pagas,
    criterio_reparto_gastos: reparto,
    horas_adicionales_equipo: r2v(lista.reduce((a, e) => a + e.horas_adicionales, 0)),
    coste_horas_adicionales_equipo: r2v(lista.reduce((a, e) => a + e.coste_horas_adicionales, 0)),
    horas_trabajadas_periodo: horasTotales,
    facturacion_con_iva: conIvaTotal,
    facturacion_sin_iva: baseTotal,
    iva_repercutido: r2v(conIvaTotal - baseTotal),
    facturacion_media_por_hora: horasTotales > 0 ? r2v(baseTotal / horasTotales) : null,
    gastos_fijos_mes_completo: r2v(gastosFijosMes),
    gastos_fijos_periodo: r2v(gastosFijosPeriodo),
    coste_salarial_periodo: r2v(costeSalarialTotal),
    costes_totales: costes,
    beneficio_neto: beneficio,
    margen_neto_pct: baseTotal > 0 ? Math.round((beneficio / baseTotal) * 1000) / 10 : null,
    coste_personal_pct: baseTotal > 0 ? Math.round((costeSalarialTotal / baseTotal) * 1000) / 10 : null,
    beneficio_proyectado_fin_mes: proporcion > 0 ? r2v(beneficio / proporcion) : 0,
    empleados: lista,
  };
}

function r2v(n) { return Math.round(n * 100) / 100; }

// ---------- COLA (una peticion cada vez, espaciadas) ----------
function espera(ms) { return new Promise(r => setTimeout(r, ms)); }
let ultima = 0;
let cola = Promise.resolve();

function koiboxFetch(url, headers) {
  cola = cola.then(async () => {
    const d = Date.now() - ultima;
    if (d < MS_ENTRE_PETICIONES) await espera(MS_ENTRE_PETICIONES - d);
    ultima = Date.now();
    return fetch(url, { headers });
  });
  return cola;
}

async function fetchAllPages(url, headers, maxPages = 30) {
  let results = [], nextUrl = url, pages = 0, count = null, completo = true;
  while (nextUrl && pages < maxPages) {
    let data = null;
    const back = [4000, 10000, 25000];
    for (let i = 0; i < 4; i++) {
      try {
        const res = await koiboxFetch(nextUrl, headers);
        if (res.status === 429) { const w = back[Math.min(i, 2)]; console.log('429, espero', w); await espera(w); continue; }
        if (res.status >= 500) { await espera(2500); continue; }
        if (!res.ok) { console.log('Koibox error', res.status); break; }
        data = await res.json();
        break;
      } catch (e) { await espera(1500 * (i + 1)); }
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

// Solo el total, 1 sola peticion
async function fetchCount(url, headers) {
  try {
    const res = await koiboxFetch(url, headers);
    if (!res.ok) return null;
    const d = await res.json();
    return d.count !== undefined ? d.count : null;
  } catch (e) { return null; }
}

// ---------- FECHAS ----------
function getDateRange() {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const year = now.getFullYear();
  const m = now.getMonth();
  const month = String(m + 1).padStart(2, '0');
  const daysInMonth = new Date(year, m + 1, 0).getDate();
  return {
    today,
    firstDay: `${year}-${month}-01`,
    lastDay: `${year}-${month}-${String(daysInMonth).padStart(2, '0')}`,
    day: now.getDate(),
    daysInMonth,
  };
}

function detectDate(q) {
  const { today } = getDateRange();
  const now = new Date();
  q = (q || '').toLowerCase();
  if (q.includes('mañana')) { const m = new Date(); m.setDate(m.getDate() + 1); return m.toISOString().split('T')[0]; }
  const m1 = q.match(/\b(\d{1,2})[\/\-](\d{1,2})\b/);
  if (m1) return `${now.getFullYear()}-${m1[2].padStart(2, '0')}-${m1[1].padStart(2, '0')}`;
  const m2 = q.match(/\b(el|día|dia)\s+(\d{1,2})\b/);
  if (m2) return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${m2[2].padStart(2, '0')}`;
  return today;
}

// ---------- HELPERS DE VENTAS ----------
function importeVenta(v) {
  return parseFloat(v.total) || parseFloat(v.total_con_iva) || parseFloat(v.importe) || 0;
}

function nombreEmpleado(a) {
  if (!a) return null;
  if (typeof a === 'string') return a;
  if (typeof a === 'object') {
    // Koibox trae: { value, text, username(email), ... } -> "text" es el nombre
    return a.text || a.first_name || a.nombre || a.name || a.username || null;
  }
  return null;
}

function empleadoDeVenta(v) {
  return nombreEmpleado(v.assigned_to) || nombreEmpleado(v.empleado) || nombreEmpleado(v.user) || 'Sin asignar';
}

// Encuentra el array de lineas dentro de una venta, se llame como se llame
function lineasDeVenta(v) {
  if (Array.isArray(v.lineas_venta)) return v.lineas_venta;
  for (const k of Object.keys(v)) {
    if (Array.isArray(v[k]) && v[k].length && typeof v[k][0] === 'object') return v[k];
  }
  return [];
}

// De una linea saca: nombre, tipo, precio y empleado (estructura real de Koibox)
// Busca el precio en TODOS los nombres que usa Koibox (los productos no usan "precio")
const CAMPOS_PRECIO = [
  'precio', 'pvp', 'precio_venta', 'precioVenta', 'precio_publico',
  'precio_con_iva', 'precio_sin_iva', 'importe', 'total',
  'precio_tarifa1', 'precio_tarifa2',
];

// Devuelve el precio, o null si el producto no trae ningun campo de precio
function precioDe(item) {
  if (!item || typeof item !== 'object') return null;
  for (const campo of CAMPOS_PRECIO) {
    if (item[campo] !== undefined && item[campo] !== null && item[campo] !== '') {
      const n = parseFloat(item[campo]);
      if (!isNaN(n)) return n;
    }
  }
  return null;
}

function analizarLinea(linea, ventaEmpleado) {
  let tipo = 'Otro';
  let item = null;

  if (linea.producto) { tipo = 'Producto'; item = linea.producto; }
  else if (linea.servicio) { tipo = 'Servicio'; item = linea.servicio; }
  else if (linea.bono || linea.bono_vendido) { tipo = 'Bono'; item = linea.bono || linea.bono_vendido; }
  else if (linea.pack) { tipo = 'Pack'; item = linea.pack; }
  else if (linea.suscripcion) { tipo = 'Suscripcion'; item = linea.suscripcion; }

  let nombre = 'Sin nombre';
  if (item && typeof item === 'object') nombre = item.nombre || item.text || item.name || 'Sin nombre';
  else if (typeof item === 'string') nombre = item;

  // El precio de la linea puede estar en la propia linea o dentro del producto/servicio
  let importe = precioDe(linea);
  if (importe === null) importe = precioDe(item);

  const cantidad = parseFloat(linea.cantidad) || parseFloat(linea.unidades) || 1;

  // Solo es USO INTERNO si el precio es explicitamente 0.
  // Si no encontramos precio (null), lo damos por VENDIDO, no por uso interno.
  const usoInterno = (importe === 0);
  const importeFinal = importe === null ? 0 : importe;

  const emp = nombreEmpleado(linea.assigned_to) || ventaEmpleado;

  return { nombre, tipo, cantidad, importe: importeFinal, empleado: emp, usoInterno, precio_encontrado: importe !== null };
}

// Saca la hora (0-23) de una venta
function horaDeVenta(v) {
  const cand = v.hora || v.hora_inicio || v.created || v.fecha_hora || null;
  if (!cand) return null;
  const m = String(cand).match(/(\d{1,2}):(\d{2})/);
  if (m) return parseInt(m[1], 10);
  return null;
}

// ---------- DATOS DE UN LOCAL ----------
async function getDatosLocal(local, fechaEspecifica) {
  const key = KOIBOX_KEYS[local];
  if (!key) return null;

  const ck = `${local}|${fechaEspecifica}`;
  const c = cacheGet(ck);
  if (c) { console.log('CACHE', ck); return c; }

  const headers = { 'X-Koibox-Key': key, 'Accept': 'application/json' };
  const { today, firstDay, lastDay, day, daysInMonth } = getDateRange();
  const base = 'https://api.koibox.cloud/api';

  // VENTAS del mes: la fuente de verdad (facturacion, empleados, productos)
  const ventasData = await fetchAllPages(`${base}/ventas/?fecha__gte=${firstDay}&fecha__lte=${lastDay}&limit=${LIMITE}`, headers, 30);
  const ventas = ventasData.results;

  // Solo los TOTALES (1 peticion cada uno, no descargamos todo)
  const citasAgendadas = await fetchCount(`${base}/agenda/?fecha__gte=${firstDay}&fecha__lte=${lastDay}&limit=1`, headers);
  const totalClientes = await fetchCount(`${base}/clientes/?limit=1`, headers);

  // Clientes nuevos este mes (dados de alta dentro del mes)
  let clientesNuevos = await fetchCount(`${base}/clientes/?created__gte=${firstDay}T00:00:00&created__lte=${lastDay}T23:59:59&limit=1`, headers);
  if (clientesNuevos === null) {
    clientesNuevos = await fetchCount(`${base}/clientes/?created__gte=${firstDay}&limit=1`, headers);
  }

  // Clientes perdidos: sin venir desde hace mas de 90 dias
  const hace90 = new Date(); hace90.setDate(hace90.getDate() - 90);
  const fecha90 = hace90.toISOString().split('T')[0];
  let clientesPerdidos = await fetchCount(`${base}/clientes/?ultima_visita__lte=${fecha90}&limit=1`, headers);
  if (clientesPerdidos === null) {
    clientesPerdidos = await fetchCount(`${base}/clientes/?fecha_ultima_visita__lte=${fecha90}&limit=1`, headers);
  }

  // Citas del dia consultado (1-2 peticiones)
  const citasDiaData = await fetchAllPages(`${base}/agenda/?fecha__gte=${fechaEspecifica}&fecha__lte=${fechaEspecifica}&limit=${LIMITE}`, headers, 3);

  console.log(`[${local}] ventas ${ventas.length}/${ventasData.count} completo:${ventasData.completo}`);

  // --- Calculos sobre las ventas ---
  let facturacion = 0;
  const porEmpleado = {};
  const porDia = {};
  const porHora = {};
  const porDiaSemana = {};
  const productosTop = {};
  const serviciosTop = {};
  const usoInternoTop = {};
  let muestraProducto = null;
  const DIAS_SEMANA = ['Domingo','Lunes','Martes','Miercoles','Jueves','Viernes','Sabado'];

  const nuevoEmp = () => ({ facturacion: 0, base: 0, tickets: 0, productos: 0, servicios: 0, detalle_productos: {}, uso_interno: 0, detalle_uso_interno: {} });

  let baseTotal = 0;

  ventas.forEach(v => {
    const imp = importeVenta(v);
    facturacion += imp;

    // Base imponible = sin IVA. Es lo que realmente se queda el negocio.
    const base = parseFloat(v.base_imponible);
    const baseVenta = isNaN(base) ? imp : base;
    baseTotal += baseVenta;

    const emp = empleadoDeVenta(v);
    if (!porEmpleado[emp]) porEmpleado[emp] = nuevoEmp();
    porEmpleado[emp].facturacion += imp;
    porEmpleado[emp].base += baseVenta;
    porEmpleado[emp].tickets++;

    // Por dia
    const f = v.fecha || 'Sin fecha';
    if (!porDia[f]) porDia[f] = { tickets: 0, facturacion: 0 };
    porDia[f].tickets++;
    porDia[f].facturacion += imp;

    // Por dia de la semana
    if (f !== 'Sin fecha') {
      const nd = DIAS_SEMANA[new Date(f + 'T12:00:00').getDay()];
      if (nd) {
        if (!porDiaSemana[nd]) porDiaSemana[nd] = { tickets: 0, facturacion: 0 };
        porDiaSemana[nd].tickets++;
        porDiaSemana[nd].facturacion += imp;
      }
    }

    // Por hora del dia
    const h = horaDeVenta(v);
    if (h !== null) {
      const franja = String(h).padStart(2, '0') + ':00';
      if (!porHora[franja]) porHora[franja] = { tickets: 0, facturacion: 0 };
      porHora[franja].tickets++;
      porHora[franja].facturacion += imp;
    }

    // Lineas: productos, servicios y uso interno (0 euros)
    lineasDeVenta(v).forEach(l => {
      if (!muestraProducto && l.producto) muestraProducto = { linea_precio: precioDe(l), producto: l.producto };
      const a = analizarLinea(l, emp);
      if (!porEmpleado[a.empleado]) porEmpleado[a.empleado] = nuevoEmp();
      const E = porEmpleado[a.empleado];

      if (a.tipo === 'Producto') {
        if (a.usoInterno) {
          // 0 euros = uso interno, NO cuenta como venta
          E.uso_interno += a.cantidad;
          E.detalle_uso_interno[a.nombre] = (E.detalle_uso_interno[a.nombre] || 0) + a.cantidad;
          usoInternoTop[a.nombre] = (usoInternoTop[a.nombre] || 0) + a.cantidad;
        } else {
          E.productos += a.cantidad;
          E.detalle_productos[a.nombre] = (E.detalle_productos[a.nombre] || 0) + a.cantidad;
          productosTop[a.nombre] = (productosTop[a.nombre] || 0) + a.cantidad;
        }
      } else if (a.tipo === 'Servicio' && !a.usoInterno) {
        E.servicios += a.cantidad;
        serviciosTop[a.nombre] = (serviciosTop[a.nombre] || 0) + a.cantidad;
      }
    });
  });

  facturacion = Math.round(facturacion * 100) / 100;

  const facturacionTotalEmp = Object.values(porEmpleado).reduce((a, d) => a + d.facturacion, 0) || 1;

  const rankingEmpleados = Object.entries(porEmpleado)
    .map(([nombre, d]) => {
      const fact = Math.round(d.facturacion * 100) / 100;
      const topProd = Object.entries(d.detalle_productos)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([n, u]) => ({ nombre: n, uds: u }));
      return {
        nombre,
        facturacion: fact,
        facturacion_sin_iva: Math.round(d.base * 100) / 100,
        tickets: d.tickets,
        ticket_medio: d.tickets > 0 ? Math.round((d.facturacion / d.tickets) * 100) / 100 : 0,
        porcentaje_del_total: Math.round((d.facturacion / facturacionTotalEmp) * 1000) / 10,
        servicios_realizados: d.servicios,
        productos_vendidos: d.productos,
        top_productos: topProd,
        detalle_productos: d.detalle_productos,
        productos_uso_interno: d.uso_interno,
        detalle_uso_interno: d.detalle_uso_interno,
        media_diaria: day > 0 ? Math.round((d.facturacion / day) * 100) / 100 : 0,
      };
    })
    .sort((a, b) => b.facturacion - a.facturacion);

  const redondear = (o) => { Object.keys(o).forEach(k => { o[k].facturacion = Math.round(o[k].facturacion * 100) / 100; }); return o; };
  redondear(porDia); redondear(porHora); redondear(porDiaSemana);

  const horasTop = Object.entries(porHora)
    .map(([franja, d]) => ({ franja, tickets: d.tickets, facturacion: d.facturacion }))
    .sort((a, b) => b.facturacion - a.facturacion);

  const diasSemanaTop = Object.entries(porDiaSemana)
    .map(([dia, d]) => ({ dia, tickets: d.tickets, facturacion: d.facturacion }))
    .sort((a, b) => b.facturacion - a.facturacion);

  const ordenar = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([nombre, uds]) => ({ nombre, uds }));

  const ticket = ventasData.count > 0 ? Math.round((facturacion / ventasData.count) * 100) / 100 : 0;
  const prevision = day > 0 ? Math.round((facturacion / day) * daysInMonth) : 0;

  const datos = {
    local,
    fecha_hoy: today,
    fecha_consultada: fechaEspecifica,
    facturacion_mes: facturacion,
    facturacion_sin_iva_mes: Math.round(baseTotal * 100) / 100,
    tickets_cobrados: ventasData.count,          // ventas reales cobradas
    citas_agendadas_mes: citasAgendadas,         // incluye pendientes y anuladas
    ticket_medio: ticket,
    prevision_mes: prevision,
    ranking_empleados: rankingEmpleados,
    productos_mas_vendidos: ordenar(productosTop),
    productos_uso_interno: ordenar(usoInternoTop),
    _muestra_producto_bruto: muestraProducto,
    servicios_mas_realizados: ordenar(serviciosTop),
    por_dia: porDia,
    horas_mas_rentables: horasTop,
    dias_semana_mas_rentables: diasSemanaTop,
    total_clientes: totalClientes,
    clientes_nuevos_mes: clientesNuevos,
    clientes_perdidos_90dias: clientesPerdidos,
    citas_del_dia: citasDiaData.results.slice(0, 40).map(x => ({
      hora: x.hora_inicio,
      estado: (x.estado && (x.estado.nombre || x.estado)) || '?',
      precio: x.precio,
    })),
    total_citas_del_dia: citasDiaData.count,
    dias_transcurridos: day,
    dias_mes: daysInMonth,
  };

  if (ventasData.completo) {
    cacheSet(ck, datos);
    ULTIMO_BUENO.set(local, datos);
    return datos;
  }

  console.log('Descarga incompleta en', local);
  const bk = ULTIMO_BUENO.get(local);
  if (bk) return { ...bk, aviso: 'Koibox limito las peticiones. Datos de hace unos minutos.' };
  return { ...datos, aviso: 'Koibox limito las peticiones. Espera un minuto y vuelve a preguntar.' };
}

function calcularOKR(d, calidad) {
  const cfg = leerObjetivos();
  const o = (cfg.objetivos && cfg.objetivos[d.local]) || null;
  if (!o) return null;

  const pct = (r, m) => (m > 0 && r !== null && r !== undefined) ? Math.round((r / m) * 1000) / 10 : null;
  const cal = (calidad && calidad[d.local]) || {};

  return {
    ritmo_esperado_pct: Math.round((d.dias_transcurridos / d.dias_mes) * 1000) / 10,
    facturacion: {
      objetivo: o.facturacion,
      real: d.facturacion_mes,
      pct: pct(d.facturacion_mes, o.facturacion),
    },
    calidad_estandarizada: {
      objetivo: o.calidad_estandarizada,
      real: cal.calidad_estandarizada !== undefined ? cal.calidad_estandarizada : null,
      pct: pct(cal.calidad_estandarizada, o.calidad_estandarizada),
      ultima_revision: cal.fecha_estandarizada || null,
    },
    calidad_personal: {
      objetivo: o.calidad_personal,
      real: cal.calidad_personal !== undefined ? cal.calidad_personal : null,
      pct: pct(cal.calidad_personal, o.calidad_personal),
      ultima_revision: cal.fecha_personal || null,
    },
    observaciones_calidad: cal.observaciones || null,
  };
}

async function getKoiboxData(local, question) {
  const fecha = detectDate(question);

  if (local === 'Todos') {
    const res = [];
    for (const l of ['Sevilla Este', 'Bormujos', 'Gines']) {
      try { const d = await getDatosLocal(l, fecha); if (d) res.push(d); } catch (e) {}
    }
    if (!res.length) return { error: 'No se pudieron cargar los datos' };
    const calidad = await getCalidad();
    const s = (c) => res.reduce((a, d) => a + (d[c] || 0), 0);
    const fact = Math.round(s('facturacion_mes') * 100) / 100;
    const tk = s('tickets_cobrados');
    return {
      local: 'Todos',
      fecha_hoy: res[0].fecha_hoy,
      facturacion_mes: fact,
      tickets_cobrados: tk,
      citas_agendadas_mes: s('citas_agendadas_mes'),
      ticket_medio: tk > 0 ? Math.round((fact / tk) * 100) / 100 : 0,
      prevision_mes: s('prevision_mes'),
      total_clientes: s('total_clientes'),
      dias_transcurridos: res[0].dias_transcurridos,
      dias_mes: res[0].dias_mes,
      por_local: res.map(d => ({
        local: d.local,
        facturacion: d.facturacion_mes,
        tickets: d.tickets_cobrados,
        ticket_medio: d.ticket_medio,
        prevision: d.prevision_mes,
        okr: calcularOKR(d, calidad),
      })),
    };
  }

  const d = await getDatosLocal(local, fecha);
  if (!d) return { error: 'No hay clave para este local' };
  d.okr = calcularOKR(d, await getCalidad());
  d.rentabilidad = calcularRentabilidad(d, await getCostes());
  return d;
}

// ---------- IA ----------
// Reduce los datos para no saturar a la IA
function compactar(d) {
  const o = { ...d };
  delete o._muestra_producto_bruto;
  delete o.citas_del_dia;
  // La rentabilidad se mantiene entera, es importante

  if (o.ranking_empleados) {
    o.ranking_empleados = o.ranking_empleados.slice(0, 12);
  }
  if (o.por_dia) {
    // Solo los 10 dias mas fuertes, no los 31
    o.por_dia = Object.entries(o.por_dia)
      .sort((a, b) => b[1].facturacion - a[1].facturacion)
      .slice(0, 10)
      .map(([fecha, v]) => ({ fecha, tickets: v.tickets, facturacion: v.facturacion }));
  }
  if (o.horas_mas_rentables) o.horas_mas_rentables = o.horas_mas_rentables.slice(0, 12);
  if (o.productos_mas_vendidos) o.productos_mas_vendidos = o.productos_mas_vendidos.slice(0, 12);
  if (o.servicios_mas_realizados) o.servicios_mas_realizados = o.servicios_mas_realizados.slice(0, 12);
  if (o.productos_uso_interno) o.productos_uso_interno = o.productos_uso_interno.slice(0, 8);

  return o;
}


async function callAnthropic(question, local, d) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1300,
      messages: [{
        role: 'user',
        content: `Eres el asistente de negocio de LeBarbier ${local} (Sevilla). Hoy es ${d.fecha_hoy}.

DATOS REALES DE KOIBOX (ya calculados, usalos tal cual):
${JSON.stringify(compactar(d))}

CLAVES PARA INTERPRETAR:
- "tickets_cobrados" = ventas realmente cobradas este mes (lo REAL).
- "citas_agendadas_mes" = citas en agenda, INCLUYE pendientes y anuladas. NO son citas realizadas.
- "ranking_empleados": por cada empleado tiene facturacion, tickets, productos_vendidos (VENTAS REALES), detalle_productos (producto -> unidades), productos_uso_interno y detalle_uso_interno.
- IMPORTANTE - USO INTERNO: los productos con importe 0 euros son de USO INTERNO del salon (no se han vendido a un cliente). NUNCA los cuentes como venta del empleado. Van aparte en "productos_uso_interno". Si los mencionas, deja claro que son de uso interno y no venta.
- "horas_mas_rentables": franjas horarias ordenadas por facturacion.
- "dias_semana_mas_rentables": dias de la semana ordenados por facturacion.
- "clientes_nuevos_mes" y "clientes_perdidos_90dias" (clientes sin venir desde hace mas de 90 dias). Si salen null, di que Koibox no da ese dato por API.
- "rentabilidad": analisis economico. MUY IMPORTANTE: se calcula sobre la facturacion SIN IVA (base imponible), porque el IVA no es del negocio. Si te preguntan por facturacion a secas, usa "facturacion_mes" (con IVA); si te preguntan por rentabilidad o beneficio, usa los datos sin IVA.
- En rentabilidad, cada empleado tiene: Cada uno tiene facturacion, coste_salarial (sueldo + seguridad social), gastos_fijos_asignados (su parte del alquiler, luz...), coste_total, margen (lo que deja limpio), porcentaje_para_empresa (de cada euro que factura, cuanto se queda la empresa), porcentaje_coste_personal y facturacion_para_cubrirse (lo minimo que deberia facturar). Si "es_rentable" es false, el empleado da perdidas: "cuanto_le_falta" son los euros que faltan y "falta_por_dia" lo que deberia facturar cada dia que queda de mes para llegar.
- "porcentaje_coste_personal" es el ratio clave del sector: por debajo del 45% es sano, por encima del 55% preocupante.
- MUY IMPORTANTE al comparar empleados: cada uno tiene "horas_semana" distintas. NUNCA compares directamente la facturacion de alguien de 40h con alguien de 20h. Usa "factura_por_hora" y "margen_por_hora", que es lo justo. Menciona siempre la jornada cuando compares.
- Los gastos fijos se reparten segun las horas que trabaja cada uno (quien mas horas ocupa el local, mas parte asume).
- "horas_adicionales" son horas trabajadas por encima de su contrato, pagadas a "precio_hora_adicional". Su coste va incluido en "coste_salarial" (desglosado en "coste_horas_adicionales"). Llamalas SIEMPRE "horas adicionales", nunca "horas extra".
- "punto_muerto_con_iva" es lo minimo que tiene que facturar (precio de cara al cliente) para cubrir sus costes. Los importes estan ajustados a los dias transcurridos del mes, no al mes completo. "margen_proyectado_fin_mes" estima como acabara si sigue igual.
- Cuando te pregunten por rentabilidad: se claro sobre quien deja dinero y quien no, di el porcentaje que se queda la empresa y da una recomendacion concreta. Recuerda que es una estimacion basada en los costes que ha configurado el usuario.
- "okr" son los 3 objetivos: facturacion (sale de Koibox), calidad_estandarizada y calidad_personal (salen de la auditoria quincenal que rellena un companero).
- Para FACTURACION: compara el % logrado con "ritmo_esperado_pct" (% del mes transcurrido). Si el % logrado es menor, van por detras del ritmo.
- Para las CALIDADES: no dependen del ritmo del mes, es una nota de la ultima revision. Si "real" es null, di que aun no se ha rellenado la auditoria de esta quincena.

INSTRUCCIONES:
- Responde en español, concreto y directo.
- Usa tablas markdown para rankings y desgloses.
- Si preguntan por productos de un empleado: usa "detalle_productos" y desglosa producto a producto con unidades. Si ademas tiene uso interno, muestralo en una linea aparte marcado como "uso interno (no es venta)".
- Si preguntan por horas: usa "horas_mas_rentables" e indica la franja mas fuerte y la mas floja, con una recomendacion.
- Si hay campo "aviso", mencionalo al final en una linea.
- Maximo 320 palabras.

PREGUNTA: ${question}`
      }]
    })
  });
  const j = await r.json();
  if (j.error) throw new Error('Anthropic (' + (j.error.type || '?') + '): ' + j.error.message);
  if (!j.content || !j.content[0] || !j.content[0].text) {
    throw new Error('Anthropic no devolvio texto. Respuesta: ' + JSON.stringify(j).substring(0, 300));
  }
  return j.content[0].text;
}

// ---------- SERVIDOR ----------
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // Diagnostico: estructura de una venta y sus lineas
  // Comprueba si Koibox tiene endpoint de gastos
  if (req.method === 'GET' && req.url.startsWith('/api/probargastos')) {
    const local = new URL(req.url, 'http://x').searchParams.get('local') || 'Sevilla Este';
    const key = KOIBOX_KEYS[local];
    const headers = { 'X-Koibox-Key': key, 'Accept': 'application/json' };
    const { firstDay, lastDay } = getDateRange();

    const candidatas = [
      '/api/gastos/',
      '/api/gasto/',
      '/api/caja/gastos/',
      '/api/movimientos/',
      '/api/movimientos-caja/',
      '/api/caja/',
      '/api/arqueos/',
      '/api/compras/',
      '/api/proveedores/',
      '/api/empleados/',
      '/api/usuarios/',
    ];

    const resultado = {};
    for (const ruta of candidatas) {
      try {
        const url = `https://api.koibox.cloud${ruta}?limit=1`;
        const r = await koiboxFetch(url, headers);
        const txt = await r.text();
        let info = { status: r.status };
        if (r.status === 200) {
          try {
            const j = JSON.parse(txt);
            info.EXISTE = true;
            info.total_registros = j.count;
            info.campos = (j.results && j.results[0]) ? Object.keys(j.results[0]) : [];
          } catch (e) { info.EXISTE = false; info.nota = 'devuelve HTML, no JSON'; }
        } else {
          info.EXISTE = false;
        }
        resultado[ruta] = info;
      } catch (e) {
        resultado[ruta] = { error: e.message };
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ local, rango: { firstDay, lastDay }, endpoints: resultado }, null, 2));
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/calidad')) {
    const cal = await getCalidad();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      csv_estandarizada_configurado: !!CSV_ESTANDARIZADA,
      csv_personal_configurado: !!CSV_PERSONAL,
      ultimas_notas: cal,
    }, null, 2));
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/debug')) {
    const { firstDay, lastDay } = getDateRange();
    const local = new URL(req.url, 'http://x').searchParams.get('local') || 'Sevilla Este';
    const key = KOIBOX_KEYS[local];
    const headers = { 'X-Koibox-Key': key, 'Accept': 'application/json' };

    // Bajamos unas paginas y buscamos lineas que tengan PRODUCTO
    const vd = await fetchAllPages(`https://api.koibox.cloud/api/ventas/?fecha__gte=${firstDay}&fecha__lte=${lastDay}&limit=${LIMITE}`, headers, 2);

    let totalLineas = 0, conProducto = 0, conServicio = 0, otras = 0;
    const ejemplos = [];

    vd.results.forEach(v => {
      lineasDeVenta(v).forEach(l => {
        totalLineas++;
        if (l.producto) {
          conProducto++;
          if (ejemplos.length < 3) {
            const campos = {};
            Object.keys(l).forEach(k => {
              const val = l[k];
              campos[k] = (val && typeof val === 'object') ? '{OBJETO}' : val;
            });
            ejemplos.push({
              CAMPOS_DE_LA_LINEA: campos,
              EL_PRODUCTO_ENTERO: l.producto,
              venta_total: v.total,
              empleado: nombreEmpleado(l.assigned_to) || empleadoDeVenta(v),
              yo_interpreto: analizarLinea(l, empleadoDeVenta(v)),
            });
          }
        } else if (l.servicio) conServicio++;
        else otras++;
      });
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      local,
      ventas_descargadas: vd.results.length,
      lineas_totales: totalLineas,
      lineas_con_PRODUCTO: conProducto,
      lineas_con_servicio: conServicio,
      lineas_otras: otras,
      EJEMPLOS_DE_PRODUCTO: ejemplos.length ? ejemplos : 'No se encontro ninguna linea con producto',
    }, null, 2));
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/costes')) {
    const cfg = await getCostes();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      hoja_empleados_configurada: !!CSV_EMPLEADOS,
      hoja_gastos_configurada: !!CSV_GASTOS,
      de_donde_saca_los_datos: cfg.origen,
      reparto_gastos_fijos: cfg.reparto_gastos_fijos,
      lo_que_ha_leido: cfg.locales,
    }, null, 2));
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/rentabilidad')) {
    try {
      const local = new URL(req.url, 'http://x').searchParams.get('local') || 'Sevilla Este';
      const d = await getKoiboxData(local, 'rentabilidad');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(d.rentabilidad || { error: 'No hay costes configurados para este local' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/productos')) {
    try {
      const local = new URL(req.url, 'http://x').searchParams.get('local') || 'Sevilla Este';
      const d = await getKoiboxData(local, 'productos');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        productos: d.productos_mas_vendidos || [],
        uso_interno: d.productos_uso_interno || [],
        servicios: d.servicios_mas_realizados || [],
        empleados: d.ranking_empleados || [],
        horas: d.horas_mas_rentables || [],
        dias_semana: d.dias_semana_mas_rentables || [],
        clientes_nuevos: d.clientes_nuevos_mes,
        clientes_perdidos: d.clientes_perdidos_90dias,
        total_clientes: d.total_clientes,
        _muestra_producto_bruto: d._muestra_producto_bruto || null,
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/stats')) {
    try {
      const local = new URL(req.url, 'http://x').searchParams.get('local') || 'Sevilla Este';
      const d = await getKoiboxData(local, 'facturacion');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        facturacion: d.facturacion_mes,
        citas: d.tickets_cobrados,
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
        const d = await getKoiboxData(local, question);
        const resp = await callAnthropic(question, local, d);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response: resp }));
      } catch (e) {
        console.error('Error en /api/query:', e.message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response: '⚠️ Error del servidor: ' + e.message }));
      }
    });
    return;
  }

  let fp = path.join(__dirname, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  const ext = path.extname(fp);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png' };
  fs.readFile(fp, (err, data) => {
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
});
