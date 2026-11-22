import { getRegistru } from '../store/registru.mjs';

export default function register(app) {
  const registru = getRegistru(app.config);

  app.get('/api/registru', async () => registru.summary());
  app.post('/api/registru/entries', async (c) => {
    const entry = registru.addEntry(c.body ?? {});
    return { entry, registru: registru.summary() };
  });
  app.patch('/api/registru/entries/:id', async (c) => {
    registru.updateEntry(c.params.id, c.body ?? {});
    return { registru: registru.summary() };
  });
  app.delete('/api/registru/entries/:id', async (c) => {
    registru.deleteEntry(c.params.id);
    return { registru: registru.summary() };
  });
  app.post('/api/registru/rows', async (c) => {
    const row = registru.addRow(c.body ?? {});
    return { row, registru: registru.summary() };
  });
  app.get('/api/registru/export', async (c) => ({ text: registru.exportText({ from: c.query.from, to: c.query.to }) }));
}
