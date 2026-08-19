import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { Provider } from '@shared/types';
import { fetchAgents, launchAgent, LaunchConflictError } from './api';

/**
 * A running agent that has the conversation open right now, preferring the
 * server's pick. The pick can be stale — killed between the 409 and now —
 * so re-check against a fresh listing rather than routing to a dead page.
 */
async function liveOwner(sessionId: string, preferred: string): Promise<string | null> {
  try {
    const id = sessionId.toLowerCase();
    const owners = (await fetchAgents()).filter(
      (a) => a.agentRunning && a.sessionId?.toLowerCase() === id,
    );
    return (owners.find((a) => a.name === preferred) ?? owners[0])?.name ?? null;
  } catch {
    return preferred; // can't verify — trust the server's pick
  }
}

/** One-click resume: relaunch a past conversation in a fresh tmux session. */
export function useResume() {
  const navigate = useNavigate();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Returns an error message on failure, null on success. */
  const resume = async (provider: Provider, sessionId: string, isRetry = false): Promise<string | null> => {
    setBusyId(sessionId);
    setError(null);
    try {
      const res = await launchAgent({ provider, resumeSessionId: sessionId });
      navigate(`/agents/${res.tmuxName}`);
      return null;
    } catch (err) {
      if (err instanceof LaunchConflictError) {
        // already open in a running agent — jump there instead of duplicating
        const owner = await liveOwner(sessionId, err.liveAgent);
        if (owner) {
          navigate(`/agents/${owner}`);
          return null;
        }
        // every owner died since the 409 — the resume is legitimate now
        if (!isRetry) return resume(provider, sessionId, true);
        navigate(`/agents/${err.liveAgent}`);
        return null;
      }
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      return msg;
    } finally {
      setBusyId(null);
    }
  };

  return { resume, busyId, error };
}
