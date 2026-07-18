import { useState, useEffect } from 'react';

/**
 * useIOS.js
 * ─────────────────────────────────────────────────────────────────
 * Detecta si el dispositivo es iPhone/iPad y si la app ya está
 * instalada en la pantalla de inicio (modo "standalone").
 *
 * Por qué importa:
 *  - En iOS, Notification.requestPermission() y el push en general
 *    NO funcionan si el usuario solo tiene la pestaña abierta en
 *    Safari — tiene que haber agregado la app a inicio primero.
 *  - En iOS no existe el evento `beforeinstallprompt` de Android,
 *    así que no podemos mostrar un botón "Instalar" automático.
 *    Solo podemos guiar al usuario a hacerlo manualmente
 *    (Compartir → Agregar a pantalla de inicio).
 */
export function useIOS() {
  const [isIOS, setIsIOS] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    const ua = window.navigator.userAgent;

    // Detecta iPhone/iPad/iPod, incluyendo iPadOS 13+ que se identifica
    // como "Macintosh" pero tiene soporte táctil (por eso el chequeo extra).
    const iOS =
      /iPad|iPhone|iPod/.test(ua) ||
      (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);

    // Safari expone navigator.standalone cuando la PWA corre instalada.
    // display-mode: standalone cubre el resto de navegadores/casos.
    const standalone =
      window.navigator.standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches;

    setIsIOS(iOS);
    setIsStandalone(standalone);
  }, []);

  return { isIOS, isStandalone };
}
