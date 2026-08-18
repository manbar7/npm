import Fastify, { type FastifyInstance } from "fastify";
import { LedgerService } from "./ledger-service.js";
import { Store } from "./store.js";
import { AppError } from "./types.js";

export interface BuildOptions {
  authorizedShares?: number;
  logger?: boolean;
}

export interface App {
  server: FastifyInstance;
  store: Store;
  service: LedgerService;
}

export function buildApp(options: BuildOptions = {}): App {
  const store = new Store();
  store.seedCompany(options.authorizedShares ?? 10_000_000);

  const service = new LedgerService(store);
  const server = Fastify({ logger: options.logger ?? false });

  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply
        .status(error.statusCode)
        .send({ code: error.code, message: error.message });
    }
    server.log.error(error);
    const message = error instanceof Error ? error.message : "unexpected error";
    return reply.status(500).send({ code: "INTERNAL", message });
  });

  server.post("/accounts", async (request, reply) => {
    const body = request.body as { holderName?: string };
    const account = await service.createAccount(body?.holderName ?? "unnamed");
    return reply.status(201).send(account);
  });

  server.post("/ledger/issue", async (request, reply) => {
    const body = request.body as {
      accountId: string;
      shares: number;
      idempotencyKey: string;
    };
    const result = await service.issueShares({
      accountId: body.accountId,
      shares: body.shares,
      idempotencyKey: body.idempotencyKey,
    });
    return reply.status(201).send(result);
  });

  server.post("/ledger/transfer", async (request, reply) => {
    const body = request.body as {
      fromAccountId: string;
      toAccountId: string;
      shares: number;
      idempotencyKey: string;
    };
    const result = await service.transferShares({
      fromAccountId: body.fromAccountId,
      toAccountId: body.toAccountId,
      shares: body.shares,
      idempotencyKey: body.idempotencyKey,
    });
    return reply.status(201).send(result);
  });

  server.get("/accounts/:id/balance", async (request) => {
    const { id } = request.params as { id: string };
    const balance = await service.getBalance(id);
    return { accountId: id, balance };
  });

  server.get("/accounts/:id/ledger", async (request) => {
    const { id } = request.params as { id: string };
    const { limit } = request.query as { limit?: string };
    const entries = await service.getLedger(id, limit ? Number(limit) : 50);
    return { accountId: id, entries };
  });

  server.get("/accounts/:id/state", async (request) => {
    const { id } = request.params as { id: string };
    const { limit } = request.query as { limit?: string };
    const state = await service.getAccountState(id, limit ? Number(limit) : 50);
    return { accountId: id, ...state };
  });

  server.get("/company/summary", async () => {
    return service.getCompanySummary();
  });

  server.get("/health", async () => ({ status: "ok" }));

  return { server, store, service };
}
