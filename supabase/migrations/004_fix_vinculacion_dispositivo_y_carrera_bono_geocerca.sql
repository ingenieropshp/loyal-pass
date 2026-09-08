-- 004_fix_vinculacion_dispositivo_y_carrera_bono_geocerca.sql
--
-- Dos fixes independientes que juntos hacen que el bono de proximidad
-- (+200 pts) funcione de verdad y no se pueda pagar dos veces el mismo día.
--
-- ─────────────────────────────────────────────────────────────────────────
-- FIX 1 — El bono de proximidad NUNCA se acreditaba: RLS rechazaba el
--          upsert en `dispositivos_clientes`.
-- ─────────────────────────────────────────────────────────────────────────
-- `vincularDispositivo()` (src/services/supabaseClient.js) escribía la fila
-- (device_id, restaurante_id) → cliente_id con
-- `.upsert(..., { onConflict: 'device_id,restaurante_id' })`, que PostgREST
-- traduce a `INSERT ... ON CONFLICT DO UPDATE`.
--
-- La tabla tenía políticas RLS abiertas de INSERT y UPDATE, pero NINGUNA de
-- SELECT — y Postgres exige política de SELECT para `ON CONFLICT DO UPDATE`,
-- porque tiene que leer la fila en conflicto antes de decidir. Sin ella
-- aborta con "42501: new row violates row-level security policy", aunque el
-- INSERT simple equivalente sí pasaba. Verificado contra la base:
--     INSERT simple como authenticated              → OK
--     INSERT ... ON CONFLICT DO UPDATE (idéntico)   → 42501
--
-- Como `vincularDispositivo` es best-effort y solo hace console.warn, el
-- fallo era SILENCIOSO: el registro del cliente terminaba bien y nadie se
-- enteraba. Resultado medible antes de esta migración:
--   dispositivos_clientes .......................... 0 filas
--   eventos_geocerca ............................... 0 filas
--   transacciones_puntos tipo 'geocerca_entrada' ... 0 filas
--   geofence-webhook ............................... 404 cliente_no_resuelto
--
-- La corrección NO es abrir un SELECT público sobre la tabla (expondría el
-- mapa dispositivo→cliente de todos los comercios a cualquiera con la anon
-- key). Se mueve la escritura a una función SECURITY DEFINER, igual que ya
-- se hizo con `fn_registrar_referido`: el navegador deja de escribir la
-- tabla directamente y las políticas abiertas se eliminan.
create or replace function public.fn_vincular_dispositivo(
  p_device_id      text,
  p_restaurante_id uuid,
  p_cliente_id     uuid
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_auth_user_id uuid;
begin
  if p_device_id is null or btrim(p_device_id) = ''
     or p_restaurante_id is null or p_cliente_id is null then
    raise exception 'parámetros incompletos para vincular el dispositivo';
  end if;

  -- El cliente tiene que existir Y pertenecer a ESTA sede: la relación
  -- cliente↔restaurante es 1 fila por sede (multi-tenant), así que vincular
  -- un cliente de otra sede sería siempre un bug o un intento de fraude.
  select auth_user_id into v_auth_user_id
  from clientes
  where id = p_cliente_id
    and restaurante_id = p_restaurante_id;

  if not found then
    raise exception 'el cliente % no pertenece al restaurante %', p_cliente_id, p_restaurante_id;
  end if;

  -- Antes, con las políticas abiertas, cualquiera con la anon key podía
  -- apuntar el device_id de otra persona a su propio cliente_id (o al revés)
  -- y cosechar los bonos de proximidad ajenos. Acá el dueño de la cuenta es
  -- lo único que se acepta: `registrarClienteEnRestaurante` solo se llama
  -- con sesión iniciada (RegistrationForm exige user.id), así que esto no
  -- cierra ningún flujo legítimo.
  if auth.uid() is null or v_auth_user_id is distinct from auth.uid() then
    raise exception 'solo el dueño de la cuenta puede vincular su dispositivo';
  end if;

  -- Mismo upsert de siempre, pero acá corre como dueño de la tabla: RLS no
  -- aplica y el ON CONFLICT ya no necesita política de SELECT.
  insert into dispositivos_clientes (device_id, restaurante_id, cliente_id, actualizado_en)
  values (btrim(p_device_id), p_restaurante_id, p_cliente_id, now())
  on conflict (device_id, restaurante_id) do update
    set cliente_id     = excluded.cliente_id,
        actualizado_en = now();
end;
$function$;

revoke all     on function public.fn_vincular_dispositivo(text, uuid, uuid) from public, anon;
grant  execute on function public.fn_vincular_dispositivo(text, uuid, uuid) to authenticated;

-- Ya no hay ningún escritor directo de esta tabla desde el navegador (el
-- único era `vincularDispositivo`, que ahora llama al RPC de arriba), así
-- que estas dos políticas `true`/`true` solo dejan el hueco abierto.
-- geofence-webhook lee con service_role, que salta RLS.
drop policy if exists dispositivos_clientes_upsert on public.dispositivos_clientes;
drop policy if exists dispositivos_clientes_update on public.dispositivos_clientes;

-- ─────────────────────────────────────────────────────────────────────────
-- FIX 2 — Carrera: el "máximo 1 bono por día" se podía saltar con dos
--          eventos simultáneos.
-- ─────────────────────────────────────────────────────────────────────────
-- fn_evento_geocerca comprueba "¿ya bonificado hoy?" con un SELECT y recién
-- después inserta, sin bloqueo ni restricción única en el medio. Dos
-- llamadas concurrentes pueden pasar ambas la comprobación y acreditar 400
-- pts. No es teórico: SuccessCard (manejarRegistro.jsx) dispara su propio
-- evento de entrada a propósito, además del que dispara la geocerca nativa
-- del sistema operativo — es justo el escenario de dos POST casi
-- simultáneos con el mismo cliente y restaurante.
--
-- El índice único parcial es la garantía real (la base la impone aunque
-- haya dos transacciones en paralelo). Solo cubre las entradas BONIFICADAS:
-- las entradas sin bono y las salidas se pueden repetir libremente, que es
-- lo que se necesita para el historial.
create unique index if not exists uniq_geo_bono_dia
  on public.eventos_geocerca (cliente_id, restaurante_id, fn_fecha_local(creado_en))
  where tipo = 'entrada' and bonificado;

-- Con el índice puesto, el perdedor de la carrera abortaría con
-- unique_violation y el webhook devolvería un 500 confuso. Se envuelven los
-- efectos del bono en un bloque con EXCEPTION: al capturar la violación,
-- Postgres revierte la subtransacción completa — incluyendo el INSERT en
-- transacciones_puntos y en visitas — así que el resultado es exactamente
-- el que ya se buscaba ("hoy ya se le pagó, no se duplica"), pero con una
-- respuesta limpia en vez de un error.
--
-- El resto de la función queda IGUAL que en la migración 003.
CREATE OR REPLACE FUNCTION public.fn_evento_geocerca(p_cliente_id uuid, p_restaurante_id uuid, p_tipo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_ya_bonificado boolean;
  v_bono          integer := 0;
  v_evento_id     uuid;
begin
  -- Solo se aceptan estos dos tipos de evento: 'entrada' (llegó a la
  -- geocerca) o 'salida' (la abandonó). Cualquier otro valor es un bug de
  -- quien llama a esta función (Edge Function / cliente) y se corta acá.
  if p_tipo not in ('entrada', 'salida') then
    raise exception 'tipo de evento inválido: %', p_tipo;
  end if;

  -- 'salida' nunca da puntos: solo se deja registrado el evento (para que
  -- el próximo 'entrada' del mismo día no cuente como "seguía adentro").
  if p_tipo = 'salida' then
    insert into eventos_geocerca (cliente_id, restaurante_id, tipo)
    values (p_cliente_id, p_restaurante_id, 'salida')
    returning id into v_evento_id;
    return jsonb_build_object('ok', true, 'evento_id', v_evento_id, 'bonificado', false);
  end if;

  -- Antifraude #1: si ya se le dio el bono de proximidad HOY (fecha local)
  -- para este restaurante, no se repite aunque vuelva a entrar varias veces
  -- en el mismo día. Esta comprobación sigue siendo la vía normal (evita
  -- trabajo inútil); el índice único uniq_geo_bono_dia es la red de
  -- seguridad para el caso de dos llamadas concurrentes.
  select exists (
    select 1 from eventos_geocerca
    where cliente_id = p_cliente_id
      and restaurante_id = p_restaurante_id
      and tipo = 'entrada'
      and bonificado = true
      and fn_fecha_local(creado_en) = fn_fecha_local(now())
  ) into v_ya_bonificado;

  begin
    -- Antifraude #2 (fn_redimio_hoy): si el cliente ya redimió puntos hoy en
    -- caja, no se le da el bono de proximidad — evita el caso de alguien
    -- redimiendo y "recargando" de inmediato solo por quedarse cerca.
    if not v_ya_bonificado and not fn_redimio_hoy(p_cliente_id) then
      v_bono := fn_bono_geocerca_entrada(p_restaurante_id);

      -- Único lugar que otorga puntos: se inserta en el ledger con tipo
      -- 'geocerca_entrada'. El trigger centralizado
      -- (fn_actualizar_saldo_cliente_por_transaccion) es quien suma esto a
      -- clientes.saldo_puntos — por eso YA NO hay un UPDATE manual acá abajo
      -- (ver migración 003: esa línea vieja además apuntaba a una columna
      -- que ya no existe).
      insert into transacciones_puntos
        (cliente_id, restaurante_id, tipo, puntos, puntos_restantes, fecha_vencimiento)
      values
        (p_cliente_id, p_restaurante_id, 'geocerca_entrada', v_bono, v_bono, fn_calcular_vencimiento(now()));

      insert into visitas (cliente_id, restaurante_id, origen)
      values (p_cliente_id, p_restaurante_id, 'gps');
    end if;

    -- Se deja registrado el evento de entrada SIEMPRE (haya dado bono o no),
    -- para que la próxima verificación de "¿ya bonificado hoy?" de arriba
    -- funcione, y para tener el historial completo de entradas.
    insert into eventos_geocerca (cliente_id, restaurante_id, tipo, bonificado)
    values (p_cliente_id, p_restaurante_id, 'entrada', v_bono > 0)
    returning id into v_evento_id;

  exception when unique_violation then
    -- Otra llamada en paralelo ganó la carrera y ya pagó el bono de hoy.
    -- Este bloque revierte TODO lo de arriba (puntos, visita y evento), que
    -- es justo lo que corresponde: el bono ya quedó acreditado una vez.
    return jsonb_build_object(
      'ok', true, 'bonificado', false, 'puntos', 0, 'motivo', 'bono_ya_otorgado_hoy'
    );
  end;

  return jsonb_build_object('ok', true, 'evento_id', v_evento_id, 'bonificado', v_bono > 0, 'puntos', v_bono);
end;
$function$;
