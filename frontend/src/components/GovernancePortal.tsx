import React, { useState } from 'react';

export type VotingMode = 'TokenWeighted' | 'Quadratic';
export type ProposalStatus = 'Active' | 'Approved' | 'Rejected' | 'Queued' | 'Executed';

export interface DaoProposal {
  id: number;
  title: string;
  description: string;
  proposer: string;
  parameterKey: string;
  parameterValue: number;
  treasuryAmount: number;
  treasuryRecipient?: string;
  votesFor: number;
  votesAgainst: number;
  votingMode: VotingMode;
  executionEta?: string;
  status: ProposalStatus;
}

const INITIAL_PROPOSALS: DaoProposal[] = [
  {
    id: 1,
    title: 'SIP-01: Adjust Solar Feed-in Tariff Rate',
    description: 'Update grid feed-in reward multiplier from 1.10x to 1.25x during peak demand hours.',
    proposer: 'GD7X...9K2A',
    parameterKey: 'FEED_IN_RATE',
    parameterValue: 125,
    treasuryAmount: 0,
    votesFor: 1420,
    votesAgainst: 310,
    votingMode: 'Quadratic',
    executionEta: '2026-10-18T12:00:00Z',
    status: 'Active',
  },
  {
    id: 2,
    title: 'SIP-02: Community Microgrid Battery Grant',
    description: 'Allocate 25,000 SOLAR from DAO Treasury to fund reserve storage nodes.',
    proposer: 'GA4M...3P8Q',
    parameterKey: 'GRANT_ALLOC',
    parameterValue: 1,
    treasuryAmount: 25000,
    treasuryRecipient: 'GB9R...7L1W',
    votesFor: 2890,
    votesAgainst: 420,
    votingMode: 'TokenWeighted',
    executionEta: '2026-10-17T08:00:00Z',
    status: 'Queued',
  },
];

