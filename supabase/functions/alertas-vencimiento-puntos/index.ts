import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import * as jose from "https://esm.sh/jose@4.15.4";

// Inicialización de constantes y variables de entorno de Supabase
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Configuración de Google Firebase Cloud Messaging (FCM v1)
const FIREBASE_PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID") ?? "";
const FIREBASE_CLIENT_EMAIL = Deno.env.get("FIREBASE_CLIENT_EMAIL") ?? "";
const FIREBASE_PRIVATE_KEY = (Deno.env.get("FIREBASE_PRIVATE_KEY") ?? "").replace(/\\n/g, "\n");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

interface ClienteNotificar {
  cliente_id: string;
  nombre: string;
  total_por_vencer: number;
  token_dispositivo: string | null;
}

/**
 * Genera un token de acceso OAuth2 para la API FCM v1 utilizando la llave privada de Firebase
 */
async function obtenerTokenAccesoFCM(): Promise<string> {
  const jwt = await new jose.SignJWT({
    iss: FIREBASE_CLIENT_EMAIL,
    sub: FIREBASE_CLIENT_EMAIL,
    aud: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/firebase.messaging",
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(await jose.importPKCS8(FIREBASE_PRIVATE_KEY, "RS256"));

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Error de autenticación OAuth2 de Firebase: ${errorText}`);
  }

  const data = await response.json();
  return data.access_token;
}

/**
 * Despacha la notificación Push mediante HTTP v1 a Google
 */
async function enviarPushFCM(
  accessToken: string,
  tokenDispositivo: string,
  titulo: string,
  cuerpo: string
): Promise<boolean> {
  const url = `https://fcm.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/messages:send`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        token: tokenDispositivo,
        notification: {
          title: titulo,
          body: cuerpo,
        },
        android: {
          priority: "high",
          notification: {
            sound: "default",
          },
        },
      },
    }),
  });

  return response.ok;
}

serve(async (req) => {
  // Manejo de solicitudes pre-vuelo para CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  try {
    // 1. Obtener Token de Acceso para Google Firebase
    const fcmToken = await obtenerTokenAccesoFCM();

    // 2. Invocar la función RPC que calcula los puntos por vencer
    const { data: clientesAfectados, error: rpcError } = await supabase.rpc(
      "fn_clientes_puntos_por_vencer"
    );

    if (rpcError) throw rpcError;

    const resultados = {
      notificados_apto: 0,
      notificados_incentivo: 0,
      sin_token: 0,
      errores: 0,
    };

    const logsAuditoria = [];

    // 3. Procesamiento y segmentación de cada cliente
    for (const cliente of (clientesAfectados as ClienteNotificar[])) {
      const { cliente_id, nombre, total_por_vencer, token_dispositivo } = cliente;

      // Caso C: Cliente no tiene token configurado en su celular
      if (!token_dispositivo) {
        resultados.sin_token++;
        logsAuditoria.push({
          cliente_id,
          tipo: "sin_token",
          titulo: "Sin acción",
          contenido: `Cliente ${nombre} tiene ${total_por_vencer} pts por vencer pero no cuenta con token registrado.`,
          estado_envio: "sin_token",
        });
        continue;
      }

      let titulo = "";
      let cuerpo = "";
      let tipoNotificacion = "";

      // Segmentación Coherente con Reglas de Negocio
      if (total_por_vencer >= 15000) {
        // GRUPO A: Puede redimir directamente (Mínimo de 15,000 pts cumplido)
        tipoNotificacion = "alerta_vencimiento_apto";
        titulo = "⏳ ¡Aprovecha tus puntos antes de que venzan!";
        cuerpo = `Hola ${nombre}, tienes ${total_por_vencer.toLocaleString()} puntos ($${total_por_vencer.toLocaleString()} COP) listos para usar que vencerán pronto. Recuerda que puedes pagar total o parcialmente tus consumos en el restaurante. ¡Ven hoy mismo y redímelos en caja!`;
      } else {
        // GRUPO B: No alcanza el mínimo de redención. Incentivo a la compra física.
        tipoNotificacion = "alerta_vencimiento_incentivo";
        const faltantes = 15000 - total_por_vencer;
        titulo = "💡 ¡Estás muy cerca de desbloquear tu descuento!";
        cuerpo = `Hola ${nombre}, tienes ${total_por_vencer.toLocaleString()} puntos acumulados próximos a vencer. Recuerda que al llegar a 15,000 puntos podrás usarlos como dinero real en el restaurante. ¡Te faltan solo ${faltantes.toLocaleString()} puntos! Visítanos este mes, acumula con tu visita y compra física, y salva tu saldo.`;
      }

      // 4. Enviar Push a través de Firebase
      const enviado = await enviarPushFCM(fcmToken, token_dispositivo, titulo, cuerpo);

      if (enviado) {
        if (total_por_vencer >= 15000) {
          resultados.notificados_apto++;
        } else {
          resultados.notificados_incentivo++;
        }

        // Registrar para actualizar la tabla de transacciones de puntos
        logsAuditoria.push({
          cliente_id,
          tipo: tipoNotificacion,
          titulo,
          contenido: cuerpo,
          estado_envio: "exitoso",
        });
      } else {
        resultados.errores++;
        logsAuditoria.push({
          cliente_id,
          tipo: tipoNotificacion,
          titulo,
          contenido: cuerpo,
          estado_envio: "fallido",
        });
      }
    }

    // 5. Inserción masiva de auditoría de notificaciones en la base de datos
    if (logsAuditoria.length > 0) {
      await supabase.from("historial_notificaciones").insert(
        logsAuditoria.map((log) => ({
          cliente_id: log.cliente_id,
          tipo: log.tipo,
          titulo: log.titulo,
          contenido: log.contenido,
          estado_envio: log.estado_envio,
        }))
      );

      // 6. Idempotencia: Marcar los lotes notificados como TRUE en la base de datos
      const exitososIds = logsAuditoria
        .filter((l) => l.estado_envio === "exitoso")
        .map((l) => l.cliente_id);

      if (exitososIds.length > 0) {
        await supabase
          .from("transacciones_puntos")
          .update({ notificado_vencimiento: true })
          .in("cliente_id", exitososIds)
          .eq("notificado_vencimiento", false)
          .lte("fecha_vencimiento", new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        resultados,
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message,
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
});
