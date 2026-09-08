/**
 * PuntosPorVencer.jsx
 * ────────────────────────────────────────────────────────────────────────
 * Bloque informativo "tus puntos vencen en X días" — parte del rediseño
 * visual "Luxury Charcoal & Gold". El usuario pidió estilizar este bloque
 * (junto con la tarjeta de meta de 15.000 puntos, ver BarraProgresoPuntos)
 * pero no existía todavía como pieza de UI en la app del cliente: la regla
 * de negocio de vigencia de 90 días ya vive en la base de datos
 * (`transacciones_puntos.fecha_vencimiento`, consolidación FIFO) y solo se
 * mencionaba en el texto de Términos y Condiciones (RegistrationForm.jsx).
 *
 * IMPORTANTE — esto es SOLO una lectura de datos que ya existen, para
 * mostrarle al cliente algo que la base de datos ya calcula. No agrega
 * ninguna tabla, columna, RPC ni regla de acumulación/vencimiento nueva:
 * simplemente consulta el lote de puntos más próximo a vencer (columnas
 * reales de `transacciones_puntos`: puntos_restantes, fecha_vencimiento —
 * no existe una columna `vencido` en el esquema documentado del proyecto,
 * así que el filtro de "no vencido todavía" se hace comparando
 * fecha_vencimiento contra la fecha de hoy) y lo muestra. Si no hay ningún
 * lote pendiente por vencer, el componente no renderiza nada (return
 * null) — no inventa datos.
 *
 * Reutiliza las clases .mis-puntos-card / .puntos-vencer-* definidas en
 * BarraProgresoPuntos.css (mismo tratamiento "tarjeta premium negra con
 * filete dorado" en toda la pantalla, sin duplicar CSS). UserDashboard.jsx
 * ya importa BarraProgresoPuntos.css, así que este componente no necesita
 * importar ningún CSS propio.
 */

import { useEffect, useState } from 'react';
import { supabase } from '../services/supabaseClient';

const DIA_MS = 1000 * 60 * 60 * 24;
const UMBRAL_URGENTE_DIAS = 7; // ≤ 7 días: acento rojo en vez de dorado

export function PuntosPorVencer({ clienteId, restauranteId }) {
  const [lote, setLote] = useState(null); // { puntos_restantes, fecha_vencimiento } | null
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    if (!clienteId) { setCargando(false); return; }

    let cancelado = false;
    const cargar = async () => {
      setCargando(true);
      const hoy = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, comparable con fecha_vencimiento (DATE)

      let query = supabase
        .from('transacciones_puntos')
        .select('puntos_restantes, fecha_vencimiento')
        .eq('cliente_id', clienteId)
        .gt('puntos_restantes', 0)
        .not('fecha_vencimiento', 'is', null)
        .gte('fecha_vencimiento', hoy) // solo lotes que todavía no vencieron
        .order('fecha_vencimiento', { ascending: true })
        .limit(1);

      if (restauranteId) query = query.eq('restaurante_id', restauranteId);

      const { data, error } = await query.maybeSingle();
      if (cancelado) return;
      if (error) {
        console.warn('[PuntosPorVencer] No se pudo cargar el próximo vencimiento:', error.message);
        setLote(null);
      } else {
        setLote(data || null);
      }
      setCargando(false);
    };

    cargar();
    return () => { cancelado = true; };
  }, [clienteId, restauranteId]);

  if (cargando || !lote) return null;

  const diasRestantes = Math.max(
    0,
    Math.ceil((new Date(lote.fecha_vencimiento) - new Date()) / DIA_MS)
  );
  const urgente = diasRestantes <= UMBRAL_URGENTE_DIAS;

  return (
    <div className={`mis-puntos-card puntos-vencer-card${urgente ? ' urgente' : ''}`}>
      <div className="puntos-vencer-icono">⏳</div>
      <div className="puntos-vencer-texto">
        <p className="puntos-vencer-cifra">
          <b>{lote.puntos_restantes.toLocaleString('es-CO')} pts</b> vencen pronto
        </p>
        <p className="puntos-vencer-detalle">
          {diasRestantes === 0
            ? 'Vencen hoy — úsalos antes de la medianoche.'
            : `Vigencia de 90 días · te quedan ${diasRestantes} día${diasRestantes === 1 ? '' : 's'}.`}
        </p>
      </div>
    </div>
  );
}
