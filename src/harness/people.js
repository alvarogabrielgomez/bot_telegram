// Registry of everyone who has sent a directed message: people.json, keyed by
// Telegram id. The prompt lists who is in a chat from here, so a name can be
// matched to an id.

const FILE = "people.json";

export function createPeople({ store, now = () => new Date() }) {
  const readAll = () => store.readJson(FILE, {});

  return {
    // Every field the person carries is refreshed, so renames show up on the next message.
    async upsert(person, chatId) {
      const iso = now().toISOString();
      await store.updateJson(FILE, {}, (all) => {
        const prev = all[person.id];
        all[person.id] = {
          id: person.id,
          firstName: person.firstName,
          lastName: person.lastName,
          username: person.username,
          displayName: person.displayName,
          chats: { ...prev?.chats, [chatId]: iso },
          firstSeen: prev?.firstSeen ?? iso,
          lastSeen: iso,
        };
        return all;
      });
    },

    async get(id) {
      return (await readAll())[id] ?? null;
    },

    // Newest activity in `chatId` first.
    async inChat(chatId) {
      const key = String(chatId);
      return Object.values(await readAll())
        .filter((rec) => rec.chats?.[key])
        .sort((a, b) => (a.chats[key] < b.chats[key] ? 1 : a.chats[key] > b.chats[key] ? -1 : 0));
    },
  };
}
