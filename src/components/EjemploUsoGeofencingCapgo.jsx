/**
 * EjemploUsoGeofencingCapgo.jsx — LoyalPass
 * ────────────────────────────────────────────────────────────────────────
 * Ejemplo de integración del hook useGeofencingCapgo, incluyendo el manejo
 * de UI cuando el usuario rechaza el permiso de ubicación en segundo plano.
 *
 * Este componente es ilustrativo — en tu app real probablemente lo montas
 * dentro de GeofencingProvider.jsx, reemplazando o conviviendo con el
 * useGeofencing (v5.4) que ya tienes, alimentado por los mismos
 * `restaurantesFiltrados` que ya calculas ahí.
 */

import { useEffect } from 'react';
import { useGeofencingCapgo } from '../hooks/useGeofencingCapgo';

export function EjemploUsoGeofencingCapgo({ comerciosDelUsuario }) {
  const { estado, comerciosActivos, iniciar, detener } = useGeofencingCapgo(comerciosDelUsuario);

  useEffect(() => {
    if (comerciosDelUsuario?.length) {
      iniciar(comerciosDelUsuario);
    }
    return () => { detener(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comerciosDelUsuario]);

  // ── Manejo del caso: usuario rechazó el permiso ──────────────────────
  // No lo tratamos como error fatal: la app debe seguir siendo usable
  // (el usuario puede seguir viendo el catálogo, acumulando puntos
  // manualmente al pagar, etc.) — solo se pierde el aviso automático.
  if (estado === 'permiso_denegado') {
    return (
      <div className="aviso-permiso-denegado">
        <p>
          No podemos avisarte automáticamente cuando estés cerca de un
          comercio afiliado porque el permiso de ubicación no fue concedido.
        </p>
        <p>
          Puedes seguir usando la app con normalidad y acumular puntos al
          momento de pagar. Si cambias de opinión, actívalo desde:
        </p>
        <button onClick={() => iniciar(comerciosDelUsuario)}>
          Reintentar activación
        </button>
        <button onClick={abrirAjustesDelSistema}>
          Abrir ajustes de ubicación del teléfono
        </button>
      </div>
    );
  }

  if (estado === 'error') {
    return <p>El aviso de cercanía solo está disponible en la app instalada (no en el navegador web).</p>;
  }

  return (
    <div>
      <p>Estado del geofencing: {estado}</p>
      <p>Comercios monitoreados: {comerciosActivos.length}</p>
    </div>
  );
}

// Si el usuario negó el permiso definitivamente ("No volver a preguntar"
// en Android, o ya respondió antes en iOS), ni setupGeofencing() ni ningún
// re-intento en JS vuelven a mostrar el diálogo nativo — hay que mandarlo
// a Ajustes. Ya tienes `capacitor-native-settings` instalado en el proyecto
// (lo usa BatteryOptimizationGuide.jsx), así que reutilizamos el mismo patrón.
async function abrirAjustesDelSistema() {
  const { NativeSettings, AndroidSettings, IOSSettings } = await import('capacitor-native-settings');
  const { Capacitor } = await import('@capacitor/core');

  try {
    if (Capacitor.getPlatform() === 'android') {
      await NativeSettings.open({ optionAndroid: AndroidSettings.ApplicationDetails });
    } else if (Capacitor.getPlatform() === 'ios') {
      await NativeSettings.open({ optionIOS: IOSSettings.App });
    }
  } catch (err) {
    console.warn('[GeofencingCapgo] No se pudo abrir ajustes del sistema:', err.message);
  }
}
