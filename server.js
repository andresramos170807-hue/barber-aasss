const http = require('http');
const fs = require('fs');
const path = require('path');
const auth = require('./auth');

const PORT = process.env.PORT || 3000;

const KOIBOX_KEYS = {
  'Sevilla Este': process.env.KOIBOX_KEY_LB_SEVILLA_ESTE,
  'Bormujos': process.env.KOIBOX_KEY_LB_BORMUJOS,
  'Gines': process.env.KOIBOX_KEY_LB_GINES,
};
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// Koibox limita: max 100 por pagina y pocas peticiones por minuto
const LIMITE = 100;
const MS_ENTRE_PETICIONES = 550;

// ---------- CACHE ----------
const CACHE = new Map();
const ULTIMO_BUENO = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hora
const CACHE_CERRADO = new Map();  // meses pasados: no cambian nunca
const EN_CURSO = new Map();       // descargas en marcha, para no repetirlas

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


// Lee la respuesta como UTF-8 de verdad (asi las tildes no salen rotas)
async function leerTextoUTF8(respuesta) {
  const buf = await respuesta.arrayBuffer();
  return new TextDecoder('utf-8').decode(buf);
}

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
    const filas = parseCSV(await leerTextoUTF8(r));
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
// Detecta si un "empleado" es en realidad el centro (ventas sin barbero asignado)
function esElCentro(nombre) {
  const n = (nombre || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return n.includes('barbier') || n.includes('babier') || n.includes('peluquero')
      || n.includes('sin asignar') || n.includes('admin') || n.includes('centro');
}

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
    const filas = parseCSV(await leerTextoUTF8(r));
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
let diagnosticoGastos = null;   // para poder ver que ha leido y que ha descartado

async function leerGastosCSV() {
  if (!CSV_GASTOS) return null;
  try {
    const r = await fetch(CSV_GASTOS);
    if (!r.ok) { console.log('CSV gastos HTTP', r.status); return null; }
    const filas = parseCSV(await leerTextoUTF8(r));
    if (filas.length < 2) return null;

    const cab = filas[0].map(normaliza);
    const buscar = (...cl) => cab.findIndex(h => cl.some(k => h.includes(k)));

    const iLocal = buscar('local', 'barberia', 'salon', 'centro');
    const iConcepto = buscar('concepto', 'gasto', 'descripcion', 'tipo');
    const iImporte = buscar('importe', 'cantidad', 'euros', 'coste', 'mes');

    const out = {};
    const leidas = [];
    const descartadas = [];

    for (let i = 1; i < filas.length; i++) {
      const f = filas[i];
      const textoLocal = iLocal >= 0 ? f[iLocal] : '';
      const local = identificarLocal(textoLocal);
      const impBruto = iImporte >= 0 ? f[iImporte] : '';
      const imp = iImporte >= 0 ? importe(impBruto) : null;
      const concepto = ((iConcepto >= 0 ? f[iConcepto] : '') || 'Gasto').trim() || 'Gasto';

      if (!local) {
        descartadas.push({ fila: i + 1, motivo: 'No reconozco el local', decia: textoLocal, concepto, importe: impBruto });
        continue;
      }
      if (imp === null) {
        descartadas.push({ fila: i + 1, motivo: 'No entiendo el importe', local, concepto, decia: impBruto });
        continue;
      }

      if (!out[local]) out[local] = {};
      // Si se repite el concepto, se le anade un numero para no machacarlo
      let clave = concepto;
      let n = 2;
      while (out[local][clave] !== undefined) { clave = concepto + ' (' + n + ')'; n++; }
      out[local][clave] = imp;

      leidas.push({ fila: i + 1, local, concepto: clave, importe: imp });
    }

    const totales = {};
    Object.entries(out).forEach(([l, g]) => {
      totales[l] = Math.round(Object.values(g).reduce((a, v) => a + v, 0) * 100) / 100;
    });

    diagnosticoGastos = {
      columnas_del_excel: filas[0],
      columna_local: iLocal >= 0 ? filas[0][iLocal] : 'NO ENCONTRADA',
      columna_concepto: iConcepto >= 0 ? filas[0][iConcepto] : 'NO ENCONTRADA',
      columna_importe: iImporte >= 0 ? filas[0][iImporte] : 'NO ENCONTRADA',
      filas_totales: filas.length - 1,
      filas_leidas: leidas.length,
      filas_descartadas: descartadas.length,
      TOTAL_POR_LOCAL: totales,
      detalle_leidas: leidas,
      DESCARTADAS: descartadas,
    };

    return out;
  } catch (e) {
    console.log('Error CSV gastos:', e.message);
    diagnosticoGastos = { error: e.message };
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
// Limpia un nombre: quita tildes, notas tipo "VACACIONES 12-26", fechas y parentesis
function limpiarNombre(s) {
  return (s || '').toString().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\(.*?\)/g, ' ')                                  // (lo que sea)
    .replace(/\b(vacaciones|baja|libranza|permiso|excedencia)\b.*/g, ' ')  // notas y todo lo que siga
    .replace(/\d{1,2}\s*[-\/]\s*\d{1,2}/g, ' ')             // fechas 12-26
    .replace(/[0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mismoNombre(a, b) {
  const x = limpiarNombre(a);
  const y = limpiarNombre(b);
  if (!x || !y) return false;
  if (x === y) return true;

  // Uno contiene al otro: "david" coincide con "david garcia"
  if (x.includes(y) || y.includes(x)) return true;

  // Comparten el nombre de pila: "jesus lozano" y "jesus carvajal" NO,
  // pero "jesus" y "jesus lozano" SI
  const px = x.split(' ');
  const py = y.split(' ');
  if (px[0] === py[0] && (px.length === 1 || py.length === 1)) return true;

  return false;
}

function calcularRentabilidad(datos, cfg) {
  if (!cfg || !cfg.locales) return null;
  const conf = cfg.locales[datos.local];
  if (!conf || !Object.keys(conf.empleados || {}).length) return null;

  const diasMes = datos.dias_mes || 30;
  const diasPasados = datos.dias_transcurridos || diasMes;
  const proporcion = diasPasados / diasMes;
  const conIvaModo = cfg.usar_facturacion_con_iva !== false;
  const yaIncluyeSS = cfg.el_sueldo_ya_incluye_ss !== false;   // por defecto SI lo incluye

  // COSTES REALES DEL MES COMPLETO (sin prorratear)
  const gastosFijosMes = Object.values(conf.gastos_fijos_mes || {})
    .reduce((a, v) => a + (parseFloat(v) || 0), 0);

  const empleadosApp = datos.ranking_empleados || [];
  const pagas = parseFloat(cfg.numero_pagas) || 12;
  const reparto = cfg.reparto_gastos_fijos || 'horas';
  const nombres = Object.keys(conf.empleados);
  const semanasMes = diasMes / 7;

  // Horas del mes completo de cada uno
  const horasEquipoMes = nombres.reduce((a, n) => {
    const e = conf.empleados[n];
    return a + (parseFloat(e.horas_semana) || 40) * semanasMes + (parseFloat(e.horas_adicionales_mes) || 0);
  }, 0);

  const lista = [];
  let costeSalarialTotal = 0;
  const r2 = (n) => Math.round(n * 100) / 100;

  nombres.forEach((nombreConf) => {
    const dc = conf.empleados[nombreConf];
    const enApp = empleadosApp.find(e => mismoNombre(e.nombre, nombreConf));
    const conIva = enApp ? enApp.facturacion : 0;
    const sinIva = enApp ? (enApp.facturacion_sin_iva || conIva) : 0;

    // Lo que lleva facturado de verdad
    const facturadoHastaHoy = conIvaModo ? conIva : sinIva;
    // Y a donde llegara a fin de mes si sigue igual
    const facturacionProyectada = proporcion > 0 ? facturadoHastaHoy / proporcion : 0;

    const horasSemana = parseFloat(dc.horas_semana) || 40;
    const jornadaPct = Math.round((horasSemana / 40) * 1000) / 10;
    const horasAdic = parseFloat(dc.horas_adicionales_mes) || 0;
    const horasMes = horasSemana * semanasMes + horasAdic;          // mes completo
    const horasHastaHoy = horasSemana * semanasMes * proporcion + horasAdic;

    // --- COSTES DEL MES COMPLETO ---
    const importeHoja = parseFloat(dc.sueldo_bruto_mes) || 0;
    const importeMes = importeHoja * (pagas / 12);
    const pctSS = (parseFloat(dc.porcentaje_seguridad_social) || 0) / 100;

    let brutoMes, ssMes, costeContrato;
    if (yaIncluyeSS) {
      // El importe de la hoja YA es el coste total para la empresa.
      // Solo lo desglosamos para que se vea cuanto es sueldo y cuanto SS.
      costeContrato = importeMes;
      ssMes = pctSS > 0 ? importeMes * (pctSS / (1 + pctSS)) : 0;
      brutoMes = importeMes - ssMes;
    } else {
      // El importe es el bruto del trabajador: hay que sumarle la SS
      brutoMes = importeMes;
      ssMes = importeMes * pctSS;
      costeContrato = brutoMes + ssMes;
    }

    const precioHoraAdic = parseFloat(dc.precio_hora_adicional) || 0;
    const brutoAdic = horasAdic * precioHoraAdic;
    const adicCotizan = cfg.horas_adicionales_cotizan === true;
    const ssAdic = adicCotizan ? brutoAdic * pctSS : 0;
    const costeAdicional = brutoAdic + ssAdic;

    const costeSalarial = costeContrato + costeAdicional;
    costeSalarialTotal += costeSalarial;

    // --- GASTOS FIJOS DEL MES COMPLETO ---
    let gastosAsignados, criterio;
    if (reparto === 'partes_iguales') {
      gastosAsignados = gastosFijosMes / nombres.length;
      criterio = 'a partes iguales';
    } else if (reparto === 'facturacion') {
      const totalFact = empleadosApp.reduce((a, e) => a + (conIvaModo ? e.facturacion : (e.facturacion_sin_iva || e.facturacion)), 0);
      gastosAsignados = totalFact > 0 ? gastosFijosMes * (facturadoHastaHoy / totalFact) : 0;
      criterio = 'segun lo que factura';
    } else {
      gastosAsignados = horasEquipoMes > 0 ? gastosFijosMes * (horasMes / horasEquipoMes) : 0;
      criterio = 'segun horas trabajadas';
    }

    const costeTotal = costeSalarial + gastosAsignados;

    // Margen sobre lo proyectado (justo) y sobre lo real de hoy (informativo)
    const margen = facturacionProyectada - costeTotal;
    const margenHoy = facturadoHastaHoy - costeTotal;

    const loQueCobra = brutoMes + brutoAdic;
    const loQuePagasDeSS = ssMes + ssAdic;

    lista.push({
      nombre: nombreConf,

      // INGRESOS
      facturado_hasta_hoy: r2(facturadoHastaHoy),
      facturacion_proyectada_mes: r2(facturacionProyectada),
      facturacion: r2(facturacionProyectada),
      facturacion_con_iva: r2(conIva),
      facturacion_sin_iva: r2(sinIva),
      incluye_iva: conIvaModo,

      // HORAS
      horas_semana: horasSemana,
      jornada_pct: jornadaPct,
      horas_adicionales: horasAdic,
      precio_hora_adicional: precioHoraAdic,
      horas_mes_completo: r2(horasMes),
      horas_trabajadas_hasta_hoy: r2(horasHastaHoy),

      // COSTES (MES COMPLETO, REALES)
      el_cobra_nomina: r2(brutoMes),
      el_cobra_horas_adicionales: r2(brutoAdic),
      el_cobra_total: r2(loQueCobra),
      tu_pagas_seguridad_social: r2(loQuePagasDeSS),
      porcentaje_ss: Math.round(pctSS * 1000) / 10,
      sueldo_ya_incluia_ss: yaIncluyeSS,
      importe_hoja_costes: r2(importeMes),
      horas_adicionales_cotizan: adicCotizan,
      coste_salarial: r2(costeSalarial),
      coste_salarial_contrato: r2(costeContrato),
      coste_horas_adicionales: r2(costeAdicional),
      gastos_fijos_asignados: r2(gastosAsignados),
      criterio_reparto: criterio,
      coste_total: r2(costeTotal),

      // RESULTADO
      margen: r2(margen),
      margen_a_dia_de_hoy: r2(margenHoy),
      es_rentable: margen > 0,
      va_bien_hoy: margenHoy > 0,

      // RATIOS
      factura_por_hora: horasMes > 0 ? r2(facturacionProyectada / horasMes) : null,
      cuesta_por_hora: horasMes > 0 ? r2(costeTotal / horasMes) : null,
      margen_por_hora: horasMes > 0 ? r2(margen / horasMes) : null,
      de_cada_100_euros_quedan: facturacionProyectada > 0 ? r2((margen / facturacionProyectada) * 100) : null,
      porcentaje_para_empresa: facturacionProyectada > 0 ? Math.round((margen / facturacionProyectada) * 1000) / 10 : null,
      porcentaje_coste_personal: facturacionProyectada > 0 ? Math.round((costeSalarial / facturacionProyectada) * 1000) / 10 : null,

      // OBJETIVOS
      punto_muerto: r2(costeTotal),
      punto_muerto_por_hora: horasMes > 0 ? r2(costeTotal / horasMes) : null,
      le_falta_facturar: r2(Math.max(0, costeTotal - facturadoHastaHoy)),
      falta_por_dia: (diasMes > diasPasados)
        ? r2(Math.max(0, costeTotal - facturadoHastaHoy) / (diasMes - diasPasados)) : 0,
      cuanto_le_falta: margen < 0 ? r2(Math.abs(margen)) : 0,
    });
  });

  lista.sort((a, b) => b.margen - a.margen);

  const sinFacturacion = lista.filter(e => e.facturado_hasta_hoy === 0).map(e => e.nombre);
  const noEmparejados = empleadosApp
    .filter(e => e.facturacion > 0 && !nombres.some(n => mismoNombre(n, e.nombre)))
    .map(e => ({ nombre: e.nombre, factura: e.facturacion }));

  // Las ventas del centro no son de nadie: van aparte, no son un aviso
  const ventasDelCentro = noEmparejados.filter(e => esElCentro(e.nombre));
  const enKoiboxSinCoste = noEmparejados.filter(e => !esElCentro(e.nombre));

  const facturadoHoy = r2v(lista.reduce((a, e) => a + e.facturado_hasta_hoy, 0));
  const proyectado = r2v(lista.reduce((a, e) => a + e.facturacion_proyectada_mes, 0));
  const costes = r2v(costeSalarialTotal + gastosFijosMes);
  const beneficio = r2v(proyectado - costes);
  const beneficioHoy = r2v(facturadoHoy - costes);
  const horasTotales = r2v(lista.reduce((a, e) => a + e.horas_mes_completo, 0));

  return {
    _como_se_calcula: 'Los COSTES son los reales del mes completo. ' + (yaIncluyeSS ? 'El importe de la hoja de costes YA incluye la Seguridad Social, asi que NO se le suma nada: es el coste total para la empresa. El desglose entre sueldo y SS es solo informativo.' : 'El importe de la hoja es el bruto del trabajador y se le suma la Seguridad Social aparte.') + ' Se comparan con la facturacion proyectada a fin de mes.',
    incluye_iva: conIvaModo,
    periodo: `dia ${diasPasados} de ${diasMes}`,
    dias_que_faltan: diasMes - diasPasados,
    numero_pagas: pagas,
    criterio_reparto_gastos: reparto,

    facturado_hasta_hoy: facturadoHoy,
    facturacion_proyectada_mes: proyectado,
    facturacion_total: proyectado,

    horas_mes_completo: horasTotales,
    horas_adicionales_equipo: r2v(lista.reduce((a, e) => a + e.horas_adicionales, 0)),
    coste_horas_adicionales_equipo: r2v(lista.reduce((a, e) => a + e.coste_horas_adicionales, 0)),
    facturacion_media_por_hora: horasTotales > 0 ? r2v(proyectado / horasTotales) : null,

    equipo_cobra_total: r2v(lista.reduce((a, e) => a + e.el_cobra_total, 0)),
    seguridad_social_total: r2v(lista.reduce((a, e) => a + e.tu_pagas_seguridad_social, 0)),
    coste_salarial_periodo: r2v(costeSalarialTotal),
    gastos_fijos_mes_completo: r2v(gastosFijosMes),
    gastos_fijos_periodo: r2v(gastosFijosMes),
    costes_totales: costes,

    beneficio_neto: beneficio,
    beneficio_a_dia_de_hoy: beneficioHoy,
    le_falta_facturar: r2v(Math.max(0, costes - facturadoHoy)),
    margen_neto_pct: proyectado > 0 ? Math.round((beneficio / proyectado) * 1000) / 10 : null,
    coste_personal_pct: proyectado > 0 ? Math.round((costeSalarialTotal / proyectado) * 1000) / 10 : null,
    beneficio_proyectado_fin_mes: beneficio,
    empleados: lista,
    avisos: {
      sin_facturacion_en_koibox: sinFacturacion,
      facturan_pero_no_estan_en_la_hoja: enKoiboxSinCoste,
      ventas_sin_barbero_asignado: ventasDelCentro,
      total_sin_barbero: r2v(ventasDelCentro.reduce((a, e) => a + e.factura, 0)),
    },
  };
}

function r2v(n) { return Math.round(n * 100) / 100; }

// ---------- COLA (una peticion cada vez, espaciadas) ----------
function espera(ms) { return new Promise(r => setTimeout(r, ms)); }

// Una cola POR CADA clave de Koibox. Como el limite es por centro,
// los tres locales pueden descargar a la vez sin estorbarse.
const colas = new Map();

function koiboxFetch(url, headers) {
  const clave = headers['X-Koibox-Key'] || 'general';
  const estado = colas.get(clave) || { ultima: 0, cola: Promise.resolve() };

  estado.cola = estado.cola.then(async () => {
    const d = Date.now() - estado.ultima;
    if (d < MS_ENTRE_PETICIONES) await espera(MS_ENTRE_PETICIONES - d);
    estado.ultima = Date.now();
    return fetch(url, { headers });
  });

  colas.set(clave, estado);
  return estado.cola;
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
const MESES_ES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

// Si le pasas "2026-06" devuelve ese mes. Si no, el mes actual.
function getDateRange(mesPedido) {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const mesActual = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  let year, m;
  if (mesPedido && /^\d{4}-\d{2}$/.test(mesPedido)) {
    year = parseInt(mesPedido.substring(0, 4), 10);
    m = parseInt(mesPedido.substring(5, 7), 10) - 1;
  } else {
    year = now.getFullYear();
    m = now.getMonth();
  }

  const month = String(m + 1).padStart(2, '0');
  const clave = `${year}-${month}`;
  const daysInMonth = new Date(year, m + 1, 0).getDate();
  const esMesActual = clave === mesActual;
  // Si es un mes pasado, cuenta como completo
  const day = esMesActual ? now.getDate() : daysInMonth;

  return {
    today,
    mes: clave,
    mes_nombre: MESES_ES[m] + ' ' + year,
    es_mes_actual: esMesActual,
    es_mes_cerrado: !esMesActual,
    firstDay: `${year}-${month}-01`,
    lastDay: `${year}-${month}-${String(daysInMonth).padStart(2, '0')}`,
    day,
    daysInMonth,
  };
}

// Lista de meses hacia atras para el selector
function mesesDisponibles(cuantos) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < (cuantos || 12); i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({
      valor: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      nombre: MESES_ES[d.getMonth()] + ' ' + d.getFullYear(),
      es_actual: i === 0,
    });
  }
  return out;
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
async function getDatosLocal(local, fechaEspecifica, mesPedido) {
  const key = KOIBOX_KEYS[local];
  if (!key) return null;

  const ck = `${local}|${fechaEspecifica}|${mesPedido || 'actual'}`;

  // Un mes ya cerrado no cambia: se guarda de forma permanente
  const cerrado = CACHE_CERRADO.get(ck);
  if (cerrado) return cerrado;

  const c = cacheGet(ck);
  if (c) { console.log('CACHE', ck); return c; }

  // Si ya hay una descarga en marcha para esto, nos enganchamos a ella
  // en vez de lanzar otra igual (el panel, productos y rentabilidad piden lo mismo)
  const enCurso = EN_CURSO.get(ck);
  if (enCurso) { console.log('Reutilizando descarga en curso:', ck); return enCurso; }

  const promesa = descargarDatosLocal(local, fechaEspecifica, mesPedido, ck, key);
  EN_CURSO.set(ck, promesa);
  try { return await promesa; }
  finally { EN_CURSO.delete(ck); }
}

async function descargarDatosLocal(local, fechaEspecifica, mesPedido, ck, key) {

  const headers = { 'X-Koibox-Key': key, 'Accept': 'application/json' };
  const R = getDateRange(mesPedido);
  const { today, firstDay, lastDay, day, daysInMonth } = R;
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
    mes: R.mes,
    mes_nombre: R.mes_nombre,
    es_mes_cerrado: R.es_mes_cerrado,
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
    if (R.es_mes_cerrado) CACHE_CERRADO.set(ck, datos);
    else { cacheSet(ck, datos); ULTIMO_BUENO.set(local, datos); }
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

async function getKoiboxData(local, question, mesPedido) {
  const fecha = detectDate(question);

  if (local === 'Todos') {
    // En paralelo: cada local tiene su propia cola, no se estorban
    const resultados = await Promise.all(
      ['Sevilla Este', 'Bormujos', 'Gines'].map(l =>
        getDatosLocal(l, fecha, mesPedido).catch(() => null)
      )
    );
    const res = resultados.filter(Boolean);
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

  const d = await getDatosLocal(local, fecha, mesPedido);
  if (!d) return { error: 'No hay clave para este local' };
  d.okr = calcularOKR(d, await getCalidad());
  d.rentabilidad = calcularRentabilidad(d, await getCostes());
  return d;
}


// ---------- COMPARATIVA ENTRE MESES ----------
// Version ligera: solo pide las ventas, no citas ni clientes (mucho mas rapido)
async function resumenMes(local, mesClave) {
  const key = KOIBOX_KEYS[local];
  if (!key) return null;

  const ck = `resumen|${local}|${mesClave}`;
  const guardado = CACHE_CERRADO.get(ck) || cacheGet(ck);
  if (guardado) return guardado;

  const R = getDateRange(mesClave);
  const headers = { 'X-Koibox-Key': key, 'Accept': 'application/json' };

  const vd = await fetchAllPages(
    `https://api.koibox.cloud/api/ventas/?fecha__gte=${R.firstDay}&fecha__lte=${R.lastDay}&limit=${LIMITE}`,
    headers, 40
  );
  if (!vd.completo && vd.results.length === 0) return null;

  let facturacion = 0, base = 0;
  const porEmpleado = {};
  const porDiaSemana = {};
  const porHora = {};
  let productos = 0;
  const DIAS = ['Domingo','Lunes','Martes','Miercoles','Jueves','Viernes','Sabado'];

  vd.results.forEach(v => {
    const imp = importeVenta(v);
    facturacion += imp;
    const bi = parseFloat(v.base_imponible);
    base += isNaN(bi) ? imp : bi;

    const emp = empleadoDeVenta(v);
    if (!esElCentro(emp)) porEmpleado[emp] = (porEmpleado[emp] || 0) + imp;

    if (v.fecha) {
      const nd = DIAS[new Date(v.fecha + 'T12:00:00').getDay()];
      if (nd) porDiaSemana[nd] = (porDiaSemana[nd] || 0) + imp;
    }
    const h = horaDeVenta(v);
    if (h !== null) {
      const f = String(h).padStart(2, '0') + ':00';
      porHora[f] = (porHora[f] || 0) + imp;
    }
    lineasDeVenta(v).forEach(l => {
      const a = analizarLinea(l, emp);
      if (a.tipo === 'Producto' && !a.usoInterno) productos += a.cantidad;
    });
  });

  const r2 = (n) => Math.round(n * 100) / 100;
  const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])
    .slice(0, 8).map(([nombre, v]) => ({ nombre, facturacion: r2(v) }));

  const res = {
    mes: R.mes,
    mes_nombre: R.mes_nombre,
    es_mes_actual: R.es_mes_actual,
    dias_transcurridos: R.day,
    dias_mes: R.daysInMonth,
    facturacion: r2(facturacion),
    facturacion_sin_iva: r2(base),
    tickets: vd.count,
    ticket_medio: vd.count > 0 ? r2(facturacion / vd.count) : 0,
    productos_vendidos: productos,
    // Si el mes esta a medias, proyectamos para poder comparar
    facturacion_proyectada: R.es_mes_actual && R.day > 0
      ? r2((facturacion / R.day) * R.daysInMonth) : r2(facturacion),
    media_diaria: R.day > 0 ? r2(facturacion / R.day) : 0,
    empleados: top(porEmpleado),
    dias_semana: top(porDiaSemana),
    horas: top(porHora),
  };

  if (R.es_mes_cerrado) CACHE_CERRADO.set(ck, res);
  else cacheSet(ck, res);
  return res;
}

// Genera consejos mirando la evolucion real
function generarConsejos(meses) {
  const consejos = [];
  if (meses.length < 2) return consejos;

  const act = meses[0];
  const ant = meses[1];
  const pct = (a, b) => b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : null;

  // 1. Facturacion
  const varFact = pct(act.facturacion_proyectada, ant.facturacion);
  if (varFact !== null) {
    if (varFact < -10) {
      consejos.push({
        tipo: 'alerta',
        titulo: 'La facturacion esta cayendo',
        texto: `Vas a cerrar un ${Math.abs(varFact)}% por debajo de ${ant.mes_nombre}. Son ${Math.round(ant.facturacion - act.facturacion_proyectada)} euros menos.`,
        accion: 'Revisa si has perdido clientes o si has tenido menos citas. Una campana de reactivacion a los clientes que no vienen desde hace meses suele recuperar parte.',
      });
    } else if (varFact > 10) {
      consejos.push({
        tipo: 'bien',
        titulo: 'La facturacion sube con fuerza',
        texto: `Vas un ${varFact}% por encima de ${ant.mes_nombre}.`,
        accion: 'Mira que has hecho distinto este mes y repitelo. Si viene de un barbero o un servicio concreto, potencialo.',
      });
    }
  }

  // 2. Ticket medio
  const varTicket = pct(act.ticket_medio, ant.ticket_medio);
  if (varTicket !== null && varTicket < -5) {
    consejos.push({
      tipo: 'alerta',
      titulo: 'El ticket medio ha bajado',
      texto: `De ${ant.ticket_medio} a ${act.ticket_medio} euros (${varTicket}%).`,
      accion: 'Se esta vendiendo menos servicio por cliente. Insiste al equipo en ofrecer barba, tratamiento o producto al cerrar la cita.',
    });
  } else if (varTicket !== null && varTicket > 5) {
    consejos.push({
      tipo: 'bien',
      titulo: 'El ticket medio ha subido',
      texto: `De ${ant.ticket_medio} a ${act.ticket_medio} euros (+${varTicket}%).`,
      accion: 'Buena senal: se esta vendiendo mas por cliente. Mantened lo que estais haciendo.',
    });
  }

  // 3. Productos
  if (ant.productos_vendidos > 0) {
    const varProd = pct(act.productos_vendidos, ant.productos_vendidos);
    if (varProd !== null && varProd < -20) {
      consejos.push({
        tipo: 'aviso',
        titulo: 'Se venden menos productos',
        texto: `De ${ant.productos_vendidos} a ${act.productos_vendidos} unidades.`,
        accion: 'La venta de producto es el margen mas alto. Coloca los productos a la vista y recuerda al equipo que los ofrezca.',
      });
    }
  } else if (act.productos_vendidos === 0) {
    consejos.push({
      tipo: 'aviso',
      titulo: 'No se venden productos',
      texto: 'No hay ninguna venta de producto registrada.',
      accion: 'Es el margen mas alto que puedes tener. Empieza con dos o tres productos y un objetivo pequeno por barbero.',
    });
  }

  // 4. El dia mas flojo
  if (act.dias_semana.length >= 3) {
    const flojo = act.dias_semana[act.dias_semana.length - 1];
    const fuerte = act.dias_semana[0];
    if (fuerte.facturacion > flojo.facturacion * 2) {
      consejos.push({
        tipo: 'idea',
        titulo: `Los ${flojo.nombre.toLowerCase()} estan muy flojos`,
        texto: `${flojo.nombre}: ${flojo.facturacion} euros frente a ${fuerte.facturacion} del ${fuerte.nombre.toLowerCase()}.`,
        accion: `Prueba una promocion solo para los ${flojo.nombre.toLowerCase()}, o ajusta el personal ese dia para no pagar horas vacias.`,
      });
    }
  }

  // 5. Diferencias entre el equipo
  if (act.empleados.length >= 2) {
    const mejor = act.empleados[0];
    const peor = act.empleados[act.empleados.length - 1];
    if (mejor.facturacion > peor.facturacion * 2) {
      consejos.push({
        tipo: 'idea',
        titulo: 'Hay mucha diferencia dentro del equipo',
        texto: `${mejor.nombre} lleva ${mejor.facturacion} euros y ${peor.nombre} ${peor.facturacion}.`,
        accion: 'Mira si es por horario o por rendimiento. Si es rendimiento, que el que mas factura ensene lo que hace distinto.',
      });
    }
  }

  // 6. Tendencia de varios meses
  if (meses.length >= 3) {
    const ult = meses.slice(0, 3);
    const bajando = ult[0].facturacion_proyectada < ult[1].facturacion && ult[1].facturacion < ult[2].facturacion;
    const subiendo = ult[0].facturacion_proyectada > ult[1].facturacion && ult[1].facturacion > ult[2].facturacion;
    if (bajando) {
      consejos.push({
        tipo: 'alerta',
        titulo: 'Llevas tres meses bajando',
        texto: `${ult[2].mes_nombre}: ${ult[2].facturacion} -> ${ult[1].mes_nombre}: ${ult[1].facturacion} -> ahora: ${ult[0].facturacion_proyectada}.`,
        accion: 'No es un mal mes suelto, es una tendencia. Merece la pena sentarse a revisar precios, captacion y retencion de clientes.',
      });
    } else if (subiendo) {
      consejos.push({
        tipo: 'bien',
        titulo: 'Tres meses creciendo seguidos',
        texto: `${ult[2].facturacion} -> ${ult[1].facturacion} -> ${ult[0].facturacion_proyectada}.`,
        accion: 'Vas en la buena direccion. Es buen momento para plantearte ampliar horario o incorporar a alguien.',
      });
    }
  }

  return consejos;
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
${d.mes_nombre ? 'Los datos que ves son de ' + d.mes_nombre + (d.es_mes_cerrado ? ' (mes ya cerrado)' : ' (mes en curso)') + '.' : ''}

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
- "rentabilidad": analisis economico por empleado. Se calcula asi:
    Lo que factura  -  (lo que cobra el + la Seguridad Social que paga la empresa)  -  su parte de gastos fijos  =  lo que deja limpio
- OJO: si "el_sueldo_ya_incluye_ss" es true, el importe de la hoja de costes YA incluye la Seguridad Social. NO hay que sumarle nada: ese importe es el coste total para la empresa. El desglose entre lo que cobra el trabajador y la SS es solo informativo.
- "el_cobra_total" es lo que se lleva el empleado. "tu_pagas_seguridad_social" es lo que paga la empresa ADEMAS. "coste_salarial" es la suma de ambos, que es lo que de verdad cuesta. La Seguridad Social solo se aplica sobre la nomina del contrato. Si "horas_adicionales_cotizan" es false, las horas adicionales NO llevan Seguridad Social: 20 horas a 10 euros son 200 euros exactos.
- "horas_adicionales" son horas por encima de su contrato, a "precio_hora_adicional" cada una. Llamalas SIEMPRE "horas adicionales", nunca "horas extra". Si "horas_adicionales_cotizan" es false, esas horas se pagan tal cual sin Seguridad Social: 20 horas a 10 euros cuestan exactamente 200 euros.
- Al comparar empleados con jornadas distintas usa "factura_por_hora" y "margen_por_hora", nunca la facturacion a secas. Menciona siempre las horas de cada uno.
- "de_cada_100_euros_quedan" es facil de entender: de cada 100 euros que factura, cuantos se queda la empresa limpios.
- "punto_muerto" es lo minimo que tiene que facturar para no dar perdidas.
- MUY IMPORTANTE: los COSTES son los REALES del mes completo (sueldo entero y gastos fijos enteros), no prorrateados. Por eso se comparan con "facturacion_proyectada_mes" (a donde llegara a fin de mes si sigue el ritmo actual), que es la comparacion justa.
- "facturado_hasta_hoy" es lo que lleva facturado de verdad ahora mismo. "le_falta_facturar" es lo que le queda para cubrir sus costes del mes, y "falta_por_dia" lo que necesitaria hacer cada dia que queda.
- "margen" compara costes del mes con la proyeccion. "margen_a_dia_de_hoy" compara costes del mes con lo facturado hasta hoy (saldra negativo a principio de mes, es normal).
- Cuando expliques rentabilidad, se claro y usa lenguaje sencillo: nada de tecnicismos innecesarios.
- Mira "rentabilidad.avisos": si alguien esta en "sin_facturacion_en_koibox" es que su nombre en la hoja de costes no coincide con el de Koibox, asi que su margen es enganoso. Avisalo antes de decir que no es rentable. Si hay gente en "facturan_pero_no_estan_en_la_hoja", avisa de que falta anadirlos a la hoja de costes.
- "ventas_sin_barbero_asignado" son ventas cobradas en Koibox sin seleccionar el barbero, que quedan a nombre del centro. No son de ningun empleado. Si preguntan por ellas, explica que hay que asignar el barbero al cobrar en Koibox para que cuenten.
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

// ---------- MANTENERSE DESPIERTO ----------
// Render apaga la app tras 15 min sin visitas y tarda ~50s en volver.
// Un ping a si mismo cada 10 min lo evita, sin coste.
function mantenerDespierto() {
  const url = process.env.RENDER_EXTERNAL_URL || process.env.URL_PUBLICA;
  if (!url) { console.log('Sin URL publica: no se activa el auto-ping'); return; }
  const limpia = url.replace(/\/$/, '');
  setInterval(() => {
    fetch(limpia + '/api/ping')
      .then(() => console.log('Ping ok'))
      .catch(e => console.log('Ping fallo:', e.message));
  }, 10 * 60 * 1000);
  console.log('Auto-ping activado cada 10 min ->', limpia);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.url === '/api/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hora: new Date().toISOString() }));
    return;
  }

  const json = (obj, code) => {
    res.writeHead(code || 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const leerCuerpo = () => new Promise((resolve) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
  });

  // ---------- ENTRAR ----------
  if (req.method === 'POST' && req.url === '/api/login') {
    const body = await leerCuerpo();
    const r = auth.login(body.usuario, body.password);
    if (r.error) return json({ error: r.error }, 401);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': `sesion=${encodeURIComponent(r.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`,
    });
    res.end(JSON.stringify({ ok: true, usuario: r.usuario }));
    return;
  }

  // ---------- SALIR ----------
  if (req.url === '/api/logout') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'sesion=; Path=/; HttpOnly; Max-Age=0',
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const usuario = auth.usuarioDeLaPeticion(req);

  // ---------- QUIEN SOY ----------
  if (req.url === '/api/yo') {
    if (!usuario) return json({ error: 'Sin sesion' }, 401);
    return json({ usuario, roles: auth.ROLES });
  }

  // ---------- GESTION DE USUARIOS (solo admin) ----------
  if (req.url.startsWith('/api/usuarios')) {
    if (!auth.puede(usuario, 'usuarios')) return json({ error: 'No tienes permiso' }, 403);

    if (req.method === 'GET') {
      return json({ usuarios: auth.listarUsuarios(), roles: auth.ROLES });
    }
    if (req.method === 'POST') {
      const b = await leerCuerpo();
      const r = auth.crearUsuario(b);
      return json(r, r.error ? 400 : 200);
    }
    if (req.method === 'PUT') {
      const b = await leerCuerpo();
      const r = auth.editarUsuario(b.usuario, b);
      return json(r, r.error ? 400 : 200);
    }
    if (req.method === 'DELETE') {
      const b = await leerCuerpo();
      const r = auth.borrarUsuario(b.usuario);
      return json(r, r.error ? 400 : 200);
    }
  }

  // ---------- A PARTIR DE AQUI HAY QUE ESTAR DENTRO ----------
  const esApi = req.url.startsWith('/api/');
  const esPublico = req.url.startsWith('/login') || req.url.startsWith('/logo');

  if (!usuario && !esPublico) {
    if (esApi) return json({ error: 'Sin sesion' }, 401);
    // Si no ha entrado, a la pagina de acceso
    fs.readFile(path.join(__dirname, 'login.html'), (e, d) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(d || 'Falta login.html');
    });
    return;
  }

  // Cada seccion pide su permiso
  const permisoDe = {
    '/api/stats': 'panel',
    '/api/query': 'chat',
    '/api/productos': 'productos',
    '/api/rentabilidad': 'rentabilidad',
    '/api/costes': 'rentabilidad',
    '/api/calidad': 'objetivos',
    '/api/comparativa': 'panel',
  };
  for (const [ruta, permiso] of Object.entries(permisoDe)) {
    if (req.url.startsWith(ruta) && !auth.puede(usuario, permiso)) {
      return json({ error: 'No tienes acceso a esta seccion' }, 403);
    }
  }

  // Los diagnosticos, solo el administrador
  if ((req.url.startsWith('/api/debug') || req.url.startsWith('/api/probargastos')) && usuario.rol !== 'admin') {
    return json({ error: 'Solo el administrador' }, 403);
  }


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

  if (req.method === 'GET' && req.url.startsWith('/api/comparativa')) {
    try {
      const p = new URL(req.url, 'http://x').searchParams;
      const local = p.get('local') || 'Sevilla Este';
      const cuantos = Math.min(parseInt(p.get('meses'), 10) || 6, 12);
      const lista = mesesDisponibles(cuantos);

      let resumenes;
      if (local === 'Todos') {
        resumenes = [];
        for (const m of lista) {
          const partes = await Promise.all(
            ['Sevilla Este', 'Bormujos', 'Gines'].map(l => resumenMes(l, m.valor).catch(() => null))
          );
          const ok = partes.filter(Boolean);
          if (!ok.length) continue;
          const s = (campo) => ok.reduce((a, x) => a + (x[campo] || 0), 0);
          const f = Math.round(s('facturacion') * 100) / 100;
          const t = s('tickets');
          resumenes.push({
            mes: m.valor, mes_nombre: m.nombre, es_mes_actual: m.es_actual,
            dias_transcurridos: ok[0].dias_transcurridos, dias_mes: ok[0].dias_mes,
            facturacion: f, tickets: t,
            ticket_medio: t > 0 ? Math.round((f / t) * 100) / 100 : 0,
            productos_vendidos: s('productos_vendidos'),
            facturacion_proyectada: Math.round(s('facturacion_proyectada') * 100) / 100,
            media_diaria: Math.round(s('media_diaria') * 100) / 100,
            empleados: [], dias_semana: [], horas: [],
            por_local: ok.map(x => ({ local: x.mes, facturacion: x.facturacion })),
          });
        }
      } else {
        const res = await Promise.all(lista.map(m => resumenMes(local, m.valor).catch(() => null)));
        resumenes = res.filter(Boolean);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        local,
        meses: resumenes,
        consejos: generarConsejos(resumenes),
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/meses')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ meses: mesesDisponibles(12) }));
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
      DIAGNOSTICO_GASTOS: diagnosticoGastos,
      lo_que_ha_leido: cfg.locales,
    }, null, 2));
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/rentabilidad')) {
    try {
      const p = new URL(req.url, 'http://x').searchParams;
      const local = p.get('local') || 'Sevilla Este';
      const d = await getKoiboxData(local, 'rentabilidad', p.get('mes'));
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
      const p = new URL(req.url, 'http://x').searchParams;
      const local = p.get('local') || 'Sevilla Este';
      const d = await getKoiboxData(local, 'productos', p.get('mes'));
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
      const p = new URL(req.url, 'http://x').searchParams;
      const local = p.get('local') || 'Sevilla Este';
      const d = await getKoiboxData(local, 'facturacion', p.get('mes'));
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
        const { question, local, mes } = JSON.parse(body);
        console.log('Pregunta:', question, '| Local:', local, '| Mes:', mes || 'actual');
        const d = await getKoiboxData(local, question, mes);
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
  mantenerDespierto();
});
