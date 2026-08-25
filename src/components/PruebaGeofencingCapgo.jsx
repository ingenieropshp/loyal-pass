/**
 * PruebaGeofencingCapgo.jsx — LoyalPass
 * ────────────────────────────────────────────────────────────────────────
 * SOLO PARA PRUEBAS (Opción A). Este componente:
 *  1. Lee los restaurantes reales que YA carga tu GeofencingProvider
 *     (Supabase → tablas `conexion` + `configuracion`), vía el contexto
 *     que ya expone `useGeofencingContext()`.
 *  2. Los convierte al shape que espera useGeofencingCapgo:
 *       tuyo (GeofencingProvider):  { restaurante_id, nombre, latitud, longitud, radio_aviso }
 *       esperado (useGeofencingCapgo): { id, nombre, latitude, longitude, radius }
 *  3. Monta EjemploUsoGeofencingCapgo con esos datos reales — así probás
 *     el flujo completo sin tocar tu hook v5.4 ni GeofencingProvider.jsx.
 *
 * Una vez que confirmes que las notificaciones llegan bien, este archivo
 * se BORRA (o se comenta su uso en App.jsx) — no es parte de la
 * integración final, es solo el arnés de prueba.
 */

import { useGeofencingContext } from './GeofencingProvider';
import { EjemploUsoGeofencingCapgo } from './EjemploUsoGeofencingCapgo';

export function PruebaGeofencingCapgo() {
  const { restaurantes } = useGeofencingContext();

  const comerciosMapeados = restaurantes.map(r => ({
    id:        r.restaurante_id,
    nombre:    r.nombre,
    latitude:  r.latitud,
    longitude: r.longitud,
    radius:    r.radio_aviso || 100,
  }));

  if (comerciosMapeados.length === 0) {
    return <p style={{ padding: 12, fontSize: 12 }}>[Prueba Capgo] Sin restaurantes cargados todavía…</p>;
  }

  return (
    <div style={{ border: '2px dashed orange', padding: 12, margin: 12 }}>
      <p style={{ fontSize: 12, fontWeight: 'bold' }}>🧪 ARNÉS DE PRUEBA — Geofencing Capgo</p>
      <EjemploUsoGeofencingCapgo comerciosDelUsuario={comerciosMapeados} />
    </div>
  );
}
