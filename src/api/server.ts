import express from 'express';

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  return app;
}

function main(): void {
  const port = Number(process.env.CONTINUUM_API_PORT ?? 4000);
  const app = createApp();
  app.listen(port, () => {
    console.log(`Continuum API listening on :${port}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
