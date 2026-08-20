import { useState, useEffect, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { NativeSettings, AndroidSettings, IOSSettings } from 'capacitor-native-settings';

/**
 * BatteryOptimizationGuide.jsx — LoyalPass
 * ────────────────────────────────────────────────────────────────────────
 * CONTEXTO: fabricantes como Xiaomi (MIUI), Samsung, Huawei y OnePlus corren
 * sus propios "ahorradores de batería" agresivos por encima del Doze mode
 * estándar de Android. Estos frecuentemente MATAN el proceso en background
 * que hace el geofencing (BackgroundGeolocation), sin avisarle al usuario —
 * simplemente deja de llegarle la notificación de "estás cerca de X".
 *
 * Este componente le explica al usuario, en un momento sensato (justo
 * después de que aceptó los permisos de ubicación y arrancó el rastreo
 * nativo), que además necesita "liberar" la app de esos ahorradores
 * agresivos — con un botón directo a ajustes y otro a una guía específica
 * de su marca de celular.
 *
 * ⚠️ DECISIÓN DE DISEÑO IMPORTANTE — por qué NO uso
 * requestIgnoreBatteryOptimization() aquí:
 * Existe un plugin (@capawesome-team/capacitor-android-battery-optimization)
 * que puede lanzar DIRECTAMENTE el diálogo del sistema "¿Permitir que esta
 * app ignore la optimización de batería?" con una sola llamada. Suena
 * mejor, pero Google Play PROHÍBE ese atajo salvo que la función principal
 * de tu app se vea afectada sin él — y aunque geofencing probablemente
 * calificaría, es una zona gris que Google revisa caso por caso y puede
 * resultar en rechazo de la app. Por eso este componente usa el camino
 * seguro: abrir la PANTALLA de ajustes de batería (donde el usuario mismo
 * busca y activa LoyalPass), vía `capacitor-native-settings` — esto no
 * requiere ningún permiso especial ni entra en la zona restringida de la
 * política de Play. Si más adelante confirman que el rechazo no es un
 * riesgo real para su caso, migrar al otro plugin es un cambio pequeño.
 *
 * Instalación necesaria (una sola vez):
 *   npm install capacitor-native-settings
 *   npx cap sync
 *
 * Integración: se monta en App.jsx (o donde vive el layout raíz) y se
 * auto-controla con localStorage — no necesita que nadie más lo dispare
 * manualmente, aunque `useMostrarGuiaBateria` queda exportado por si
 * quieres, por ejemplo, un botón "Ver de nuevo" en Ajustes de la app.
 */

const CLAVE_DESCARTE = 'loyalpass_battery_guide_dismissed';
const DIAS_RECORDAR_DESPUES = 3;

// ── Guías por marca en dontkillmyapp.com ────────────────────────────────
// El sitio soporta ?app=<nombre> para que el texto de la guía mencione tu
// app por nombre en vez de quedar genérico.
const MARCAS = [
  { id: 'xiaomi',  label: 'Xiaomi / Redmi / POCO' },
  { id: 'samsung', label: 'Samsung' },
  { id: 'huawei',  label: 'Huawei / Honor' },
  { id: 'oneplus', label: 'OnePlus' },
  { id: 'oppo',    label: 'Oppo / Realme' },
  { id: 'vivo',    label: 'Vivo' },
];

const urlGuiaMarca = (marcaId) =>
  marcaId
    ? `https://dontkillmyapp.com/${marcaId}?app=LoyalPass`
    : 'https://dontkillmyapp.com/?app=LoyalPass';

/**
 * Abre la pantalla nativa de ajustes de batería (Android) o de la app
 * (iOS — Apple solo permite abrir la pantalla de ajustes de LA APP, nada
 * más específico, así que ahí mandamos ahí directo: el usuario entra a
 * "Actualización en segundo plano" desde ahí mismo).
 * Exportada por si la quieres reusar en otro botón fuera de este banner.
 */
export const abrirAjustesBateria = async () => {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    if (Capacitor.getPlatform() === 'android') {
      await NativeSettings.openAndroid({ option: AndroidSettings.BatteryOptimization });
    } else {
      await NativeSettings.openIOS({ option: IOSSettings.App });
    }
    return true;
  } catch (err) {
    console.warn('[BatteryOptimizationGuide] No se pudo abrir ajustes:', err.message);
    return false;
  }
};

/** Hook: decide si corresponde mostrar el aviso ahora mismo. */
export const useMostrarGuiaBateria = () => {
  const [mostrar, setMostrar] = useState(false);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return; // solo tiene sentido en la app empaquetada

    try {
      const guardado = JSON.parse(localStorage.getItem(CLAVE_DESCARTE) || 'null');
      if (guardado?.permanente) return;                     // "No preguntar de nuevo"
      if (guardado?.hasta && Date.now() < guardado.hasta) return; // "Recordarme después" — todavía no toca
      setMostrar(true);
    } catch {
      setMostrar(true);
    }
  }, []);

  return [mostrar, setMostrar];
};

