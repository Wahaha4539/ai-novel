/** LLM Provider entity from the API */
export interface LlmProvider {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string;
  /** Masked API key (only first 4 + last 4 chars visible) */
  apiKey: string;
  defaultModel: string;
  extraConfig: Record<string, unknown>;
  isDefault: boolean;
  isActive: boolean;
  /** Which app steps are routed to this provider */
  routedSteps: string[];
  createdAt: string;
  updatedAt: string;
}

/** Connectivity test result */
export interface ConnectivityResult {
  success: boolean;
  error?: string;
  chatTests?: Array<{
    model: string;
    appSteps: string[];
    success: boolean;
    replyContent?: string;
    error?: string;
  }>;
}

/** Step routing entry */
export interface LlmRoutingEntry {
  appStep: 'guided' | 'generate' | 'polish';
  routing: {
    id: string;
    appStep: string;
    providerId: string;
    modelOverride?: string | null;
    paramsOverride: Record<string, unknown>;
    provider: {
      id: string;
      name: string;
      defaultModel: string;
      isActive: boolean;
    };
  } | null;
}

/** DTO for creating a provider */
export interface CreateLlmProviderInput {
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  isDefault?: boolean;
  extraConfig?: Record<string, unknown>;
}

/** DTO for updating a provider */
export interface UpdateLlmProviderInput {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  isDefault?: boolean;
  isActive?: boolean;
}

/** DTO for setting step routing */
export interface SetRoutingInput {
  providerId: string;
  modelOverride?: string;
}
