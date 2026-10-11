import { createDiceDuoServer } from './app.js';

const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || '0.0.0.0';

const server = createDiceDuoServer();

server
  .listen(port, host)
  .then((boundPort) => {
    console.log(
      `[DICE DUO Server] Listening on http://${host}:${boundPort} (Supabase configured: ${server.persistence.isSupabaseConfigured()})`
    );
  })
  .catch((err) => {
    console.error('[DICE DUO Server] Failed to start:', err);
    process.exit(1);
  });
