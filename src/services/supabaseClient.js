import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Verificación de variables de entorno (Evita errores silenciosos en despliegue)
if (!supabaseUrl || !supabaseAnonKey) {
  console.error("❌ Error: Faltan las variables de entorno de Supabase.");
}

// ── Configuración explícita de persistencia de sesión ──────────────────────
// persistSession: true      → guarda el token en localStorage (así el login
//                              sobrevive a cerrar/reabrir el navegador o la PWA).
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
 * obtenerEmailPorTelefono
 * ────────────────────────────────────────────────────────────────────────
 * Dado un número de teléfono, devuelve el email de la cuenta asociada
 * (o null si ese teléfono no tiene cuenta creada todavía).
 * Internamente llama a la función SQL `obtener_email_por_telefono`
 * (ver migración 20260723000000_client_auth_persistente.sql) en vez de
 * consultar la tabla `clientes` directamente, para no exponer el resto
 * de columnas de esa tabla a un usuario que aún no inició sesión.
 * Se usa en AuthScreen.jsx dentro del flujo "Ingresar con Teléfono".
 */
export const obtenerEmailPorTelefono = async (telefono) => {
  const { data, error } = await supabase.rpc('obtener_email_por_telefono', {
    p_telefono: telefono.trim(),
  });
  if (error) {
    console.error('🔴 Error buscando email por teléfono:', error.message);
    throw error;
  }
  return data; // string (email) o null
};

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
  const nombre   = user.user_metadata?.nombre   || 'Cliente';
  const telefono = user.user_metadata?.telefono || '';

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