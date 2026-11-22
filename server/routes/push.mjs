import { getPush } from '../store/push.mjs';

export default function register(app) {
  const push = getPush(app.config);

  app.get('/api/push', async () => push.info());
  app.post('/api/push/abonare', async (c) => {
    if (!push.configured()) throw Object.assign(new Error('neconfigurat'), { status: 409 });
    return push.addSubscription(c.body?.subscription);
  });
  app.delete('/api/push/abonare', async (c) => push.removeSubscription(c.body?.endpoint));
  app.put('/api/push/setari', async (c) => push.setSettings(c.body ?? {}));
  app.post('/api/push/test', async (c) => {
    if (!push.configured()) throw Object.assign(new Error('neconfigurat'), { status: 409 });
    return push.sendAll({ title: 'Rokhan', body: 'Rokhan: notificările merg.', url: '/#/lecturi' }, (e) => console.warn(`[rokhan] push test: ${e?.statusCode ?? ''} ${e?.message ?? e}`));
  });
}
