import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Verificación de variables de entorno (Evita errores silenciosos en despliegue)
if (!supabaseUrl || !supabaseAnonKey) {
  console.error("❌ Error: Faltan las variables de entorno de Supabase.");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

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

export default supabase;