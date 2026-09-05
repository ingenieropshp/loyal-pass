// supabase/functions/alertas-vencimiento-puntos/index.ts
//
// Envía notificaciones push a clientes cuyos puntos vencerán en ~30 días,
// segmentadas según SALDO TOTAL ACTUAL (no solo el lote por vencer):
//   - Grupo A (saldo_actual >= 15.000): ya puede redimir → invitación directa
//   - Grupo B (saldo_actual <  15.000): aún no califica → incentivo a comprar
//
// Pensada para correr mensualmente vía pg_cron + pg_net.
//
// Variables de entorno requeridas (Project Settings → Edge Functions → Secrets):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   FCM_SERVICE_ACCOUNT_JSON   -> JSON completo de la cuenta de servicio Firebase
//   FCM_PROJECT_ID             -> project_id de Firebase

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SignJWT, importPKCS8 } from "https://esm.sh/jose@5";

const MINIMO_REDENCION = 15000;
const LOTE_ENVIO = 300; // clientes procesados en paralelo por tanda

// Acepta el secreto como JSON crudo o como base64 del JSON (recomendado en
// Windows/PowerShell, donde pegar un JSON completo con comillas y saltos de
// línea dentro de un string de shell es propenso a errores de escape).
function decodificarServiceAccount(raw: string): Record<string, string> {
  const valor = raw.trim();
  if (valor.startsWith("{")) return JSON.parse(valor);

  const binario = atob(valor);
  const bytes = Uint8Array.from(binario, (c) => c.charCodeAt(0));
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json);
}

// ── Autenticación con Firebase (FCM HTTP v1) ─────────────────────────────────
async function obtenerTokenAccesoFCM(secretoCrudo: string): Promise<string> {
  const cuenta = decodificarServiceAccount(secretoCrudo);
  const clavePrivada = await importPKCS8(cuenta.private_key, "RS256");

  const jwt = await new SignJWT({
    scope: "https://www.googleapis.com/auth/firebase.messaging",
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuedAt()
    .setIssuer(cuenta.client_email)
    .setSubject(cuenta.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setExpirationTime("1h")
    .sign(clavePrivada);

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!resp.ok) throw new Error(`No se pudo obtener token FCM: ${await resp.text()}`);
  const data = await resp.json();
  return data.access_token as string;
}

async function enviarPushFCM(
  accessToken: string,
  projectId: string,
  tokenDispositivo: string,
  titulo: string,
  cuerpo: string,
) {
  const resp = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: { token: tokenDispositivo, notification: { title: titulo, body: cuerpo } },
      }),
    },
  );
  const data = await resp.json().catch(() => null);
  return { ok: resp.ok, status: resp.status, data };
}

// ── Plantillas de mensaje por segmento ───────────────────────────────────────
// El texto usa total_por_vencer (lo puntual en riesgo, genera urgencia real);
// la bifurcación y el "faltante" usan saldo_actual (elegibilidad real de FIFO).
function construirMensajeGrupoA(nombre: string, totalPorVencer: number) {
  return {
    titulo: "⏳ ¡Aprovecha tus puntos antes de que venzan!",
    mensaje:
      `Hola ${nombre}, tienes ${totalPorVencer.toLocaleString("es-CO")} puntos ` +
      `($${totalPorVencer.toLocaleString("es-CO")} COP) listos para usar que vencerán pronto. ` +
      `Recuerda que puedes pagar total o parcialmente tus consumos en el restaurante. ` +
      `¡Ven hoy mismo y redímelos en caja!`,
  };
}

function construirMensajeGrupoB(nombre: string, totalPorVencer: number, faltantes: number) {
  return {
    titulo: "💡 ¡Estás muy cerca de desbloquear tu descuento!",
    mensaje:
      `Hola ${nombre}, tienes ${totalPorVencer.toLocaleString("es-CO")} puntos acumulados ` +
      `próximos a vencer. Recuerda que al llegar a ${MINIMO_REDENCION.toLocaleString("es-CO")} ` +
      `puntos podrás usarlos como dinero real en el restaurante. ¡Te faltan solo ` +
      `${faltantes.toLocaleString("es-CO")} puntos! Visítanos este mes, acumula con tu visita ` +
      `y compra física, y salva tu saldo.`,
  };
}

type ClienteEnRiesgo = {
  cliente_id: string;
  nombre: string;
  saldo_actual: number;
  total_por_vencer: number;
  token_dispositivo: string | null;
};

