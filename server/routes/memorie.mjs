import { getMemorie } from '../store/memorie.mjs';

export default function register(app) {
  const memorie = getMemorie(app.config);

  app.get('/api/memorie', async () => memorie.list());
  app.get('/api/memorie/:pagina', async (c) => memorie.read(c.params.pagina));
  app.put('/api/memorie/:pagina', async (c) => memorie.write(c.params.pagina, c.body?.markdown));
}
