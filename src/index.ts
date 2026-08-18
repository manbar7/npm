import { buildApp } from './server.js';

const port = Number(process.env.PORT ?? 3000);
const { server } = buildApp({ logger: true, authorizedShares: 10_000_000 });

server.listen({ port, host: '0.0.0.0' }).catch((error) => {
  server.log.error(error);
  process.exit(1);
});
