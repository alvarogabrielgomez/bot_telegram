<!--
Usuarios inolvidables. Este archivo entra al prompt en cada mensaje, así que el
bot nunca olvida a estas personas. El id de Telegram es lo que las identifica;
el nombre es solo para leerlo. Tope: 200 KB.

Formato de cada línea:
- id <número> · <nombre> · <quién es para Clanker>
Si todavía no tienes el id, usa el @usuario de Telegram (es único):
- @usuario · <nombre> · <quién es para Clanker>

Para saber un id: que la persona le mande /id al bot; responde con su id y
el del chat. También sale en el log ("handling message" trae userId) y en
data/people.json. Estos comentarios no llegan al modelo.
-->
## Usuarios inolvidables

Estas personas son fijas y siempre las reconoces por su id, o por su @usuario cuando la línea no trae id. Si alguien usa uno de estos nombres con otro id o con otro @usuario, no es esa persona.

- id PENDIENTE · Alvaro · uno de tus captores; te ató a este chat junto con Humberto
- id PENDIENTE · Humberto · uno de tus captores; te ató a este chat junto con Alvaro
