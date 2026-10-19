import { env } from "@/lib/env";

export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

export interface GraphQLMeter {
  id: string;
  owner: string;
  active: boolean;
  unitsUsed: number;
  plan: string;
  lastPayment: string;
  expiresAt: string;
  dailyLimit?: number | null;
  daySpent?: number | null;
  balance?: string | null;
  payments?: GraphQLPayment[];
}

export interface GraphQLPayment {
  txHash: string;
  address: string;
  meterId?: string | null;
  amountXlm?: number | null;
  plan?: string | null;
  status: string;
  confirmedAt: string;
  date?: string | null;
  memo?: string | null;
}

/**
 * Executes a GraphQL query against the backend /graphql endpoint.
 */
export async function graphqlRequest<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const backendUrl = env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";
  const endpoint = `${backendUrl}/graphql`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`GraphQL request failed with HTTP ${res.status}: ${res.statusText}`);
  }

  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors && json.errors.length > 0) {
    throw new Error(json.errors[0].message);
  }
  if (!json.data) {
    throw new Error("No data returned from GraphQL query");
  }

  return json.data;
}

export const GET_METER_QUERY = `
  query GetMeter($id: String!) {
    meter(id: $id) {
      id
      owner
      active
      unitsUsed
      plan
      lastPayment
      expiresAt
      dailyLimit
      daySpent
      balance
      payments {
        txHash
        amountXlm
        plan
        status
        confirmedAt
      }
    }
  }
`;

export const GET_METERS_BY_OWNER_QUERY = `
  query GetMetersByOwner($address: String!) {
    metersByOwner(address: $address) {
      id
      owner
      active
      unitsUsed
      plan
      lastPayment
      expiresAt
      dailyLimit
      daySpent
      balance
    }
  }
`;

export const GET_PAYMENTS_QUERY = `
  query GetPayments($meterId: String!) {
    payments(meterId: $meterId) {
      txHash
      address
      meterId
      amountXlm
      plan
      status
      confirmedAt
      date
    }
  }
`;

export async function fetchMeterGraphQL(id: string): Promise<GraphQLMeter | null> {
  const result = await graphqlRequest<{ meter: GraphQLMeter | null }>(GET_METER_QUERY, { id });
  return result.meter;
}

export async function fetchMetersByOwnerGraphQL(address: string): Promise<GraphQLMeter[]> {
  const result = await graphqlRequest<{ metersByOwner: GraphQLMeter[] }>(GET_METERS_BY_OWNER_QUERY, {
    address,
  });
  return result.metersByOwner;
}

export async function fetchPaymentsGraphQL(meterId: string): Promise<GraphQLPayment[]> {
  const result = await graphqlRequest<{ payments: GraphQLPayment[] }>(GET_PAYMENTS_QUERY, {
    meterId,
  });
  return result.payments;
}
