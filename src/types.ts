// Stream JSON event types from claude -p --output-format stream-json

export interface StreamEvent {
  type: "system" | "assistant" | "user" | "result";
  subtype?: string;
  session_id?: string;
  message?: StreamMessage;
  result?: StreamResult;
  // System events
  tool_use_id?: string;
  content_type?: string;
}

export interface StreamMessage {
  role: "assistant" | "user";
  content: ContentBlock[];
  model?: string;
  stop_reason?: string;
  usage?: TokenUsage;
}

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | ContentBlock[];
  is_error?: boolean;
}

export interface StreamResult {
  session_id: string;
  cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  is_error?: boolean;
  total_cost_usd?: number;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface TodoItem {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  description?: string;
}

export interface ChannelSession {
  channelId: string;
  channelName: string;
  sessionId: string | null;
  projectDir: string;
  systemPrompt: string;
  lastActivity: number;
  todoItems: TodoItem[];
}

export interface ChannelConfig {
  id: string;
  name: string;
  projectDir: string;
  systemPrompt: string;
  streaming: boolean; // show live updates or just final result
  model: string; // claude model (opus, sonnet, haiku)
  maxTurns: number; // 0 = unlimited
  compactThreshold: number; // compact memory after N messages
}
