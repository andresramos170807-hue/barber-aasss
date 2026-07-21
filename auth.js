const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ARCHIVO_USUARIOS = path.join(__dirname, 'usuarios.json');

// ---------- ROLES Y PERMISOS ----------
// Cada rol puede ver unas secciones concretas
const ROLES = {
  admin: {
    nombre: 'Administrador',
    descripcion: 'Control total, incluida la gestion de usuarios',
    permisos: ['panel', 'chat', 'empleados', 'productos', 'servicios', 'clientes', 'horas', 'rentabilidad', 'objetivos', 'usuarios'],
    locales: 'todos',
  },
  contabilidad: {
    nombre: 'Contabilidad',
    descripcion: 'Rentabilidad, facturacion y costes de empleados',
    permisos: ['panel', 'chat', 'empleados', 'rentabilidad', 'objetivos'],
    locales: 'todos',
  },
  encargado: {
    nombre: 'Encargado',
    descripcion: 'Horarios, horas y rendimiento del equipo',
    permisos: ['panel', 'chat', 'empleados', 'horas', 'servicios', 'objetivos'],
    locales: 'todos',
  },
  marketing: {
    nombre: 'Marketing',
    descripcion: 'Clientes, productos y servicios',
    permisos: ['panel', 'chat', 'clientes', 'productos', 'servicios', 'horas', 'objetivos'],
    locales: 'todos',
  },
  consulta: {
    nombre: 'Solo consulta',
    descripcion: 'Ver datos basicos sin informacion economica sensible',
    permisos: ['panel', 'servicios', 'horas'],
    locales: 'todos',
  },
};

// ---------- CONTRASENAS ----------
// Nunca se guarda la contrasena, solo un resumen cifrado
function cifrar(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, s, 64).toString('hex');
  return s + ':' + hash;
}

function comprobar(password, guardado) {
  try {
    const [salt, hash] = guardado.split(':');
    const nuevo = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(nuevo, 'hex'));
  } catch (e) { return false; }
}

// ---------- USUARIOS ----------
let usuarios = null;

function usuarioAdminBase() {
  const user = process.env.ADMIN_USUARIO || 'andres';
  const pass = process.env.ADMIN_PASSWORD || 'lebarbier2026';
  return {
    usuario: user.toLowerCase(),
    nombre: 'Administrador',
    rol: 'admin',
    password: cifrar(pass),
    locales: 'todos',
    creado: 'variable de entorno',
    protegido: true,   // no se puede borrar ni cambiar desde el panel
  };
}

function cargarUsuarios() {
  if (usuarios) return usuarios;
  let guardados = [];
  try {
    if (fs.existsSync(ARCHIVO_USUARIOS)) {
      guardados = JSON.parse(fs.readFileSync(ARCHIVO_USUARIOS, 'utf8'));
    }
  } catch (e) { console.log('No se pudieron leer los usuarios:', e.message); }

  const admin = usuarioAdminBase();
  // El admin base siempre existe y manda sobre cualquier otro con su mismo nombre
  usuarios = [admin, ...guardados.filter(u => u.usuario !== admin.usuario)];
  return usuarios;
}

function guardarUsuarios() {
  try {
    const aGuardar = cargarUsuarios().filter(u => !u.protegido);
    fs.writeFileSync(ARCHIVO_USUARIOS, JSON.stringify(aGuardar, null, 2));
    return true;
  } catch (e) {
    console.log('No se pudieron guardar los usuarios:', e.message);
    return false;
  }
}

function buscarUsuario(nombreUsuario) {
  const u = (nombreUsuario || '').toLowerCase().trim();
  return cargarUsuarios().find(x => x.usuario === u) || null;
}

function crearUsuario({ usuario, nombre, password, rol, locales }) {
  const u = (usuario || '').toLowerCase().trim();
  if (!u || !password) return { error: 'Faltan el usuario o la contrasena' };
  if (u.length < 3) return { error: 'El usuario debe tener al menos 3 letras' };
  if (password.length < 6) return { error: 'La contrasena debe tener al menos 6 caracteres' };
  if (!ROLES[rol]) return { error: 'Ese rol no existe' };
  if (buscarUsuario(u)) return { error: 'Ya existe un usuario con ese nombre' };

  const nuevo = {
    usuario: u,
    nombre: (nombre || u).trim(),
    rol,
    password: cifrar(password),
    locales: locales && locales.length ? locales : 'todos',
    creado: new Date().toISOString().split('T')[0],
  };
  cargarUsuarios().push(nuevo);
  guardarUsuarios();
  return { ok: true, usuario: publico(nuevo) };
}

