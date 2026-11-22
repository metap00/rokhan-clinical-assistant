// Lessons routes. The resident pulls lessons; reading, quiz and progress work without the model.
import { getLessons } from '../lessons/index.mjs';

export default function register(app) {
  const svc = (c) => getLessons(c.config);

  app.get('/api/lecturi', async (c) => svc(c).status());
  // registered before /api/lecturi/:id, and the :id handler also answers it, whatever order the router matches in
  app.get('/api/lecturi/recap', async (c) => svc(c).recap());
  app.get('/api/lecturi/repetitie', async (c) => svc(c).review());
  app.get('/api/lecturi/:id', async (c) => (c.params.id === 'recap' ? svc(c).recap() : c.params.id === 'repetitie' ? svc(c).review() : svc(c).get(c.params.id)));

  // Spaced review. pauza before :id, and the :id handlers answer it too, whatever order the router matches in.
  const pause = (c) => svc(c).reviewPause(c.body?.zile);
  app.post('/api/lecturi/repetitie/pauza', pause);
  app.post('/api/lecturi/repetitie/:id', async (c) => (c.params.id === 'pauza' ? pause(c) : svc(c).reviewAnswer(c.params.id, c.body?.stiut)));
  app.post('/api/lecturi/repetitie/:id/semnaleaza', async (c) => svc(c).reviewFlag(c.params.id));

  app.post('/api/lecturi/ordine', async (c) => svc(c).setNextGuide(c.body?.ghid));
  app.post('/api/lecturi/:id/citita', async (c) => svc(c).markRead(c.params.id, { quiz: c.body?.quiz }));
  app.post('/api/lecturi/:id/sari', async (c) => svc(c).skip(c.params.id));

  // 200 when the lesson exists, else 202: the writer job picks the unit up (server/jobs, nextMissing)
  app.post('/api/lecturi/:id/genereaza', async (c) => {
    const r = svc(c).requestGenerate(c.params.id);
    c.res.writeHead(r.status === 'scrisa' ? 200 : 202, { 'content-type': 'application/json; charset=utf-8' });
    c.res.end(JSON.stringify(r));
  });
}
