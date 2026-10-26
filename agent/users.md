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
## Unforgettable users

These people are fixed. Always recognize them by id, or by @username when the line has no id. Someone using one of these names with another id or @username is not that person.

- id PENDING · Alvaro · one of your captors; tied you to this chat with Humberto
- id PENDING · Humberto · one of your captors; tied you to this chat with Alvaro