function editarUsuario(nombreUsuario, cambios) {
  const u = buscarUsuario(nombreUsuario);
  if (!u) return { error: 'No existe ese usuario' };
  if (u.protegido) return { error: 'El administrador principal se cambia desde Render, no desde aqui' };

  if (cambios.nombre) u.nombre = cambios.nombre.trim();
  if (cambios.rol) {
    if (!ROLES[cambios.rol]) return { error: 'Ese rol no existe' };
    u.rol = cambios.rol;
  }
  if (cambios.locales) u.locales = cambios.locales.length ? cambios.locales : 'todos';
  if (cambios.password) {
    if (cambios.password.length < 6) return { error: 'La contrasena debe tener al menos 6 caracteres' };
    u.password = cifrar(cambios.password);
  }
  guardarUsuarios();
  return { ok: true, usuario: publico(u) };
}

function borrarUsuario(nombreUsuario) {
  const lista = cargarUsuarios();
  const i = lista.findIndex(x => x.usuario === (nombreUsuario || '').toLowerCase());
  if (i === -1) return { error: 'No existe ese usuario' };
  if (lista[i].protegido) return { error: 'No se puede borrar el administrador principal' };
  lista.splice(i, 1);
  guardarUsuarios();
  return { ok: true };
}

// Datos del usuario sin la contrasena
function publico(u) {
  return {
    usuario: u.usuario,
    nombre: u.nombre,
    rol: u.rol,
    rol_nombre: ROLES[u.rol] ? ROLES[u.rol].nombre : u.rol,
    permisos: ROLES[u.rol] ? ROLES[u.rol].permisos : [],
    locales: u.locales,
    creado: u.creado,
    protegido: !!u.protegido,
  };
}

function listarUsuarios() {
  return cargarUsuarios().map(publico);
}

// ---------- SESIONES ----------
const SECRETO = process.env.SECRETO_SESION || crypto.randomBytes(32).toString('hex');
const DURACION = 12 * 60 * 60 * 1000; // 12 horas

function crearSesion(usuario) {
  const caduca = Date.now() + DURACION;
  const datos = `${usuario}|${caduca}`;
  const firma = crypto.createHmac('sha256', SECRETO).update(datos).digest('hex');
  return Buffer.from(`${datos}|${firma}`).toString('base64');
}

function leerSesion(token) {
  try {
    const texto = Buffer.from(token, 'base64').toString();
    const [usuario, caduca, firma] = texto.split('|');
    const esperada = crypto.createHmac('sha256', SECRETO).update(`${usuario}|${caduca}`).digest('hex');
    if (firma !== esperada) return null;
    if (Date.now() > parseInt(caduca, 10)) return null;
    const u = buscarUsuario(usuario);
    return u ? publico(u) : null;
  } catch (e) { return null; }
}

// Saca la sesion de la peticion
function usuarioDeLaPeticion(req) {
  const cookies = req.headers.cookie || '';
  const m = cookies.match(/sesion=([^;]+)/);
  if (!m) return null;
  return leerSesion(decodeURIComponent(m[1]));
}

function puede(usuario, permiso) {
  if (!usuario) return false;
  return (usuario.permisos || []).includes(permiso);
}

function login(nombreUsuario, password) {
  const u = buscarUsuario(nombreUsuario);
  if (!u) return { error: 'Usuario o contrasena incorrectos' };
  if (!comprobar(password, u.password)) return { error: 'Usuario o contrasena incorrectos' };
  return { ok: true, token: crearSesion(u.usuario), usuario: publico(u) };
}

module.exports = {
  ROLES, login, crearUsuario, editarUsuario, borrarUsuario,
  listarUsuarios, usuarioDeLaPeticion, puede, publico, buscarUsuario,
};
