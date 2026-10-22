# Decentralized Governance DAO (`contracts/dao`)

## Overview

The Stellar Solar Grid Decentralized Autonomous Organization (DAO) replaces centralized single-admin control with community-driven governance over platform parameters, protocol upgrades, and DAO treasury allocations.

## Architecture & Core Features

1. **Governance Token (`sGOV`)**:
   - Grants holders the right to create proposals and vote on active governance measures.
   - Managed via `mint_governance_tokens` and `token_balance`.

2. **Proposal Lifecycle**:
   - **Creation (`create_proposal`)**: Any member holding `sGOV` tokens can propose changes to platform parameters (`parameter_key`, `parameter_value`) or request a treasury grant (`treasury_recipient`, `treasury_amount`).
   - **Voting (`cast_vote`)**: Supports both **Token-Weighted Voting** ($1 \text{ token} = 1 \text{ vote}$) and **Quadratic Voting** ($\text{weight} = \lfloor\sqrt{\text{tokens}}\rfloor$) to prevent whale dominance.
   - **Queueing (`queue_proposal`)**: Once the voting period concludes, proposals meeting `QuorumVotes` with a majority of `votes_for` transition to `Queued` with an enforced `execution_eta`.
   - **Time-Locked Execution (`execute_proposal`)**: Approved and queued proposals can only be executed after `TimelockDelay` seconds have elapsed, giving community members time to review upcoming changes.

3. **DAO Treasury Management**:
   - Community funds are held in the DAO treasury (`deposit_treasury`, `treasury_balance`) and can only be disbursed via executed governance proposals.

4. **Frontend Governance Portal**:
   - Located at `frontend/src/components/GovernancePortal.tsx`.
   - Allows users to view their governance balance, inspect treasury reserves, submit new proposals, choose between quadratic and token-weighted voting, and execute time-locked proposals.
