import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Verificación de variables de entorno (Evita errores silenciosos en despliegue)
if (!supabaseUrl || !supabaseAnonKey) {
  console.error("❌ Error: Faltan las variables de entorno de Supabase.");
}

// ── "Mantener sesión iniciada" ──────────────────────────────────────────────
// Supabase solo permite configurar el storage UNA vez, al crear el cliente
// (no se puede cambiar por-login). Para que el checkbox del login decida
// entre localStorage (sesión persistente) y sessionStorage (se borra al
// cerrar la pestaña), usamos un storage "proxy": Supabase le pide que
// guarde/lea el token, y él revisa esta preferencia para decidir a cuál de
// los dos storages reales escribir.
const CLAVE_PREFERENCIA_SESION = 'loyalpass_mantener_sesion';

export const establecerPreferenciaSesion = (mantener) => {
  window.localStorage.setItem(CLAVE_PREFERENCIA_SESION, mantener ? 'true' : 'false');
};

const storageDinamico = {
  getItem: (key) => window.localStorage.getItem(key) ?? window.sessionStorage.getItem(key),
  setItem: (key, value) => {
    const mantenerSesion = window.localStorage.getItem(CLAVE_PREFERENCIA_SESION) !== 'false';
    if (mantenerSesion) {
      window.localStorage.setItem(key, value);
      window.sessionStorage.removeItem(key);
    } else {
      window.sessionStorage.setItem(key, value);
      window.localStorage.removeItem(key);
    }
  },
  removeItem: (key) => {
    window.localStorage.removeItem(key);
    window.sessionStorage.removeItem(key);
  },
};

// ── Configuración explícita de persistencia de sesión ──────────────────────
// persistSession: true      → guarda el token (en localStorage o sessionStorage,
//                              según storageDinamico de arriba).
// autoRefreshToken: true    → renueva el token automáticamente antes de que
//                              expire, sin pedirle nada al usuario.
// detectSessionInUrl: true  → necesario para el flujo de "recuperar contraseña":
//                              cuando el usuario hace clic en el link del correo,
//                              Supabase regresa a la app con el token en la URL
//                              y esta opción hace que la librería lo detecte y
//                              cree la sesión de recuperación automáticamente.
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: storageDinamico,
  },
});

/**
 * Inserta datos en una tabla específica.
 * @param {string} table - Nombre de la tabla en Supabase.
 * @param {object} data - Objeto con los campos a insertar.
 */
export const addData = async (table, data) => {
  try {
    const { data: result, error } = await supabase
      .from(table)
      .insert([
        { 
          ...data, 
          // Mantenemos tu lógica de timestamp manual
          fecha_registro: new Date().toISOString() 
        }
      ])
      .select(); 

    if (error) {
      // Log detallado para depuración en consola
      console.error(`🔴 Error en tabla [${table}]:`, {
        mensaje: error.message,
        detalles: error.details,
        codigo: error.code,
        ayuda: error.hint
      });
      throw error;
    }

    return result;
  } catch (err) {
    // Captura tanto errores de red como errores lanzados por el bloque anterior
    console.error(`⚠️ Fallo crítico al añadir datos en ${table}:`, err.message);
    throw err;
  }
};

/**
 * NOTA: la función obtenerEmailPorTelefono() se eliminó de aquí — el login
 * ahora es directo con supabase.auth.signInWithPassword({ email, password }),
 * ya no hace falta traducir teléfono → email primero. Si quieres borrar
 * también la función SQL `obtener_email_por_telefono` del lado de Supabase
 * porque ya no la llama nadie, puedes hacerlo, pero dejarla ahí no hace daño.
 */

/**
 * buscarClienteEnRestaurante
 * ────────────────────────────────────────────────────────────────────────
 * SOLO LECTURA — nunca crea ni modifica nada. Verifica si el usuario ya
 * autenticado globalmente (auth_user_id) tiene una fila propia en
 * `clientes` para ESTE restaurante en particular.
 *
 * Esto es lo que separa las dos etapas del registro: tener sesión global
 * (Supabase Auth) NO implica estar inscrito en un restaurante — cada
 * restaurante es una decisión aparte del usuario, tomada a través del
 * formulario "Crea tu perfil" (ver registrarClienteEnRestaurante).
 *
 * Devuelve la fila { id, nombre, puntos } si existe, o null si el usuario
 * todavía no se ha unido a ese restaurante.
 */
export const buscarClienteEnRestaurante = async ({ authUserId, restauranteId }) => {
  const { data, error } = await supabase
    .from('clientes')
    .select('id, nombre, puntos')
    .eq('auth_user_id', authUserId)
    .eq('restaurante_id', restauranteId)
    .maybeSingle();
  if (error) throw error;
  return data; // null → aún no inscrito en este restaurante
};

/**
 * registrarClienteEnRestaurante
 * ────────────────────────────────────────────────────────────────────────
 * Inscribe al usuario autenticado globalmente en UN restaurante puntual.
 * Se llama ÚNICAMENTE cuando el usuario llena y envía a propósito el
 * formulario "Crea tu perfil" (RegistrationForm) — nunca de forma
 * automática — para que tenga control total sobre en qué restaurantes se
 * inscribe.
 *
 * Recibe los datos LOCALES del restaurante (nombre, teléfono, fecha de
 * nacimiento) capturados en ese formulario, y los vincula al auth_id
 * global de la cuenta ya autenticada.
 *
 * Lógica, en orden:
 *   a) Por seguridad, si por alguna carrera de red ya existe una fila para
 *      este mismo par (auth_user_id, restaurante_id), la devolvemos tal
 *      cual en vez de duplicarla.
 *   b) ¿Existe una fila VIEJA (registro rápido pre-login) con el mismo
 *      teléfono en este restaurante, todavía sin auth_user_id? → la
 *      vinculamos (UPDATE) a esta cuenta en vez de duplicarla, así no se
 *      pierden los puntos que ya tenía acumulados antes de crear su cuenta.
 *   c) Si no existe ninguna → creamos una fila nueva con los 2 puntos de
 *      bienvenida.
 *
 * Devuelve la fila { id, nombre, puntos } recién vinculada o creada.
 */
