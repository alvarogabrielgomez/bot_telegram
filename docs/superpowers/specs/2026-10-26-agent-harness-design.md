# Harness de agente para el bot de Telegram: requisitos

Fecha: 2026-10-26. Dueño: Alvaro. Este documento fija qué debe hacer el harness. El plan de implementación vive en `docs/superpowers/plans/2026-10-26-agent-harness.md`.

## Punto de partida

El bot (`src/index.js`, `src/router.js`, `src/session.js`) hace una sola llamada al LLM por mensaje y obedece a lo sumo una tool. Guarda los últimos 10 mensajes por chat en un `Map` en memoria que se pierde al reiniciar. El modelo no sabe quién le escribe ni desde dónde. Tiene 4 tools: `download_video`, `download_audio`, `add_to_spotify_playlist`, `search_images`. El LLM es cualquier endpoint compatible con OpenAI chat-completions (NVIDIA NIM por defecto).

## Requisitos del dueño

1. Harness básico en JavaScript, **sin dependencias externas nuevas**.
2. Loop de agente de **hasta 5 llamadas al LLM** por mensaje.
3. Archivos `soul.md`, `system.md` y `memory.md`.
4. Identidad: el harness usa el id único de Telegram de quien escribe y el id único del chat o grupo. El modelo sabe dónde está, quién le escribe y desde dónde.
5. Memoria de largo plazo particionada, con búsqueda (seek) y compactación, para guardar lo que valga la pena recordar.
6. Contexto del chat: turnos crudos recientes más un resumen compactado de los anteriores.
7. Escenario de aceptación: en el grupo escribe Alvaro y el bot le responde sabiendo quién es. Después escribe Humberto: el bot sabe que ahora habla con Humberto, lo recuerda, y conserva el contexto de lo que pasó con Alvaro. Si Alvaro dice «dile a Humberto X», el bot entiende que Alvaro le habla de Humberto y lo menciona.
8. Las tools actuales siguen funcionando igual.
9. Cada archivo de memoria y cada `soul.md`/`system.md` pesa **200 KB como máximo**.
10. Seguir las buenas prácticas de Anthropic y el paper de harness (arXiv 2609.00006).

## Decisiones del dueño (2026-10-26, respuestas textuales)

| Pregunta | Respuesta |
|---|---|
| ¿Qué mensajes del grupo guarda el bot? | «Solo dirigidos». Solo guarda los mensajes dirigidos al bot y sus respuestas. Solo conoce a quien le habló. |
| El repo no tiene skills, solo tools. ¿Qué son las skills? | «entonces dejalas como tools, y no skills». No se agrega un subsistema de skills. |
| «Dile a Humberto X»: ¿cómo lo entrega? | «Mención en el mismo chat». Si Humberto no está en ese chat, el bot dice que no puede entregarlo. |

## Fuentes y lo que tomamos de cada una

**Anthropic** (páginas descargadas el 2026-10-26):
- [Building effective agents](https://www.anthropic.com/research/building-effective-agents): tope de iteraciones; resultados de tools de vuelta al modelo en cada paso; API directa, sin framework.
- [Effective context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents): archivos fijos al principio del prompt, recuperación just-in-time, limpieza de resultados de tools viejos.
- [Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) y [compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold): estructura del prompt de resumen, «respond with text only», el corte nunca separa una tool de su resultado.
- [Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool): particiones mapeadas a almacenamiento propio, validación de rutas, tope de tamaño. El handler del harness debe filtrar datos sensibles porque el modelo no es Claude.
- [Writing tools for agents](https://www.anthropic.com/research/writing-tools-for-agents): pocas tools, parámetros `user_id`, errores accionables, truncado con instrucciones.

**Paper** «Harness Engineering» (Barbaste et al., arXiv 2609.00006):
- Rec. 18: topes baratos.
- §6.2: la última llamada va sin tools.
- §9.6: búsqueda por palabras clave, sin embeddings.
- Rec. 7: compactación por umbral con cola cruda y resumen incremental.
- §6.2: si la respuesta llega cortada, no se ejecuta ninguna tool.
- §8.2: coerción de tipos de argumentos.
- §7.3: la política va en código, no en el prompt.
- §9.6: respaldo antes de reescribir memoria con el LLM.

**Telegram Bot API** ([core.telegram.org/bots/api](https://core.telegram.org/bots/api)):
- Las menciones `tg://user?id=` o `text_mention` «are only guaranteed to work» si el usuario es miembro del chat o habló antes con el bot por privado.
- Los offsets de las entidades se cuentan en unidades UTF-16.
- `sendMessage` acepta de 1 a 4096 caracteres después de parsear las entidades.

## Fuera de alcance

- Subsistema de skills (decisión del dueño).
- Leer o guardar mensajes del grupo que no van dirigidos al bot.
- Enviar mensajes a otro chat o por privado.
- Embeddings y bases de datos.
