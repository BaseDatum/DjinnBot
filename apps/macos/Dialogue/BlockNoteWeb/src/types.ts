// Type declarations for the Swift ↔ JS bridge

declare global {
  interface Window {
    /** API key injected by Swift from Keychain (in-memory only) */
    AI_API_KEY?: string;

    /** AI endpoint URL, defaults to OpenAI-compatible */
    AI_ENDPOINT?: string;

    /** Editor instance exposed for Swift to call methods */
    blocknoteEditor?: any;

    /** Called by Swift to load a document's blocks */
    loadDocument?: (blocks: any[]) => void;

    /** Called by Swift to set the editor theme */
    setTheme?: (theme: "light" | "dark") => void;

    /** Called by Swift to dispatch a streamed AI chunk */
    dispatchAIChunk?: (data: {
      requestId: string;
      chunk: string;
      done: boolean;
    }) => void;

    /** Called by Swift to dispatch an AI error */
    dispatchAIError?: (data: { requestId: string; error: string }) => void;

    /** WebKit message handler bridge */
    webkit?: {
      messageHandlers?: {
        editorBridge?: {
          postMessage: (msg: BridgeMessage) => void;
        };
      };
    };
  }
}

/** Messages sent from JS to Swift */
export type BridgeMessage =
  | { type: "ready" }
  | { type: "contentChange"; blocksJSON: string; title?: string }
  | { type: "titleChange"; title: string }
  | {
      type: "aiRequest";
      requestId: string;
      messages: string;
      options: string;
    };

export {};
