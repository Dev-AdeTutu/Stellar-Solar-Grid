import { Router } from "express";
import { buildSchema, graphql } from "graphql";
import {
  PersistedQueryCache,
  PersistedQueryError,
  type GraphQLRequest,
} from "../lib/apq.js";
import { getUsageHistory } from "../lib/usageEvents.js";
import { subscribeRealtime } from "../lib/realtime.js";

export const schema = buildSchema(`
  type UsageEvent {
    id: Int!
    meterId: String!
    units: Float!
    cost: String!
    receivedAt: String!
    transactionHash: String
  }

  type UsageHistory {
    events: [UsageEvent!]!
    page: Int!
    pageSize: Int!
    total: Int!
    hasMore: Boolean!
  }

  type MeterBalance { meterId: String!, balance: String!, updatedAt: String! }
  type MeterStatus { meterId: String!, status: String!, updatedAt: String! }
  type Payment { txHash: String!, address: String!, meterId: String, amountXlm: Float, status: String!, confirmedAt: String! }
  type UsageUpdate { meterId: String!, units: Float!, cost: String!, updatedAt: String! }
  type Subscription {
    meterBalanceChanged(meterId: String!): MeterBalance!
    meterStatusChanged(meterId: String!): MeterStatus!
    paymentConfirmed(address: String!): Payment!
    usageUpdated(meterId: String!): UsageUpdate!
  }
  type Query {
    health: String!
    usageHistory(meterId: String!, page: Int = 1, pageSize: Int = 20): UsageHistory!
  }
`);

const persistedQueries = new PersistedQueryCache();

export const rootValue = {
  health: () => "ok",
  usageHistory: ({ meterId, page = 1, pageSize = 20 }: { meterId: string; page?: number; pageSize?: number }) => {
    const safePage = Math.max(1, Math.trunc(page));
    const safePageSize = Math.min(100, Math.max(1, Math.trunc(pageSize)));
    const history = getUsageHistory(meterId, safePage, safePageSize);
    return {
      ...history,
      events: history.events.map((event) => ({
        id: event.id,
        meterId: event.meter_id,
        units: event.units,
        cost: event.cost,
        receivedAt: event.received_at,
        transactionHash: event.on_chain_tx_hash,
      })),
    };
  },
};

export const graphqlRouter = Router();

graphqlRouter.post("/", async (req, res) => {
  const request = (req.body ?? {}) as GraphQLRequest;
  try {
    const query = persistedQueries.resolve(request);
    const result = await graphql({
      schema,
      source: query,
      rootValue,
      variableValues: request.variables,
      operationName: request.operationName,
    });
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof PersistedQueryError) {
      return res.status(200).json({
        errors: [{ message: error.message, extensions: { code: error.code } }],
      });
    }
    const message = error instanceof Error ? error.message : "Invalid GraphQL request";
    return res.status(400).json({ errors: [{ message }] });
  }
});

export function clearPersistedQueriesForTests(): void {
  persistedQueries.clear();
}
