/**
 * useNotificaciones.js
 * ────────────────────────────────────────────────────────────────────────
 * Hook central del Centro de Notificaciones in-app del cliente. Se
 * instancia UNA sola vez en App.jsx (fuente única de verdad) y se reparte
 * hacia abajo tanto a AppHeader (el puntito dorado con el conteo real de
 * no leídas) como a CentroNotificaciones (la lista completa del drawer) —
 * así evitamos dos consultas/suscripciones duplicadas a Supabase para el
 * mismo dato.
 *
 * Tabla real: `historial_notificaciones` (columnas: id, cliente_id, tipo,
 * titulo, contenido, estado_envio, fecha_envio, leido, leido_en — las dos
 * últimas se agregaron en la migración `centro_notificaciones_leido`,
 * junto con la policy RLS "cliente_marca_sus_notificaciones_leidas" que
 * habilita el UPDATE de abajo).
 *
 * El único proceso que hoy escribe filas reales (con `titulo`) es la Edge
 * Function `alertas-vencimiento-puntos`. Esa misma función también inserta
 * filas de auditoría interna con `tipo='sin_token'` y `titulo`/`contenido`
 * en null cuando el envío push falla — esas NO son notificaciones para el
 * cliente y se excluyen siempre con `.not('titulo', 'is', null)`.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../services/supabaseClient';

const LIMITE = 50;

export function useNotificaciones(clienteId) {
  const [notificaciones, setNotificaciones] = useState([]);
  const [cargando, setCargando] = useState(true);
  const montadoRef = useRef(true);

  const cargar = useCallback(async () => {
    if (!clienteId) {
      setNotificaciones([]);
      setCargando(false);
      return;
    }
    setCargando(true);
    const { data, error } = await supabase
      .from('historial_notificaciones')
      .select('id, tipo, titulo, contenido, fecha_envio, leido')
      .eq('cliente_id', clienteId)
      .not('titulo', 'is', null)
      .order('fecha_envio', { ascending: false })
      .limit(LIMITE);

    if (!montadoRef.current) return;
    if (error) {
      console.warn('[useNotificaciones] No se pudo cargar el historial:', error.message);
      setNotificaciones([]);
    } else {
      setNotificaciones(data || []);
    }
    setCargando(false);
  }, [clienteId]);

  useEffect(() => {
    montadoRef.current = true;
    cargar();
    return () => { montadoRef.current = false; };
  }, [cargar]);

  // Tiempo real: si llega una alerta nueva (ej. de vencimiento de puntos)
  // mientras el cliente tiene la app abierta, el puntito dorado se activa
  // solo, sin que el cliente tenga que recargar la pantalla.
  useEffect(() => {
    if (!clienteId) return;

    const canal = supabase
      .channel(`notificaciones-cliente-${clienteId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'historial_notificaciones', filter: `cliente_id=eq.${clienteId}` },
        (payload) => {
          const fila = payload.new;
          if (!fila || !fila.titulo) return; // fila interna de auditoría (sin_token) — no es una notificación real
          setNotificaciones(prev => [fila, ...prev].slice(0, LIMITE));
        }
      )
      .subscribe();

    return () => supabase.removeChannel(canal);
  }, [clienteId]);

  const marcarTodasLeidas = useCallback(async () => {
    if (!clienteId) return;
    const idsNoLeidas = notificaciones.filter(n => !n.leido).map(n => n.id);
    if (idsNoLeidas.length === 0) return;

    // Optimista: limpiamos el puntito de inmediato, sin esperar la red.
    setNotificaciones(prev => prev.map(n => (idsNoLeidas.includes(n.id) ? { ...n, leido: true } : n)));

    const { error } = await supabase
      .from('historial_notificaciones')
      .update({ leido: true, leido_en: new Date().toISOString() })
      .eq('cliente_id', clienteId)
      .eq('leido', false);

    if (error) {
      console.warn('[useNotificaciones] No se pudo marcar como leídas:', error.message);
      cargar(); // revertimos recargando el estado real desde la base de datos
    }
  }, [clienteId, notificaciones, cargar]);

  const unreadCount = notificaciones.filter(n => !n.leido).length;

  return { notificaciones, cargando, unreadCount, marcarTodasLeidas, recargar: cargar };
}