export const registrarClienteEnRestaurante = async ({
  user,            // objeto `user` de supabase.auth (ya autenticado globalmente)
  restauranteId,
  nombre,
  telefono,
  fechaNacimiento,
  referidoPor,
}) => {
  // a) ¿Ya vinculado a este restaurante? (evita duplicados por doble clic/carrera)
  const { data: yaExiste, error: errorExiste } = await supabase
    .from('clientes')
    .select('id, nombre, puntos')
    .eq('auth_user_id', user.id)
    .eq('restaurante_id', restauranteId)
    .maybeSingle();
  if (errorExiste) throw errorExiste;
  if (yaExiste) return yaExiste;

  // b) ¿Fila vieja del registro rápido, mismo teléfono, sin auth todavía?
  if (telefono) {
    const { data: existentePorTelefono, error: errorTel } = await supabase
      .from('clientes')
      .select('id, nombre, puntos')
      .eq('telefono', telefono)
      .eq('restaurante_id', restauranteId)
      .is('auth_user_id', null)
      .maybeSingle();
    if (errorTel) throw errorTel;

    if (existentePorTelefono) {
      const { data: vinculado, error: errorUpdate } = await supabase
        .from('clientes')
        .update({
          auth_user_id:     user.id,
          email:            user.email,
          nombre:           nombre || existentePorTelefono.nombre,
          fecha_nacimiento: fechaNacimiento || null,
        })
        .eq('id', existentePorTelefono.id)
        .select('id, nombre, puntos')
        .single();
      if (errorUpdate) throw errorUpdate;
      return vinculado;
    }
  }

  // c) No existe ninguna fila todavía: se crea desde cero (+2 puntos de bienvenida).
  const { data: nuevoCliente, error: errorInsert } = await supabase
    .from('clientes')
    .insert([{
      nombre,
      telefono,
      fecha_nacimiento: fechaNacimiento,
      email:            user.email,
      auth_user_id:     user.id,
      puntos:           2,
      origen:           'Registro Web (Cuenta)',
      restaurante_id:   restauranteId,
      referidopor:      referidoPor || 'Directo (QR local)',
      fecha_registro:   new Date().toISOString(),
    }])
    .select('id, nombre, puntos')
    .single();
  if (errorInsert) throw errorInsert;

  return nuevoCliente;
};

/**
 * registrarLlegada
 * ────────────────────────────────────────────────────────────────────────
 * Registra en `visitas` que un cliente YA INSCRITO llegó al restaurante vía
 * el flujo de QR — a diferencia de `registrarClienteEnRestaurante` (que crea
 * la relación cliente↔restaurante la primera vez), esta función se llama
 * en CADA escaneo del QR, incluyendo todas las visitas posteriores a la
 * primera. No crea ni modifica la fila de `clientes`.
 *
 * Es "fire and forget" desde la perspectiva de la UI: si falla, no debe
 * bloquear ni interrumpir al cliente (ya está adentro de la app, la
 * llegada es un registro informativo para el restaurante, no un gate).
 * Por eso atrapa su propio error y lo reporta por consola en vez de
 * lanzarlo — quien llama puede ignorar el resultado con confianza.
 */
export const registrarLlegada = async ({ clienteId, restauranteId, origen = 'qr' }) => {
  // Saneamos el payload antes de mandarlo: un restauranteId con espacios,
  // comillas o comas sueltas puede romper el filtro/insert de PostgREST y
  // devolver un 400. trim() + normalización de espacios evita ese caso sin
  // tocar el valor real (no se re-codifica aquí porque supabase-js ya se
  // encarga de escapar la URL — solo limpiamos basura de entrada).
  const payload = {
    cliente_id:     clienteId,
    restaurante_id: typeof restauranteId === 'string' ? restauranteId.trim() : restauranteId,
    origen,               // 'qr' | 'gps' — de dónde vino el check-in
    fecha:          new Date().toISOString(),
  };

  let ok = false;
  try {
    const { error, status, statusText } = await supabase
      .from('visitas')
      .insert([payload]);

    if (error) {
      // Log descriptivo: payload exacto que se mandó + el detalle completo
      // que devuelve Supabase/PostgREST (mensaje, código, hint, status HTTP)
      // — esto es lo que hay que mirar en consola para depurar un 400/500.
      console.error('[registrarLlegada] Falló el insert en `visitas`:', {
        payloadEnviado: payload,
        httpStatus:     status,
        httpStatusText: statusText,
        mensaje:        error.message,
        detalles:       error.details,
        codigo:         error.code,
        ayuda:          error.hint,
      });
    } else {
      ok = true;
    }
  } catch (err) {
    // Errores de red (sin conexión, CORS, etc.) — no vienen del objeto `error`
    // de arriba, sino que rompen la promesa directamente.
    console.error('[registrarLlegada] Fallo de red al registrar la visita:', {
      payloadEnviado: payload,
      error: err?.message || err,
    });
  } finally {
    // Pase lo que pase, esta función NUNCA lanza — es "fire and forget": la
    // llegada es informativa para el restaurante, no debe bloquear ni
    // congelar la UI del cliente si la API falla.
    return ok;
  }
};

export default supabase;