export function BatteryOptimizationGuide() {
  const [mostrar, setMostrar]     = useMostrarGuiaBateria();
  const [marcaElegida, setMarca]  = useState(null);

  const descartarTemporal = useCallback(() => {
    const hasta = Date.now() + DIAS_RECORDAR_DESPUES * 24 * 60 * 60 * 1000;
    localStorage.setItem(CLAVE_DESCARTE, JSON.stringify({ permanente: false, hasta }));
    setMostrar(false);
  }, [setMostrar]);

  const descartarPermanente = useCallback(() => {
    localStorage.setItem(CLAVE_DESCARTE, JSON.stringify({ permanente: true }));
    setMostrar(false);
  }, [setMostrar]);

  if (!mostrar) return null;

  return (
    <div style={estilos.overlay} role="dialog" aria-modal="true">
      <div style={estilos.card}>
        <div style={estilos.iconoWrap}>🔋</div>

        <h2 style={estilos.titulo}>Para que no te falten avisos</h2>
        <p style={estilos.texto}>
          Muchos celulares (Xiaomi, Samsung, Huawei, OnePlus...) traen un "ahorrador de batería"
          que puede cerrar LoyalPass en segundo plano sin avisarte — y entonces dejarías de
          recibir el aviso cuando estás cerca de un restaurante.
        </p>
        <p style={estilos.texto}>
          Te toma menos de un minuto evitarlo: solo activa el <strong>Inicio automático</strong> y
          desactiva la optimización de batería para LoyalPass.
        </p>

        {/* Selector de marca — cambia el link de la guía */}
        <div style={estilos.marcasWrap}>
          {MARCAS.map((m) => (
            <button
              key={m.id}
              onClick={() => setMarca(m.id)}
              style={{
                ...estilos.chipMarca,
                ...(marcaElegida === m.id ? estilos.chipMarcaActiva : {}),
              }}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div style={estilos.botonesAccion}>
          <button style={estilos.btnPrimario} onClick={abrirAjustesBateria}>
            🔧 Abrir ajustes de batería
          </button>
          <a
            href={urlGuiaMarca(marcaElegida)}
            target="_blank"
            rel="noopener noreferrer"
            style={estilos.btnSecundario}
          >
            📖 Ver guía {marcaElegida ? `de mi marca` : '(dontkillmyapp.com)'}
          </a>
        </div>

        <div style={estilos.botonesDescarte}>
          <button style={estilos.linkTenue} onClick={descartarTemporal}>Recordarme después</button>
          <button style={estilos.linkTenue} onClick={descartarPermanente}>No volver a mostrar</button>
        </div>
      </div>
    </div>
  );
}

/* ── Estilos (mismo patrón inline que el resto de la app) ─────────────── */
const estilos = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 1000,
    background: 'rgba(0,0,0,0.55)',
    display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    padding: 0,
  },
  card: {
    width: '100%', maxWidth: 480,
    background: 'var(--bg-card, #fff)',
    borderRadius: '20px 20px 0 0',
    padding: '24px 20px 20px',
    boxShadow: '0 -4px 24px rgba(0,0,0,0.2)',
  },
  iconoWrap: { fontSize: '2rem', marginBottom: 4 },
  titulo: {
    fontFamily: 'var(--font-display, inherit)', fontWeight: 800,
    fontSize: '1.15rem', color: 'var(--text-h, #1a1a1a)', margin: '0 0 8px',
  },
  texto: {
    fontSize: '0.85rem', lineHeight: 1.5, color: 'var(--text, #444)',
    opacity: 0.9, margin: '0 0 10px',
  },
  marcasWrap: {
    display: 'flex', flexWrap: 'wrap', gap: '6px', margin: '10px 0 14px',
  },
  chipMarca: {
    padding: '6px 12px', fontSize: '0.75rem', borderRadius: 999,
    border: '1.5px solid var(--border, #e0e0e0)', background: 'transparent',
    color: 'var(--text, #444)', cursor: 'pointer',
  },
  chipMarcaActiva: {
    borderColor: 'var(--coral, #E8563A)',
    background: 'rgba(232,86,58,0.1)',
    color: 'var(--coral, #E8563A)',
    fontWeight: 700,
  },
  botonesAccion: { display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px' },
  btnPrimario: {
    padding: '13px', fontSize: '0.88rem', fontWeight: 700,
    background: 'var(--coral, #E8563A)', color: '#fff', border: 'none',
    borderRadius: 'var(--r-md, 10px)', cursor: 'pointer',
  },
  btnSecundario: {
    padding: '13px', fontSize: '0.85rem', fontWeight: 600, textAlign: 'center',
    background: 'transparent', color: 'var(--coral, #E8563A)',
    border: '1.5px solid var(--coral, #E8563A)', borderRadius: 'var(--r-md, 10px)',
    textDecoration: 'none', display: 'block',
  },
  botonesDescarte: {
    display: 'flex', justifyContent: 'space-between', paddingTop: 4,
  },
  linkTenue: {
    background: 'none', border: 'none', fontSize: '0.75rem',
    color: 'var(--text, #888)', opacity: 0.65, cursor: 'pointer', padding: '4px',
    textDecoration: 'underline',
  },
};
