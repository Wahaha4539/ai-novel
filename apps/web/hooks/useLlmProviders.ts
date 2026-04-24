/**
 * useLlmProviders — Hook for LLM Provider CRUD, routing, and connectivity testing.
 *
 * Provides:
 * - Provider list with auto-loading
 * - Create / Update / Delete provider
 * - Test connectivity
 * - Step routing read/write
 */
'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  LlmProvider,
  LlmRoutingEntry,
  ConnectivityResult,
  CreateLlmProviderInput,
  UpdateLlmProviderInput,
  SetRoutingInput,
} from '../types/llm-provider';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3001/api';

type LlmConfigSnapshot = {
  providers: LlmProvider[];
  routings: LlmRoutingEntry[];
};

let cachedSnapshot: LlmConfigSnapshot | null = null;
let pendingSnapshotLoad: Promise<LlmConfigSnapshot> | null = null;

/** Generic fetch helper with error handling */
async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `请求失败: ${response.status}`);
  }

  return (await response.json()) as T;
}

/**
 * Load provider/routing data once per browser session.
 * Mutating actions force-refresh this snapshot; normal mounts reuse it to avoid repeated config reads.
 */
async function loadSnapshot(force = false): Promise<LlmConfigSnapshot> {
  if (!force && cachedSnapshot) return cachedSnapshot;
  if (!force && pendingSnapshotLoad) return pendingSnapshotLoad;

  pendingSnapshotLoad = Promise.all([
    apiFetch<LlmProvider[]>('/llm-providers'),
    apiFetch<LlmRoutingEntry[]>('/llm-routing'),
  ]).then(([providers, routings]) => ({ providers, routings }));

  try {
    cachedSnapshot = await pendingSnapshotLoad;
    return cachedSnapshot;
  } finally {
    pendingSnapshotLoad = null;
  }
}

export function useLlmProviders() {
  // ── State ──
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [routings, setRoutings] = useState<LlmRoutingEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  /** Per-provider connectivity test state */
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ConnectivityResult | null>(null);

  // ── Load providers + routings ──
  const reload = useCallback(async (force = false) => {
    setLoading(true);
    setError('');
    try {
      const snapshot = await loadSnapshot(force);
      setProviders(snapshot.providers);
      setRoutings(snapshot.routings);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-load on mount
  useEffect(() => {
    reload();
  }, [reload]);

  // ── Provider CRUD ──

  const createProvider = useCallback(async (input: CreateLlmProviderInput) => {
    const created = await apiFetch<LlmProvider>('/llm-providers', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    await reload(true);
    return created;
  }, [reload]);

  const updateProvider = useCallback(async (id: string, input: UpdateLlmProviderInput) => {
    const updated = await apiFetch<LlmProvider>(`/llm-providers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
    await reload(true);
    return updated;
  }, [reload]);

  const deleteProvider = useCallback(async (id: string) => {
    await apiFetch(`/llm-providers/${id}`, { method: 'DELETE' });
    await reload(true);
  }, [reload]);

  // ── Connectivity test ──

  const testConnectivity = useCallback(async (id: string) => {
    setTestingId(id);
    setTestResult(null);
    try {
      const result = await apiFetch<ConnectivityResult>(`/llm-providers/${id}/test`, {
        method: 'POST',
      });
      setTestResult(result);
      return result;
    } catch (e) {
      const failResult: ConnectivityResult = {
        success: false,
        error: e instanceof Error ? e.message : '测试失败',
      };
      setTestResult(failResult);
      return failResult;
    } finally {
      setTestingId(null);
    }
  }, []);

  // ── Step routing ──

  const setRouting = useCallback(async (appStep: string, input: SetRoutingInput) => {
    await apiFetch(`/llm-routing/${appStep}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
    await reload(true);
  }, [reload]);

  const deleteRouting = useCallback(async (appStep: string) => {
    await apiFetch(`/llm-routing/${appStep}`, { method: 'DELETE' });
    await reload(true);
  }, [reload]);

  return {
    providers,
    routings,
    loading,
    error,
    testingId,
    testResult,
    reload,
    createProvider,
    updateProvider,
    deleteProvider,
    testConnectivity,
    setRouting,
    deleteRouting,
  };
}
