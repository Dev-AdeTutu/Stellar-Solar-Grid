/**
 * Multi-signature wallet signature collection (#872).
 *
 * The network is replaced by an in-memory chain adapter; signatures are real
 * ed25519 signatures produced with Stellar keypairs, and the payload
 * derivation is cross-checked against the Stellar SDK's own authorizeEntry.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import * as StellarSdk from "@stellar/stellar-sdk";

const mocks = vi.hoisted(() => {
  process.env.ADMIN_API_KEY = "test-admin-key";
  process.env.MULTISIG_DB_PATH = ":memory:";
  process.env.MULTISIG_SIGNATURE_TTL_LEDGERS = "100";
  return { sendEmail: vi.fn() };
});

vi.mock("../src/lib/mailer", () => ({ sendEmail: mocks.sendEmail }));

import {
  buildAuthPreimage,
  buildSignatureScVal,
  decodeSignature,
  resetMultisigForTests,
  type MultisigChain,
} from "../src/lib/multisig";
import { createMultisigRouter } from "../src/routes/multisig";

const NETWORK = StellarSdk.Networks.TESTNET;
const ADMIN_KEY = "test-admin-key";
const GRID = StellarSdk.StrKey.encodeContract(crypto.randomBytes(32));
const WALLET = StellarSdk.StrKey.encodeContract(crypto.randomBytes(32));
const [ALICE, BOB, CAROL] = [StellarSdk.Keypair.random(), StellarSdk.Keypair.random(), StellarSdk.Keypair.random()];
const OUTSIDER = StellarSdk.Keypair.random();

/** Unsigned auth entry for `address` invoking fn(args) on the grid contract. */
function unsignedEntry(address: string, fn: string, args: StellarSdk.xdr.ScVal[]) {
  return new StellarSdk.xdr.SorobanAuthorizationEntry({
    credentials: StellarSdk.xdr.SorobanCredentials.sorobanCredentialsAddress(
      new StellarSdk.xdr.SorobanAddressCredentials({
        address: new StellarSdk.Address(address).toScAddress(),
        nonce: new StellarSdk.xdr.Int64(42),
        signatureExpirationLedger: 0,
        signature: StellarSdk.xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new StellarSdk.xdr.SorobanAuthorizedInvocation({
      function: StellarSdk.xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new StellarSdk.xdr.InvokeContractArgs({
          contractAddress: new StellarSdk.Address(GRID).toScAddress(),
          functionName: fn,
          args,
        }),
      ),
      subInvocations: [],
    }),
  });
}

class FakeChain implements MultisigChain {
  networkPassphrase = NETWORK;
  ledger = 1_000;
  submitted: Array<{ fn: string; args: StellarSdk.xdr.ScVal[]; auth: StellarSdk.xdr.SorobanAuthorizationEntry[] }> = [];
  failSubmit = false;
  async getWalletConfig(wallet: string) {
    if (wallet !== WALLET) throw new Error("not a wallet");
    return { signers: [ALICE.publicKey(), BOB.publicKey(), CAROL.publicKey()], threshold: 2 };
  }
  async prepareAuthorization(input: { wallet: string; fn: string; args: StellarSdk.xdr.ScVal[] }) {
    return { entry: unsignedEntry(input.wallet, input.fn, input.args), latestLedger: this.ledger };
  }
  async latestLedger() {
    return this.ledger;
  }
  async submit(input: { fn: string; args: StellarSdk.xdr.ScVal[]; auth: StellarSdk.xdr.SorobanAuthorizationEntry[] }) {
    if (this.failSubmit) throw new Error("tx_failed");
    this.submitted.push(input);
    return "tx-hash-1";
  }
}

describe("multisig helpers", () => {
  it("derives the same payload that Stellar signers sign for an auth entry", async () => {
    // For a plain G-account, the SDK's authorizeEntry signs exactly the
    // payload our preimage derivation produces.
    const entry = unsignedEntry(ALICE.publicKey(), "set_emergency_contact", [StellarSdk.xdr.ScVal.scvVoid()]);
    const { payload } = buildAuthPreimage(entry, 5_000, NETWORK);
    const signed = await StellarSdk.authorizeEntry(entry, ALICE, 5_000, NETWORK);
    const sigMap = StellarSdk.scValToNative(signed.credentials().address().signature()) as Array<{ signature: Buffer }>;
    expect(ALICE.verify(payload, Buffer.from(sigMap[0].signature))).toBe(true);
  });

  it("stores the expiration ledger in the entry and preimage", () => {
    const entry = unsignedEntry(WALLET, "transfer_meter", []);
    const { entry: updated, preimageXdr } = buildAuthPreimage(entry, 1_234, NETWORK);
    expect(updated.credentials().address().signatureExpirationLedger()).toBe(1_234);
    expect(entry.credentials().address().signatureExpirationLedger()).toBe(0); // input untouched
    const preimage = StellarSdk.xdr.HashIdPreimage.fromXDR(preimageXdr, "base64");
    expect(preimage.sorobanAuthorization().signatureExpirationLedger()).toBe(1_234);
  });

  it("orders signatures by raw public key as __check_auth requires", () => {
    const sig = Buffer.alloc(64, 1);
    const val = buildSignatureScVal([ALICE, BOB, CAROL].map((k) => ({ publicKey: k.publicKey(), signature: sig })));
    const keys = (StellarSdk.scValToNative(val) as Array<{ public_key: Buffer }>).map((s) => Buffer.from(s.public_key));
    const sorted = [...keys].sort(Buffer.compare);
    expect(keys).toEqual(sorted);
    expect(keys).toHaveLength(3);
  });

  it("accepts hex and base64 signatures and rejects other lengths", () => {
    const raw = crypto.randomBytes(64);
    expect(decodeSignature(raw.toString("hex"))).toEqual(raw);
    expect(decodeSignature(raw.toString("base64"))).toEqual(raw);
    expect(() => decodeSignature(crypto.randomBytes(32).toString("base64"))).toThrow(/64 bytes/);
  });
});

describe("multisig routes", () => {
  let server: Server;
  let base: string;
  let chain: FakeChain;

  beforeAll(async () => {
    chain = new FakeChain();
    const app = express();
    app.use(express.json());
    app.use("/api/multisig", createMultisigRouter(chain, GRID));
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message });
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/multisig`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    resetMultisigForTests();
    mocks.sendEmail.mockReset().mockResolvedValue({ delivered: true, provider: "test" });
    chain.ledger = 1_000;
    chain.submitted = [];
    chain.failSubmit = false;
  });

  const post = (path: string, body: unknown, admin = false) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(admin ? { "X-Admin-Key": ADMIN_KEY } : {}) },
      body: JSON.stringify(body),
    });

  async function registerWallet() {
    const res = await post(
      "/wallets",
      {
        address: WALLET,
        name: "Acme Solar Co-op",
        signers: [
          { publicKey: ALICE.publicKey(), email: "alice@example.com", label: "Treasurer" },
          { publicKey: BOB.publicKey(), email: "bob@example.com" },
        ],
      },
      true,
    );
    expect(res.status).toBe(201);
    return res.json();
  }

  async function propose() {
    const res = await post(`/wallets/${WALLET}/proposals`, {
      action: "make_payment",
      params: { meterId: "ORG-1", amount: "5000000", plan: "Monthly" },
      proposer: ALICE.publicKey(),
    });
    expect(res.status).toBe(201);
    return (await res.json()).proposal;
  }

  const signFor = (kp: StellarSdk.Keypair, payloadHex: string, encoding: "hex" | "base64" = "hex") =>
    kp.sign(Buffer.from(payloadHex, "hex")).toString(encoding);

  it("registers a wallet from its on-chain signer set without exposing emails", async () => {
    const { wallet } = await registerWallet();
    expect(wallet.threshold).toBe(2);
    expect(wallet.signers).toEqual([
      { publicKey: ALICE.publicKey(), label: "Treasurer", notifications: true },
      { publicKey: BOB.publicKey(), label: null, notifications: true },
      { publicKey: CAROL.publicKey(), label: null, notifications: false },
    ]);
    const res = await fetch(`${base}/wallets/${WALLET}`);
    expect(JSON.stringify(await res.json())).not.toContain("@example.com");
  });

  it("requires the admin key and on-chain signers to register", async () => {
    expect((await post("/wallets", { address: WALLET, name: "x" })).status).toBe(401);
    const res = await post(
      "/wallets",
      { address: WALLET, name: "x", signers: [{ publicKey: OUTSIDER.publicKey() }] },
      true,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("UNKNOWN_SIGNER");
  });

  it("creates a proposal with the wallet as payer and emails pending signers", async () => {
    await registerWallet();
    const proposal = await propose();
    expect(proposal.status).toBe("pending");
    expect(proposal.threshold).toBe(2);
    expect(proposal.expirationLedger).toBe(1_100);
    expect(proposal.pendingSigners).toHaveLength(3);
    expect(proposal.payloadHex).toMatch(/^[0-9a-f]{64}$/);

    const args = proposal.argsXdr.map((a: string) => StellarSdk.xdr.ScVal.fromXDR(a, "base64"));
    expect(StellarSdk.scValToNative(args[0])).toBe("ORG-1");
    expect(StellarSdk.scValToNative(args[1])).toBe(WALLET);
    expect(StellarSdk.scValToNative(args[2])).toBe(5_000_000n);
    expect(StellarSdk.scValToNative(args[3])).toEqual(["Monthly"]);

    // Carol has no email on file, so only Alice and Bob are notified.
    const recipients = mocks.sendEmail.mock.calls.map(([m]) => m.to).sort();
    expect(recipients).toEqual(["alice@example.com", "bob@example.com"]);
    expect(mocks.sendEmail.mock.calls[0][0].subject).toContain("Signature requested");
    expect(mocks.sendEmail.mock.calls[0][0].text).toContain(`proposal=${proposal.id}`);
  });

  it("collects signatures up to the threshold and submits them sorted", async () => {
    await registerWallet();
    const proposal = await propose();
    mocks.sendEmail.mockClear();

    // SEP-43 wallets return base64 signatures; SDK signers return hex.
    let res = await post(`/proposals/${proposal.id}/signatures`, {
      publicKey: CAROL.publicKey(),
      signature: signFor(CAROL, proposal.payloadHex, "base64"),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).proposal.status).toBe("pending");
    expect(mocks.sendEmail).not.toHaveBeenCalled();

    expect((await post(`/proposals/${proposal.id}/submit`, {})).status).toBe(409);

    res = await post(`/proposals/${proposal.id}/signatures`, {
      publicKey: ALICE.publicKey(),
      signature: signFor(ALICE, proposal.payloadHex),
    });
    const ready = (await res.json()).proposal;
    expect(ready.status).toBe("ready");
    expect(ready.signedBy.sort()).toEqual([ALICE.publicKey(), CAROL.publicKey()].sort());
    expect(ready.pendingSigners).toEqual([BOB.publicKey()]);
    expect(mocks.sendEmail.mock.calls.every(([m]) => m.subject.includes("Ready to submit"))).toBe(true);

    res = await post(`/proposals/${proposal.id}/submit`, {});
    expect(res.status).toBe(200);
    const submitted = (await res.json()).proposal;
    expect(submitted.status).toBe("submitted");
    expect(submitted.txHash).toBe("tx-hash-1");

    const [call] = chain.submitted;
    expect(call.fn).toBe("make_payment");
    const creds = call.auth[0].credentials().address();
    expect(creds.signatureExpirationLedger()).toBe(1_100);
    const sigs = StellarSdk.scValToNative(creds.signature()) as Array<{ public_key: Buffer; signature: Buffer }>;
    expect(sigs).toHaveLength(2);
    expect(Buffer.compare(Buffer.from(sigs[0].public_key), Buffer.from(sigs[1].public_key))).toBe(-1);
    const payload = Buffer.from(proposal.payloadHex, "hex");
    for (const s of sigs) {
      const kp = StellarSdk.Keypair.fromPublicKey(StellarSdk.StrKey.encodeEd25519PublicKey(Buffer.from(s.public_key)));
      expect(kp.verify(payload, Buffer.from(s.signature))).toBe(true);
    }
  });

  it("rejects outsiders, duplicates and signatures over the wrong payload", async () => {
    await registerWallet();
    const proposal = await propose();

    let res = await post(`/proposals/${proposal.id}/signatures`, {
      publicKey: OUTSIDER.publicKey(),
      signature: signFor(OUTSIDER, proposal.payloadHex),
    });
    expect(res.status).toBe(403);

    res = await post(`/proposals/${proposal.id}/signatures`, {
      publicKey: BOB.publicKey(),
      signature: signFor(BOB, crypto.randomBytes(32).toString("hex")),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_SIGNATURE");

    // A signer cannot use someone else's signature either.
    res = await post(`/proposals/${proposal.id}/signatures`, {
      publicKey: BOB.publicKey(),
      signature: signFor(ALICE, proposal.payloadHex),
    });
    expect(res.status).toBe(400);

    const good = { publicKey: BOB.publicKey(), signature: signFor(BOB, proposal.payloadHex) };
    expect((await post(`/proposals/${proposal.id}/signatures`, good)).status).toBe(200);
    res = await post(`/proposals/${proposal.id}/signatures`, good);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("ALREADY_SIGNED");
  });

  it("expires proposals once the signature window has passed", async () => {
    await registerWallet();
    const proposal = await propose();
    chain.ledger = 1_101;
    const res = await post(`/proposals/${proposal.id}/signatures`, {
      publicKey: ALICE.publicKey(),
      signature: signFor(ALICE, proposal.payloadHex),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PROPOSAL_EXPIRED");
    const list = await (await fetch(`${base}/wallets/${WALLET}/proposals?status=expired`)).json();
    expect(list.proposals.map((p: { id: string }) => p.id)).toEqual([proposal.id]);
  });

  it("records failed submissions", async () => {
    await registerWallet();
    const proposal = await propose();
    for (const kp of [ALICE, BOB]) {
      await post(`/proposals/${proposal.id}/signatures`, { publicKey: kp.publicKey(), signature: signFor(kp, proposal.payloadHex) });
    }
    chain.failSubmit = true;
    const res = await post(`/proposals/${proposal.id}/submit`, {});
    expect(res.status).toBe(502);
    const failed = (await res.json()).proposal;
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("tx_failed");
  });

  it("lists pending proposals for a wallet", async () => {
    await registerWallet();
    const a = await propose();
    await post(`/wallets/${WALLET}/proposals`, {
      action: "set_emergency_contact",
      params: { meterId: "ORG-1", contact: null },
    });
    const res = await fetch(`${base}/wallets/${WALLET}/proposals?status=pending`);
    const { proposals } = await res.json();
    expect(proposals).toHaveLength(2);
    expect(proposals.map((p: { id: string }) => p.id)).toContain(a.id);
    expect((await fetch(`${base}/wallets/${WALLET}/proposals?status=bogus`)).status).toBe(400);
  });

  it("validates proposal requests", async () => {
    expect(
      (await post(`/wallets/${WALLET}/proposals`, { action: "make_payment", params: { meterId: "M", amount: "1", plan: "Daily" } })).status,
    ).toBe(404);
    await registerWallet();
    const cases = [
      { action: "drain_everything", params: {} },
      { action: "make_payment", params: { meterId: "M", amount: "-5", plan: "Daily" } },
      { action: "make_payment", params: { meterId: "M", amount: "5", plan: "Hourly" } },
      { action: "transfer_meter", params: { meterId: "M", newOwner: "nope" } },
    ];
    for (const body of cases) {
      expect((await post(`/wallets/${WALLET}/proposals`, body)).status).toBe(400);
    }
    const res = await post(`/wallets/${WALLET}/proposals`, {
      action: "transfer_meter",
      params: { meterId: "M", newOwner: OUTSIDER.publicKey() },
      proposer: OUTSIDER.publicKey(),
    });
    expect(res.status).toBe(403);
  });
});
