/**
 * PuntosPorVencer.jsx
 * ────────────────────────────────────────────────────────────────────────
 * Bloque informativo "tus puntos vencen en X días" — parte del rediseño
 * visual "Luxury Charcoal & Gold".
 *
 * FIX (banner 100% dinámico vía RPC, en vez de calcularlo en el frontend):
 * la versión anterior leía UNA sola fila de `transacciones_puntos` (la de
 * fecha_vencimiento más próxima) y mostraba su `puntos_restantes` tal cual.
 * Eso era un bug real de fondo: como la consolidación mensual agrupa TODO
 * lo ganado en un mes calendario bajo la MISMA fecha_vencimiento (bono de
 * bienvenida + consumos + geocerca, cada uno su propia fila en el Ledger),
 * si el cliente tenía más de una fila con esa fecha el banner solo contaba
 * una de ellas — mostraba menos puntos de los que realmente iban a vencer.
 * Ahora la cuenta se hace en la base de datos, vía la función
 * `fn_obtener_puntos_por_vencer(p_cliente_id, p_restaurante_id)`, que SUMA
 * todas las filas del lote más próximo (además de calcular los días
 * restantes con la hora real del servidor, no la del teléfono del
 * cliente). El frontend ya no repite esa lógica de negocio — solo pinta lo
 * que la función devuelve.
 *
 * FIX (texto "Vigencia de 90 días" contradecía los días mostrados): por la
 * regla de consolidación mensual (los 90 días de vigencia empiezan a correr
 * recién el ÚLTIMO día del mes en que se ganaron los puntos, no el día en
 * que se ganaron), `diasRestantes` es CASI SIEMPRE mayor a 90 — solo baja de
 * 90 una vez que el mes ya se consolidó. El texto viejo decía siempre
 * "Vigencia de 90 días · te quedan 111 días", por ejemplo, que se lee como
 * una contradicción para el cliente aunque el número esté bien calculado.
 * Se quita la mención fija a "90 días" y se deja solo el conteo real.
 *
 * Reutiliza las clases .mis-puntos-card / .puntos-vencer-* definidas en
 * BarraProgresoPuntos.css (mismo tratamiento "tarjeta premium negra con
 * filete dorado" en toda la pantalla, sin duplicar CSS). UserDashboard.jsx
 * ya importa BarraProgresoPuntos.css, así que este componente no necesita
 * importar ningún CSS propio.
 *
 * REACTIVIDAD (Supabase Realtime): este componente hace su propia consulta,
 * separada de la de UserDashboard.jsx/cargarPuntos — así que un refresh de
 * saldo en el dashboard no le llega solo. Se suscribe él mismo a los INSERT
 * de `transacciones_puntos` de este cliente y vuelve a llamar la RPC cuando
 * llega uno, para que "X pts vencen pronto" quede al día sin recargar la
 * pantalla (ej. si el nuevo consumo generó un lote que vence antes que el
 * que se estaba mostrando).
 */

import { useEffect, useState } from 'react';
import { supabase } from '../services/supabaseClient';

const UMBRAL_URGENTE_DIAS = 7; // ≤ 7 días: acento rojo en vez de dorado

export function PuntosPorVencer({ clienteId, restauranteId }) {
  // { puntos_por_vencer, dias_restantes, fecha_vencimiento } | null mientras carga
  const [datos, setDatos] = useState(null);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    if (!clienteId || !restauranteId) { setCargando(false); return; }

    let cancelado = false;
    const cargar = async () => {
      setCargando(true);
      const { data, error } = await supabase.rpc('fn_obtener_puntos_por_vencer', {
        p_cliente_id: clienteId,
        p_restaurante_id: restauranteId,
      });
      if (cancelado) return;
      if (error) {
        console.warn('[PuntosPorVencer] No se pudo cargar el próximo vencimiento:', error.message);
        setDatos(null);
      } else {
        setDatos(data || null);
      }
      setCargando(false);
    };

    cargar();

    // Realtime: cualquier movimiento nuevo del Ledger para este cliente
    // (consumo, geocerca, bono o redención) puede cambiar cuál es el lote
    // más próximo a vencer, así que se vuelve a consultar.
    const canal = supabase
      .channel(`realtime-vencimiento-${clienteId}`)
      .on(
        'postgres_changes',
        {
          event:  'INSERT',
          schema: 'public',
          table:  'transacciones_puntos',
          filter: `cliente_id=eq.${clienteId}`,
        },
        () => { cargar(); }
      )
      .subscribe();

    return () => {
      cancelado = true;
      supabase.removeChannel(canal);
    };
  }, [clienteId, restauranteId]);

  if (cargando) return null;

  // Sin lote por vencer (RPC devolvió puntos_por_vencer = 0, o falló la
  // carga): no mostramos la tarjeta — un estado neutral aquí sería más
  // ruido que información útil, y coincide con el resto de tarjetas
  // condicionales de esta pantalla (ej. GuiaPermisosBanner).
  if (!datos || !datos.puntos_por_vencer) return null;

  const { puntos_por_vencer: puntosPorVencer, dias_restantes: diasRestantes } = datos;
  const urgente = diasRestantes <= UMBRAL_URGENTE_DIAS;

  return (
    <div className={`mis-puntos-card puntos-vencer-card${urgente ? ' urgente' : ''}`}>
      <div className="puntos-vencer-icono">⏳</div>
      <div className="puntos-vencer-texto">
        <p className="puntos-vencer-cifra">
          <b>{puntosPorVencer.toLocaleString('es-CO')} pts</b> vencen pronto
        </p>
        <p className="puntos-vencer-detalle">
          {diasRestantes === 0
            ? 'Vencen hoy — úsalos antes de la medianoche.'
            : `Te quedan ${diasRestantes} día${diasRestantes === 1 ? '' : 's'} para usarlos.`}
        </p>
      </div>
    </div>
  );
}
