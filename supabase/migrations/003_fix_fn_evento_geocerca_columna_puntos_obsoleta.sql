-- 003_fix_fn_evento_geocerca_columna_puntos_obsoleta.sql
--
-- BUG REAL ENCONTRADO (no el que se sospechaba originalmente en
-- RegistrationForm.jsx): fn_evento_geocerca() hacía un UPDATE directo sobre
-- `clientes.puntos`, pero esa columna ya no existe en la tabla `clientes`
-- (el saldo vigente es `clientes.saldo_puntos`; la columna vieja `puntos`
-- fue eliminada de la tabla en algún momento y esta función quedó
-- desactualizada). Como el UPDATE fallaba con
-- "column puntos does not exist", TODA la función se revertía (Postgres
-- deshace los efectos de una función que termina en excepción) — es decir,
-- cada vez que un cliente entraba de verdad a la geocerca y correspondía
-- el bono de +200, la llamada completa fallaba silenciosamente y ni
-- siquiera quedaba la fila en el ledger (`transacciones_puntos`) ni en
-- `eventos_geocerca`. Esto rompía la proximidad para TODA la app, no solo
-- para clientes recién registrados.
--
-- La corrección es simplemente ELIMINAR ese UPDATE manual: el trigger
-- `trg_actualizar_saldo_cliente_por_transaccion` (AFTER INSERT en
-- transacciones_puntos) ya suma `NEW.puntos` a `clientes.saldo_puntos` de
-- forma centralizada apenas se inserta la fila de tipo 'geocerca_entrada'
-- unas líneas más abajo — exactamente el mismo patrón que ya se usó para
-- arreglar este mismo tipo de doble conteo en fn_bono_bienvenida() (ver el
-- comentario de esa función en la base de datos).
--
-- El resto de la función queda IGUAL: solo se agregan comentarios línea a
-- línea y se quita la línea rota.
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
  -- en el mismo día.
  select exists (
    select 1 from eventos_geocerca
    where cliente_id = p_cliente_id
      and restaurante_id = p_restaurante_id
      and tipo = 'entrada'
      and bonificado = true
      and fn_fecha_local(creado_en) = fn_fecha_local(now())
  ) into v_ya_bonificado;

  -- Antifraude #2 (fn_redimio_hoy): si el cliente ya redimió puntos hoy en
  -- caja, no se le da el bono de proximidad — evita el caso de alguien
  -- redimiendo y "recargando" de inmediato solo por quedarse cerca.
  if not v_ya_bonificado and not fn_redimio_hoy(p_cliente_id) then
    v_bono := fn_bono_geocerca_entrada(p_restaurante_id);

    -- Único lugar que otorga puntos: se inserta en el ledger con tipo
    -- 'geocerca_entrada'. El trigger centralizado
    -- (fn_actualizar_saldo_cliente_por_transaccion) es quien suma esto a
    -- clientes.saldo_puntos — por eso YA NO hay un UPDATE manual acá abajo
    -- (ver el comentario largo arriba de esta función: esa línea vieja
    -- además apuntaba a una columna que ya no existe).
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

  return jsonb_build_object('ok', true, 'evento_id', v_evento_id, 'bonificado', v_bono > 0, 'puntos', v_bono);
end;
$function$;
