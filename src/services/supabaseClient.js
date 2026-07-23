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
const CLAVE_PREFERENCIA_SESION = 'bistro_mantener_sesion';

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
 * vincularClienteConRestaurante
 * ────────────────────────────────────────────────────────────────────────
 * Punto único que conecta "un usuario de Supabase Auth ya autenticado" con
 * "una fila de la tabla clientes para UN restaurante en particular".
 * Se reutiliza en dos momentos distintos:
 *   1) Justo después de crear una cuenta nueva (AuthScreen → "Crear cuenta").
 *   2) Cuando la app detecta una sesión ya activa (persistida) y el usuario
 *      abre el enlace de un restaurante donde todavía no tenía fila creada
 *      (App.jsx). Esto cubre el caso "cliente multi-sede": mismo login,
 *      distinto restaurante.
 *
 * Lógica, en orden:
 *   a) ¿Ya existe una fila clientes con este auth_user_id en este
 *      restaurante? → la devolvemos tal cual, sin tocar puntos.
 *   b) ¿Existe una fila VIEJA (registro rápido pre-login) con el mismo
 *      teléfono en este restaurante, todavía sin auth_user_id? → la
 *      vinculamos (UPDATE) a esta cuenta en vez de duplicarla. Así no se
 *      pierden los puntos que el cliente ya había acumulado antes de crear
 *      su cuenta con contraseña.
 *   c) Si no existe ninguna → creamos una fila nueva con los 2 puntos de
 *      bienvenida, igual que hacía el formulario de registro original.
 *
 * Devuelve { cliente, esNuevoRegistro } para que quien la llame sepa si
 * debe mostrar la pantalla de bienvenida (SuccessCard) con puntos nuevos.
 */
export const vincularClienteConRestaurante = async ({
  user,            // objeto `user` de supabase.auth (ya autenticado)
  restauranteId,
  referidoPor,
}) => {
  const nombre   = user.user_metadata?.nombre || 'Cliente';
  // El teléfono es obligatorio en el registro (AuthScreen lo valida antes de
  // llamar signUp) y viaja en user_metadata; solo queda null para cuentas
  // muy viejas que se hayan creado antes de este cambio.
  const telefono = user.user_metadata?.telefono || null;

  // a) ¿Ya vinculado a este restaurante?
  const { data: existentePorAuth, error: errorAuth } = await supabase
    .from('clientes')
    .select('id, nombre, puntos')
    .eq('auth_user_id', user.id)
    .eq('restaurante_id', restauranteId)
    .maybeSingle();
  if (errorAuth) throw errorAuth;
  if (existentePorAuth) {
    return { cliente: existentePorAuth, esNuevoRegistro: false };
  }

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
        .update({ auth_user_id: user.id, email: user.email })
        .eq('id', existentePorTelefono.id)
        .select('id, nombre, puntos')
        .single();
      if (errorUpdate) throw errorUpdate;
      return { cliente: vinculado, esNuevoRegistro: false };
    }
  }

  // c) No existe ninguna fila todavía: se crea desde cero (+2 puntos de bienvenida).
  const { data: nuevoCliente, error: errorInsert } = await supabase
    .from('clientes')
    .insert([{
      nombre,
      telefono,
      email:           user.email,
      auth_user_id:    user.id,
      puntos:          2,
      origen:          'Registro Web (Cuenta)',
      restaurante_id:  restauranteId,
      referidopor:     referidoPor || 'Directo (QR local)',
      fecha_registro:  new Date().toISOString(),
    }])
    .select('id, nombre, puntos')
    .single();
  if (errorInsert) throw errorInsert;

  return { cliente: nuevoCliente, esNuevoRegistro: true };
};

export default supabase;