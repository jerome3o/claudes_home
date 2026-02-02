// Orchestrator state
export type OrchestratorState = 'idle' | 'running';

// Status response from get_status
export interface KernelStatus {
  state: OrchestratorState;
  sessionId?: string;
  uptime: number;
}

// Events emitted by the orchestrator
export interface OrchestratorEvents {
  text: (text: string) => void;
  tool_use: (tool: { id: string; name: string; input: unknown }) => void;
  tool_result: (result: { id: string; content: unknown }) => void;
  result: (result: string) => void;
  error: (error: Error) => void;
  stateChange: (state: OrchestratorState) => void;
}

// Restart options
export interface RestartOptions {
  resume?: boolean;
  message?: string;
}

// Discord channel types
export type ChannelType = 'chat' | 'verbose' | 'text' | 'screenshots';
