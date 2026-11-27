// Reading checklist of the guideline library and "Continuă de unde ai rămas".
import { getCitit } from '../store/citit.mjs';

export default function register(app) {
  app.get('/api/citit', async (c) => getCitit(c.config).summary());
  app.put('/api/citit', async (c) => getCitit(c.config).setLast(c.body ?? {}));
  app.get('/api/citit/:nr', async (c) => getCitit(c.config).guide(c.params.nr));
  app.put('/api/citit/:nr', async (c) => getCitit(c.config).tick(c.params.nr, c.body ?? {}));
}