export const GovernancePortal: React.FC = () => {
  const [proposals, setProposals] = useState<DaoProposal[]>(INITIAL_PROPOSALS);
  const [userTokens, setUserTokens] = useState<number>(400);
  const [treasuryBalance, setTreasuryBalance] = useState<number>(150000);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [parameterKey, setParameterKey] = useState('GRID_FEE_BPS');
  const [parameterValue, setParameterValue] = useState<number>(50);
  const [treasuryAmount, setTreasuryAmount] = useState<number>(0);
  const [votingMode, setVotingMode] = useState<VotingMode>('Quadratic');
  const [tokenCommit, setTokenCommit] = useState<number>(100);

  const computeVotingPower = (tokens: number, mode: VotingMode) => {
    if (mode === 'Quadratic') {
      return Math.floor(Math.sqrt(Math.max(0, tokens)));
    }
    return tokens;
  };

  const handleCreateProposal = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const next: DaoProposal = {
      id: proposals.length + 1,
      title,
      description,
      proposer: 'GUSER...DAO1',
      parameterKey,
      parameterValue,
      treasuryAmount,
      votesFor: 0,
      votesAgainst: 0,
      votingMode,
      status: 'Active',
    };
    setProposals([next, ...proposals]);
    setTitle('');
    setDescription('');
  };

  const handleVote = (id: number, support: boolean) => {
    setProposals((prev) =>
      prev.map((p) => {
        if (p.id !== id || p.status !== 'Active') return p;
        const weight = computeVotingPower(tokenCommit, p.votingMode);
        return {
          ...p,
          votesFor: support ? p.votesFor + weight : p.votesFor,
          votesAgainst: !support ? p.votesAgainst + weight : p.votesAgainst,
        };
      })
    );
  };

  const handleExecute = (id: number) => {
    setProposals((prev) =>
      prev.map((p) => {
        if (p.id !== id || p.status !== 'Queued') return p;
        if (p.treasuryAmount > 0) {
          setTreasuryBalance((b) => Math.max(0, b - p.treasuryAmount));
        }
        return { ...p, status: 'Executed' };
      })
    );
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <header className="flex flex-wrap justify-between items-center border-b pb-4">
        <div>
          <h1 className="text-2xl font-bold">Stellar Solar Grid DAO Governance</h1>
          <p className="text-sm text-gray-600">
            Decentralized parameter governance, quadratic voting, and time-locked treasury management
          </p>
        </div>
        <div className="flex gap-4 mt-2 sm:mt-0">
          <div className="bg-amber-50 border border-amber-200 rounded px-4 py-2">
            <span className="text-xs uppercase text-amber-700 block">Your Governance Balance</span>
            <span className="text-lg font-semibold">{userTokens} sGOV</span>
          </div>
          <div className="bg-emerald-50 border border-emerald-200 rounded px-4 py-2">
            <span className="text-xs uppercase text-emerald-700 block">DAO Treasury</span>
            <span className="text-lg font-semibold">{treasuryBalance.toLocaleString()} SOLAR</span>
          </div>
        </div>
      </header>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <form onSubmit={handleCreateProposal} className="border rounded-lg p-4 space-y-3 bg-white shadow-sm">
          <h2 className="text-lg font-semibold">Create Proposal</h2>
          <div>
            <label className="block text-xs font-medium">Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="SIP-03: Upgrade Grid Parameter"
              className="w-full border rounded px-2 py-1 text-sm"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Rationale and technical impact..."
              className="w-full border rounded px-2 py-1 text-sm"
              rows={3}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium">Parameter Key</label>
              <input
                value={parameterKey}
                onChange={(e) => setParameterKey(e.target.value)}
                className="w-full border rounded px-2 py-1 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium">Target Value</label>
              <input
                type="number"
                value={parameterValue}
                onChange={(e) => setParameterValue(Number(e.target.value))}
                className="w-full border rounded px-2 py-1 text-sm"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium">Treasury Request</label>
              <input
                type="number"
                value={treasuryAmount}
                onChange={(e) => setTreasuryAmount(Number(e.target.value))}
                className="w-full border rounded px-2 py-1 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium">Voting Mechanism</label>
              <select
                value={votingMode}
                onChange={(e) => setVotingMode(e.target.value as VotingMode)}
                className="w-full border rounded px-2 py-1 text-sm"
              >
                <option value="Quadratic">Quadratic Voting</option>
                <option value="TokenWeighted">Token-Weighted</option>
              </select>
            </div>
          </div>
          <button
            type="submit"
            className="w-full bg-blue-600 text-white rounded py-2 text-sm font-medium hover:bg-blue-700"
          >
            Submit Proposal
          </button>
        </form>

        <div className="md:col-span-2 space-y-4">
          <div className="flex items-center justify-between bg-gray-50 p-3 rounded border">
            <span className="text-sm font-medium">Tokens to commit per vote:</span>
            <input
              type="number"
              min={1}
              max={userTokens}
              value={tokenCommit}
              onChange={(e) => setTokenCommit(Number(e.target.value))}
              className="border rounded px-2 py-1 text-sm w-28"
            />
            <span className="text-xs text-gray-500">
              Quadratic Power: {computeVotingPower(tokenCommit, 'Quadratic')} votes | Weighted: {tokenCommit} votes
            </span>
          </div>

          {proposals.map((prop) => (
            <div key={prop.id} className="border rounded-lg p-4 bg-white shadow-sm space-y-2">
              <div className="flex justify-between items-start">
                <div>
                  <span className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-800 mr-2">
                    {prop.votingMode}
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-800">
                    {prop.status}
                  </span>
                  <h3 className="text-base font-bold mt-1">{prop.title}</h3>
                </div>
                <span className="text-xs text-gray-500">Proposer: {prop.proposer}</span>
              </div>
              <p className="text-sm text-gray-700">{prop.description}</p>
              <div className="text-xs text-gray-600 flex flex-wrap gap-4">
                <span>
                  Parameter: <strong>{prop.parameterKey} = {prop.parameterValue}</strong>
                </span>
                {prop.treasuryAmount > 0 && (
                  <span>
                    Treasury Request: <strong>{prop.treasuryAmount.toLocaleString()} SOLAR</strong>
                  </span>
                )}
                {prop.executionEta && <span>Timelock ETA: {prop.executionEta}</span>}
              </div>

              <div className="flex items-center justify-between pt-2 border-t">
                <div className="text-xs space-x-4">
                  <span className="text-green-700 font-semibold">For: {prop.votesFor}</span>
                  <span className="text-red-700 font-semibold">Against: {prop.votesAgainst}</span>
                </div>
                <div className="space-x-2">
                  {prop.status === 'Active' && (
                    <>
                      <button
                        onClick={() => handleVote(prop.id, true)}
                        className="px-3 py-1 bg-green-600 text-white rounded text-xs"
                      >
                        Vote For
                      </button>
                      <button
                        onClick={() => handleVote(prop.id, false)}
                        className="px-3 py-1 bg-red-600 text-white rounded text-xs"
                      >
                        Vote Against
                      </button>
                    </>
                  )}
                  {prop.status === 'Queued' && (
                    <button
                      onClick={() => handleExecute(prop.id)}
                      className="px-3 py-1 bg-indigo-600 text-white rounded text-xs"
                    >
                      Execute Timelocked Proposal
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};

export default GovernancePortal;
