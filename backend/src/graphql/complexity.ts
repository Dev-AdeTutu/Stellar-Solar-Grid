/**
 * GraphQL query depth and complexity limits (#898).
 *
 * Cost model: every field costs 1 plus the cost of its children. For fields
 * returning a list, the child cost is multiplied by the requested page size
 * (`pageSize` / `limit` / `days` argument, capped at 100) or by
 * DEFAULT_LIST_SIZE when no size argument is given. Fields hitting the chain
 * or an external API cost extra (EXPENSIVE_FIELDS). Introspection fields
 * (`__schema`, `__type`, `__typename`) are free so the playground works.
 */
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLInterfaceType,
  Kind,
  getNamedType,
  isListType,
  isNonNullType,
  type DocumentNode,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type ValueNode,
  type GraphQLOutputType,
} from "graphql";

export const MAX_DEPTH = Number(process.env.GRAPHQL_MAX_DEPTH ?? 8);
export const MAX_COMPLEXITY = Number(process.env.GRAPHQL_MAX_COMPLEXITY ?? 1000);
const DEFAULT_LIST_SIZE = 10;
const MAX_LIST_SIZE = 100;
const SIZE_ARGS = ["pageSize", "limit", "days", "first"];

/** Extra cost for fields that call the Stellar RPC or a third-party API. */
const EXPENSIVE_FIELDS: Record<string, number> = {
  meter: 5,
  metersByOwner: 10,
  balance: 2,
  payments: 10,
  prediction: 3,
  weather: 5,
  stakingStats: 5,
  staker: 5,
  votingPower: 3,
  rest: 10,
};

export class QueryLimitError extends Error {
  constructor(message: string, public readonly code: "DEPTH_LIMIT" | "COMPLEXITY_LIMIT") {
    super(message);
  }
}

export type QueryCost = { depth: number; complexity: number };

function argValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case Kind.INT:
    case Kind.FLOAT:
      return Number(node.value);
    case Kind.VARIABLE:
      return variables[node.name.value];
    default:
      return undefined;
  }
}

function unwrap(type: GraphQLOutputType): GraphQLOutputType {
  return isNonNullType(type) ? (type.ofType as GraphQLOutputType) : type;
}

export function analyzeQuery(
  schema: GraphQLSchema,
  document: DocumentNode,
  operationName?: string | null,
  variables: Record<string, unknown> = {},
): QueryCost {
  const fragments = new Map<string, FragmentDefinitionNode>();
  const operations: OperationDefinitionNode[] = [];
  for (const def of document.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
    if (def.kind === Kind.OPERATION_DEFINITION) operations.push(def);
  }
  const op = operationName
    ? operations.find((o) => o.name?.value === operationName)
    : operations[0];
  if (!op) return { depth: 0, complexity: 0 };

  const root =
    op.operation === "mutation"
      ? schema.getMutationType()
      : op.operation === "subscription"
      ? schema.getSubscriptionType()
      : schema.getQueryType();
  if (!root) return { depth: 0, complexity: 0 };

  let maxDepth = 0;

  const walk = (
    set: SelectionSetNode,
    parent: GraphQLObjectType | GraphQLInterfaceType,
    depth: number,
    seen: Set<string>,
  ): number => {
    maxDepth = Math.max(maxDepth, depth);
    if (depth > MAX_DEPTH) {
      throw new QueryLimitError(`Query depth exceeds limit of ${MAX_DEPTH}`, "DEPTH_LIMIT");
    }
    let cost = 0;
    for (const sel of set.selections) {
      if (sel.kind === Kind.FIELD) {
        const name = sel.name.value;
        if (name.startsWith("__")) continue;
        const field = parent.getFields()[name];
        if (!field) continue; // validation already rejected unknown fields
        let fieldCost = 1 + (EXPENSIVE_FIELDS[name] ?? 0);
        if (sel.selectionSet) {
          const named = getNamedType(field.type);
          if (named instanceof GraphQLObjectType || named instanceof GraphQLInterfaceType) {
            let child = walk(sel.selectionSet, named, depth + 1, seen);
            if (isListType(unwrap(field.type))) {
              const sizeArg = sel.arguments?.find((a) => SIZE_ARGS.includes(a.name.value));
              const size = sizeArg ? Number(argValue(sizeArg.value, variables)) : NaN;
              child *= Number.isFinite(size) && size > 0 ? Math.min(size, MAX_LIST_SIZE) : DEFAULT_LIST_SIZE;
            }
            fieldCost += child;
          }
        }
        cost += fieldCost;
      } else if (sel.kind === Kind.INLINE_FRAGMENT) {
        const cond = sel.typeCondition ? schema.getType(sel.typeCondition.name.value) : parent;
        if (cond instanceof GraphQLObjectType || cond instanceof GraphQLInterfaceType) {
          cost += walk(sel.selectionSet, cond, depth, seen);
        }
      } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
        const name = sel.name.value;
        const frag = fragments.get(name);
        if (!frag || seen.has(name)) continue; // cycles are rejected by validation
        const cond = schema.getType(frag.typeCondition.name.value);
        if (cond instanceof GraphQLObjectType || cond instanceof GraphQLInterfaceType) {
          cost += walk(frag.selectionSet, cond, depth, new Set(seen).add(name));
        }
      }
    }
    return cost;
  };

  const complexity = walk(op.selectionSet, root, 1, new Set());
  if (complexity > MAX_COMPLEXITY) {
    throw new QueryLimitError(
      `Query complexity ${complexity} exceeds limit of ${MAX_COMPLEXITY}`,
      "COMPLEXITY_LIMIT",
    );
  }
  return { depth: maxDepth, complexity };
}