Deno.serve(async (req) => {
  const auth = req.headers.get("Authorization") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (auth !== `Bearer ${serviceKey}`) {
    return new Response("No autorizado", { status: 401 });
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);

  const { data: clientes, error } = await supabase.rpc("fn_clientes_puntos_por_vencer");

  if (error) {
    console.error("Error consultando fn_clientes_puntos_por_vencer:", error);
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 });
  }

  if (!clientes || clientes.length === 0) {
    return new Response(JSON.stringify({ ok: true, procesados: 0 }), { status: 200 });
  }

  let accessToken: string;
  try {
    accessToken = await obtenerTokenAccesoFCM(Deno.env.get("FCM_SERVICE_ACCOUNT_JSON")!);
  } catch (err) {
    console.error("No se pudo autenticar contra FCM:", err);
    return new Response(JSON.stringify({ ok: false, error: "auth_fcm_fallida" }), { status: 500 });
  }

  const projectId = Deno.env.get("FCM_PROJECT_ID")!;
  const registros: Record<string, unknown>[] = [];
  // fecha_vencimiento es timestamptz: usamos timestamps completos (no solo la
  // fecha) para no cortar el límite superior a medianoche UTC y descartar
  // horas válidas del último día de la ventana.
  const ahoraISO = new Date().toISOString();
  const limiteVencimiento = new Date();
  limiteVencimiento.setDate(limiteVencimiento.getDate() + 30);
  const limiteVencimientoISO = limiteVencimiento.toISOString();

  const procesarCliente = async (cliente: ClienteEnRiesgo) => {
    // ── Bifurcación estricta por SALDO TOTAL (requisito #2 de la spec) ──────
    const esGrupoA = cliente.saldo_actual >= MINIMO_REDENCION;
    const faltantes = esGrupoA ? null : MINIMO_REDENCION - cliente.saldo_actual;

    const { titulo, mensaje } = esGrupoA
      ? construirMensajeGrupoA(cliente.nombre, cliente.total_por_vencer)
      : construirMensajeGrupoB(cliente.nombre, cliente.total_por_vencer, faltantes!);

    if (!cliente.token_dispositivo) {
      registros.push({
        cliente_id: cliente.cliente_id,
        tipo: "sin_token",
        titulo: null,
        contenido: null,
        estado_envio: "sin_token",
      });
      return;
    }

    const tipo = esGrupoA ? "alerta_vencimiento_apto" : "alerta_vencimiento_incentivo";

    try {
      const resultado = await enviarPushFCM(
        accessToken,
        projectId,
        cliente.token_dispositivo,
        titulo,
        mensaje,
      );

      registros.push({
        cliente_id: cliente.cliente_id,
        tipo,
        titulo,
        contenido: mensaje,
        estado_envio: resultado.ok ? "exitoso" : "fallido",
      });

      if (resultado.ok) {
        // Marca notificados SOLO los lotes que quedaron dentro del rango que
        // se acaba de procesar para este cliente (idempotencia).
        const { error: errUpdate } = await supabase
          .from("transacciones_puntos")
          .update({ notificado_vencimiento: true })
          .eq("cliente_id", cliente.cliente_id)
          .gt("puntos_restantes", 0)
          .eq("notificado_vencimiento", false)
          .gte("fecha_vencimiento", ahoraISO)
          .lte("fecha_vencimiento", limiteVencimientoISO);

        if (errUpdate) {
          console.error(`Error marcando lotes notificados de ${cliente.cliente_id}:`, errUpdate);
        }
      }
    } catch (err) {
      registros.push({
        cliente_id: cliente.cliente_id,
        tipo,
        titulo,
        contenido: mensaje,
        estado_envio: "fallido",
      });
      console.error(`Error enviando push a ${cliente.cliente_id}:`, err);
    }
  };

  for (let i = 0; i < clientes.length; i += LOTE_ENVIO) {
    const tanda = clientes.slice(i, i + LOTE_ENVIO) as ClienteEnRiesgo[];
    await Promise.allSettled(tanda.map(procesarCliente));
  }

  const { error: errorAuditoria } = await supabase
    .from("historial_notificaciones")
    .insert(registros);
  if (errorAuditoria) {
    console.error("Error guardando historial_notificaciones:", errorAuditoria);
  }

  const resumen = {
    ok: true,
    total: clientes.length,
    grupo_a: registros.filter((r) => r.tipo === "alerta_vencimiento_apto").length,
    grupo_b: registros.filter((r) => r.tipo === "alerta_vencimiento_incentivo").length,
    exitosos: registros.filter((r) => r.estado_envio === "exitoso").length,
    fallidos: registros.filter((r) => r.estado_envio === "fallido").length,
    sin_token: registros.filter((r) => r.estado_envio === "sin_token").length,
  };

  return new Response(JSON.stringify(resumen), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
